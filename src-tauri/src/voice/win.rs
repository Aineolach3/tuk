//! Windows: «Тук Тук» и живой голос без интернета.
//!
//! - микрофон — waveIn (winmm), 16 кГц, моно, 16 бит — ровно то, что ждёт Vosk;
//! - распознавание — libvosk.dll (vosk-api 0.3.45), модель vosk-model-small-ru-0.22;
//! - голос — sherpa-onnx-c-api.dll (v1.13.8) и голоса vits-piper-ru, как на Android;
//! - звук — waveOut (winmm).
//!
//! Библиотеки лежат в ресурсах установщика (папка voice-libs, кладёт сборка в GitHub Actions)
//! и грузятся на лету: если их нет, Тук работает как раньше, просто без голоса.
//! Модели скачиваются по кнопке системными curl.exe и tar.exe (есть в Windows 10 и 11).
//! Функции Windows объявлены вручную по документированным C-сигнатурам, как в win32.rs.
//! Звук никуда не отправляется: он идёт из микрофона прямо в Vosk в этом процессе.

#![allow(non_snake_case)]

use super::ffi::*;
use super::logic::{self, Ev, Wake};
use super::Status;
use std::ffi::{c_char, c_void, CStr, CString, OsStr};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

// ---------------- Windows API ----------------

#[repr(C, packed(1))]
#[derive(Clone, Copy)]
struct WaveFormatEx {
    wFormatTag: u16,
    nChannels: u16,
    nSamplesPerSec: u32,
    nAvgBytesPerSec: u32,
    nBlockAlign: u16,
    wBitsPerSample: u16,
    cbSize: u16,
}

/// WAVEHDR. Все поля и так выровнены естественно (и на x64, и на x86),
/// поэтому обычный repr(C) совпадает с упакованной раскладкой mmeapi.h.
#[repr(C)]
struct WaveHdr {
    lpData: *mut u8,
    dwBufferLength: u32,
    dwBytesRecorded: u32,
    dwUser: usize,
    dwFlags: u32,
    dwLoops: u32,
    lpNext: *mut WaveHdr,
    reserved: usize,
}

const WAVE_MAPPER: u32 = 0xFFFF_FFFF;
const WAVE_FORMAT_PCM: u16 = 1;
const WHDR_DONE: u32 = 0x1;
const CALLBACK_NULL: u32 = 0;
const HDR: u32 = std::mem::size_of::<WaveHdr>() as u32;
const LOAD_WITH_ALTERED_SEARCH_PATH: u32 = 0x8;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[link(name = "winmm")]
extern "system" {
    fn waveInOpen(phwi: *mut isize, device: u32, fmt: *const WaveFormatEx, callback: usize, instance: usize, flags: u32) -> u32;
    fn waveInPrepareHeader(hwi: isize, hdr: *mut WaveHdr, size: u32) -> u32;
    fn waveInUnprepareHeader(hwi: isize, hdr: *mut WaveHdr, size: u32) -> u32;
    fn waveInAddBuffer(hwi: isize, hdr: *mut WaveHdr, size: u32) -> u32;
    fn waveInStart(hwi: isize) -> u32;
    fn waveInReset(hwi: isize) -> u32;
    fn waveInClose(hwi: isize) -> u32;
    fn waveOutOpen(phwo: *mut isize, device: u32, fmt: *const WaveFormatEx, callback: usize, instance: usize, flags: u32) -> u32;
    fn waveOutPrepareHeader(hwo: isize, hdr: *mut WaveHdr, size: u32) -> u32;
    fn waveOutUnprepareHeader(hwo: isize, hdr: *mut WaveHdr, size: u32) -> u32;
    fn waveOutWrite(hwo: isize, hdr: *mut WaveHdr, size: u32) -> u32;
    fn waveOutReset(hwo: isize) -> u32;
    fn waveOutClose(hwo: isize) -> u32;
}

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryExW(name: *const u16, file: isize, flags: u32) -> isize;
    fn GetProcAddress(module: isize, name: *const c_char) -> *const c_void;
    fn GetShortPathNameW(long: *const u16, short: *mut u16, len: u32) -> u32;
}

fn pcm_format(rate: u32) -> WaveFormatEx {
    WaveFormatEx { wFormatTag: WAVE_FORMAT_PCM, nChannels: 1, nSamplesPerSec: rate, nAvgBytesPerSec: rate * 2, nBlockAlign: 2, wBitsPerSample: 16, cbSize: 0 }
}

fn new_hdr(data: &mut [i16]) -> *mut WaveHdr {
    Box::into_raw(Box::new(WaveHdr {
        lpData: data.as_mut_ptr() as *mut u8,
        dwBufferLength: (data.len() * 2) as u32,
        dwBytesRecorded: 0,
        dwUser: 0,
        dwFlags: 0,
        dwLoops: 0,
        lpNext: std::ptr::null_mut(),
        reserved: 0,
    }))
}

/// Флаг WHDR_DONE ставит драйвер из своего потока — читаем без кеширования.
fn hdr_done(h: *mut WaveHdr) -> bool {
    unsafe { std::ptr::read_volatile(std::ptr::addr_of!((*h).dwFlags)) & WHDR_DONE != 0 }
}

fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(Some(0)).collect()
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    static T0: OnceLock<Instant> = OnceLock::new();
    T0.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// Vosk и espeak-ng открывают файлы «узкими» путями (кодовая страница ANSI),
/// поэтому путь с русскими буквами (C:\Users\Иван\…) заменяем коротким 8.3.
fn ascii_path(p: &Path) -> Result<CString, String> {
    let s = p.to_string_lossy().to_string();
    if s.is_ascii() {
        return CString::new(s).map_err(|e| e.to_string());
    }
    let w = wide(p.as_os_str());
    let mut buf = vec![0u16; 1024];
    let n = unsafe { GetShortPathNameW(w.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) } as usize;
    if n > 0 && n < buf.len() {
        let short = String::from_utf16_lossy(&buf[..n]);
        if short.is_ascii() {
            return CString::new(short).map_err(|e| e.to_string());
        }
    }
    Err(format!("Путь к модели содержит русские буквы, а короткие имена файлов в Windows выключены: {s}"))
}

// ---------------- Библиотеки ----------------

/// Где искать DLL: ресурсы установщика, рядом с Tuk.exe.
fn lib_path(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(r) = app.path().resource_dir() {
        dirs.push(r.join("voice-libs"));
        dirs.push(r);
    }
    if let Some(exe) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        dirs.push(exe.join("voice-libs"));
        dirs.push(exe);
    }
    dirs.into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

fn load_lib(app: &AppHandle, name: &str) -> Result<isize, String> {
    let p = lib_path(app, name).ok_or_else(|| format!("В этой сборке нет {name} — голос на ПК недоступен"))?;
    // зависимости (libstdc++, onnxruntime.dll) ищутся сначала в папке самой библиотеки
    let w = wide(p.as_os_str());
    let h = unsafe { LoadLibraryExW(w.as_ptr(), 0, LOAD_WITH_ALTERED_SEARCH_PATH) };
    if h == 0 {
        return Err(format!("Не удалось загрузить {name}: {}", std::io::Error::last_os_error()));
    }
    Ok(h)
}

/// Адрес функции из DLL как указатель на функцию типа T.
fn sym<T: Copy>(h: isize, name: &str) -> Result<T, String> {
    assert_eq!(std::mem::size_of::<T>(), std::mem::size_of::<*const c_void>());
    let c = CString::new(name).map_err(|e| e.to_string())?;
    let p = unsafe { GetProcAddress(h, c.as_ptr()) };
    if p.is_null() {
        return Err(format!("В библиотеке нет функции {name}"));
    }
    Ok(unsafe { std::mem::transmute_copy::<*const c_void, T>(&p) })
}

struct Vosk {
    model_new: VoskModelNew,
    rec_new: VoskRecognizerNew,
    accept: VoskAcceptWaveformS,
    result: VoskResult,
    partial: VoskResult,
    reset: VoskRecognizerVoid,
    rec_free: VoskRecognizerVoid,
}

struct Sherpa {
    create: TtsCreate,
    destroy: TtsDestroy,
    generate: TtsGenerate,
    free_audio: TtsAudioFree,
}

static VOSK: OnceLock<Vosk> = OnceLock::new();
static SHERPA: OnceLock<Sherpa> = OnceLock::new();

fn vosk(app: &AppHandle) -> Result<&'static Vosk, String> {
    if let Some(v) = VOSK.get() {
        return Ok(v);
    }
    let h = load_lib(app, "libvosk.dll")?;
    let log: VoskSetLogLevel = sym(h, "vosk_set_log_level")?;
    unsafe { log(-1) }; // без отладочного вывода
    let v = Vosk {
        model_new: sym(h, "vosk_model_new")?,
        rec_new: sym(h, "vosk_recognizer_new")?,
        accept: sym(h, "vosk_recognizer_accept_waveform_s")?,
        result: sym(h, "vosk_recognizer_result")?,
        partial: sym(h, "vosk_recognizer_partial_result")?,
        reset: sym(h, "vosk_recognizer_reset")?,
        rec_free: sym(h, "vosk_recognizer_free")?,
    };
    Ok(VOSK.get_or_init(|| v))
}

fn sherpa(app: &AppHandle) -> Result<&'static Sherpa, String> {
    if let Some(s) = SHERPA.get() {
        return Ok(s);
    }
    let h = load_lib(app, "sherpa-onnx-c-api.dll")?;
    let s = Sherpa {
        create: sym(h, "SherpaOnnxCreateOfflineTts")?,
        destroy: sym(h, "SherpaOnnxDestroyOfflineTts")?,
        generate: sym(h, "SherpaOnnxOfflineTtsGenerate")?,
        free_audio: sym(h, "SherpaOnnxDestroyOfflineTtsGeneratedAudio")?,
    };
    Ok(SHERPA.get_or_init(|| s))
}

fn c_text(p: *const c_char) -> String {
    if p.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
}

// ---------------- Скачивание моделей ----------------

const MODEL_URL: &str = "https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip";
const MODEL_SIZE: u64 = 46_000_000;
const VOICE_SIZE: u64 = 67_200_000;

fn voice_url(model: &str) -> String {
    format!("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-ru_RU-{model}-medium.tar.bz2")
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("vosk-ru"))
}

fn voice_dir(app: &AppHandle, model: &str) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("voices").join(model))
}

fn ready(dir: &Path) -> bool {
    dir.join(".ok").is_file()
}

#[derive(Clone, Default)]
struct Dl {
    what: String, // "model" или имя голоса
    busy: bool,
    progress: u8,
    error: Option<String>,
}

static DL: Mutex<Option<Dl>> = Mutex::new(None);

fn sys_tool(name: &str) -> PathBuf {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("System32").join(name)
}

/// Скачать архив в `base` и распаковать в `base/<name>` (без верхней папки архива).
/// Имена файлов относительные: curl.exe и tar.exe запускаются в `base`,
/// так русские буквы в пути к профилю им не мешают.
fn fetch(base: &Path, name: &str, url: &str, archive: &str, size: u64) -> Result<(), String> {
    std::fs::create_dir_all(base).map_err(|e| e.to_string())?;
    let arc = base.join(archive);
    let _ = std::fs::remove_file(&arc);
    let mut child = Command::new(sys_tool("curl.exe"))
        .current_dir(base)
        .args(["-fsSL", "--retry", "3", "--connect-timeout", "20", "-o", archive, url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Не запустился curl.exe: {e}"))?;
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(st) if st.success() => break,
            Some(st) => {
                let _ = std::fs::remove_file(&arc);
                return Err(format!("Не удалось скачать (curl, код {}). Есть интернет?", st.code().unwrap_or(-1)));
            }
            None => {
                let got = std::fs::metadata(&arc).map(|m| m.len()).unwrap_or(0);
                if let Some(d) = lock(&DL).as_mut() {
                    d.progress = logic::progress(got, size).min(90);
                }
                std::thread::sleep(Duration::from_millis(300));
            }
        }
    }
    if let Some(d) = lock(&DL).as_mut() {
        d.progress = 92;
    }
    let part = format!("{name}.part");
    let _ = std::fs::remove_dir_all(base.join(&part));
    std::fs::create_dir_all(base.join(&part)).map_err(|e| e.to_string())?;
    let st = Command::new(sys_tool("tar.exe"))
        .current_dir(base)
        .args(["-xf", archive, "-C", part.as_str(), "--strip-components", "1"])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| format!("Не запустился tar.exe: {e}"))?;
    let _ = std::fs::remove_file(&arc);
    if !st.success() {
        let _ = std::fs::remove_dir_all(base.join(&part));
        return Err("Архив не распаковался".into());
    }
    let dest = base.join(name);
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::rename(base.join(&part), &dest).map_err(|e| e.to_string())?;
    std::fs::write(dest.join(".ok"), url).map_err(|e| e.to_string())
}

/// Скачать модель распознавания ("model") или голос (имя модели piper) в фоне.
pub fn download(app: &AppHandle, what: &str) -> Result<(), String> {
    {
        let mut g = lock(&DL);
        if g.as_ref().is_some_and(|d| d.busy) {
            return Ok(());
        }
        *g = Some(Dl { what: what.to_string(), busy: true, ..Default::default() });
    }
    let data = data_dir(app)?;
    let what = what.to_string();
    std::thread::spawn(move || {
        let r = if what == "model" {
            fetch(&data, "vosk-ru", MODEL_URL, "vosk-ru.zip", MODEL_SIZE)
        } else if what.chars().all(|c| c.is_ascii_lowercase()) {
            fetch(&data.join("voices"), &what, &voice_url(&what), &format!("{what}.tar.bz2"), VOICE_SIZE)
        } else {
            Err("Неизвестный голос".into())
        };
        let mut g = lock(&DL);
        if let Some(d) = g.as_mut() {
            d.busy = false;
            d.progress = if r.is_ok() { 100 } else { 0 };
            d.error = r.err();
        }
    });
    Ok(())
}

// ---------------- Состояние для интерфейса ----------------

fn dl_state(what: &str, is_ready: bool) -> (String, u8, Option<String>) {
    let g = lock(&DL);
    match g.as_ref() {
        Some(d) if d.what == what && d.busy => ("downloading".into(), d.progress, None),
        _ if is_ready => ("ready".into(), 100, None),
        Some(d) if d.what == what && d.error.is_some() => ("error".into(), 0, d.error.clone()),
        _ => ("none".into(), 0, None),
    }
}

pub fn status(app: &AppHandle, preset: &str) -> Status {
    let model_ready = model_dir(app).map(|d| ready(&d)).unwrap_or(false);
    let p = logic::preset(preset);
    let voice_ready = voice_dir(app, p.model).map(|d| ready(&d)).unwrap_or(false);
    let (model, mp, me) = dl_state("model", model_ready);
    let (voice, vp, ve) = dl_state(p.model, voice_ready);
    let progress = if model == "downloading" { mp } else { vp };
    Status {
        libs: lib_path(app, "libvosk.dll").is_some(),
        model,
        voice,
        progress,
        error: me.or(ve).or_else(|| lock(&LAST_ERR).clone()),
        wake: WAKE_ON.load(SeqCst),
        listening: lock(&MACHINE).listening(),
    }
}

// ---------------- Микрофон ----------------

const RATE: u32 = 16_000;
const CHUNK: usize = 1600; // 100 мс
const NBUF: usize = 4;

struct Mic {
    h: isize,
    bufs: Vec<(*mut WaveHdr, Vec<i16>)>,
    next: usize,
}

impl Mic {
    fn open() -> Result<Mic, String> {
        let fmt = pcm_format(RATE);
        let mut h: isize = 0;
        // WAVE_MAPPER сам приведёт звук микрофона к 16 кГц моно
        let r = unsafe { waveInOpen(&mut h, WAVE_MAPPER, &fmt, 0, 0, CALLBACK_NULL) };
        if r != 0 {
            return Err(format!("Не открылся микрофон (код {r}). Проверьте, что он подключён и разрешён: Параметры → Конфиденциальность → Микрофон."));
        }
        let mut mic = Mic { h, bufs: Vec::new(), next: 0 };
        for _ in 0..NBUF {
            let mut data = vec![0i16; CHUNK];
            let hdr = new_hdr(&mut data);
            mic.bufs.push((hdr, data));
            unsafe {
                waveInPrepareHeader(h, hdr, HDR);
                waveInAddBuffer(h, hdr, HDR);
            }
        }
        let r = unsafe { waveInStart(h) };
        if r != 0 {
            return Err(format!("Микрофон не запустился (код {r})"));
        }
        Ok(mic)
    }

    /// Отдать записанные куски по порядку и вернуть буферы драйверу.
    fn poll(&mut self, mut f: impl FnMut(&[i16])) {
        for _ in 0..NBUF {
            let (hdr, data) = &self.bufs[self.next];
            let hdr = *hdr;
            if !hdr_done(hdr) {
                break;
            }
            let n = unsafe { std::ptr::read_volatile(std::ptr::addr_of!((*hdr).dwBytesRecorded)) } as usize / 2;
            f(&data[..n.min(CHUNK)]);
            unsafe {
                waveInUnprepareHeader(self.h, hdr, HDR);
                (*hdr).dwBytesRecorded = 0;
                (*hdr).dwFlags = 0;
                waveInPrepareHeader(self.h, hdr, HDR);
                waveInAddBuffer(self.h, hdr, HDR);
            }
            self.next = (self.next + 1) % NBUF;
        }
    }
}

impl Drop for Mic {
    fn drop(&mut self) {
        unsafe {
            waveInReset(self.h); // все буферы помечаются «готово»
            for (hdr, _) in &self.bufs {
                waveInUnprepareHeader(self.h, *hdr, HDR);
            }
            waveInClose(self.h);
            for (hdr, _) in self.bufs.drain(..) {
                drop(Box::from_raw(hdr));
            }
        }
    }
}

// ---------------- Звук ----------------

/// Проиграть куски PCM 16 бит моно подряд. `next` готовит следующий кусок, пока играет текущий.
fn play(rate: u32, mut next: impl FnMut() -> Option<Vec<i16>>, stop: impl Fn() -> bool) -> Result<(), String> {
    let fmt = pcm_format(rate);
    let mut h: isize = 0;
    let r = unsafe { waveOutOpen(&mut h, WAVE_MAPPER, &fmt, 0, 0, CALLBACK_NULL) };
    if r != 0 {
        return Err(format!("Не открылся звук (код {r})"));
    }
    let mut queued: Vec<(*mut WaveHdr, Vec<i16>)> = Vec::new();
    while !stop() {
        let Some(mut data) = next() else { break };
        if data.is_empty() {
            continue;
        }
        let hdr = new_hdr(&mut data);
        let ok = unsafe { waveOutPrepareHeader(h, hdr, HDR) == 0 && waveOutWrite(h, hdr, HDR) == 0 };
        if !ok {
            unsafe {
                waveOutUnprepareHeader(h, hdr, HDR);
                drop(Box::from_raw(hdr));
            }
            continue;
        }
        queued.push((hdr, data));
    }
    loop {
        if stop() {
            unsafe { waveOutReset(h) };
        }
        if queued.iter().all(|(hdr, _)| hdr_done(*hdr)) {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    unsafe {
        for (hdr, _) in &queued {
            waveOutUnprepareHeader(h, *hdr, HDR);
        }
        waveOutClose(h);
        for (hdr, _) in queued.drain(..) {
            drop(Box::from_raw(hdr));
        }
    }
    Ok(())
}

fn beep() {
    std::thread::spawn(|| {
        let mut once = Some(logic::beep_samples(RATE));
        let _ = play(RATE, move || once.take(), || false);
    });
}

// ---------------- «Тук Тук» ----------------

static WAKE_ON: AtomicBool = AtomicBool::new(false);
/// Слушаем по кнопке 🎤 (а не после «Тук Тук»).
static MANUAL: AtomicBool = AtomicBool::new(false);
static RUNNING: AtomicBool = AtomicBool::new(false);
/// Тук говорит — микрофон не слушаем, чтобы он не услышал сам себя.
static SPEAKING: AtomicBool = AtomicBool::new(false);
static MUTED_UNTIL: AtomicU64 = AtomicU64::new(0);
static MACHINE: Mutex<Wake> = Mutex::new(Wake::new());
static LAST_ERR: Mutex<Option<String>> = Mutex::new(None);
/// Загруженная модель Vosk (указатель; 0 — не загружена). Живёт до выхода из Тука.
static MODEL: Mutex<usize> = Mutex::new(0);

#[derive(serde::Serialize, Clone)]
struct WakeEvent {
    /// listen | partial | command | idle | error
    state: &'static str,
    text: String,
    /// true — это ответ на нажатие 🎤, а не «Тук Тук»
    manual: bool,
}

fn emit(app: &AppHandle, state: &'static str, text: String, manual: bool) {
    let _ = app.emit_to("main", "voice-wake", WakeEvent { state, text, manual });
}

fn deliver(app: &AppHandle, e: Ev) {
    let manual = MANUAL.load(SeqCst);
    match e {
        Ev::Listen => {
            beep();
            emit(app, "listen", String::new(), manual);
        }
        Ev::Partial(t) => emit(app, "partial", t, manual),
        Ev::Command { text, beep: b } => {
            if b {
                beep();
            }
            MANUAL.store(false, SeqCst);
            emit(app, "command", text, manual);
        }
        Ev::Idle => {
            MANUAL.store(false, SeqCst);
            emit(app, "idle", String::new(), manual);
        }
    }
}

fn model_ptr(app: &AppHandle, v: &Vosk) -> Result<*mut c_void, String> {
    let mut g = lock(&MODEL);
    if *g == 0 {
        let dir = model_dir(app)?;
        if !ready(&dir) {
            return Err("Модель распознавания не скачана".into());
        }
        let path = ascii_path(&dir)?;
        let m = unsafe { (v.model_new)(path.as_ptr()) };
        if m.is_null() {
            return Err("Не удалось открыть модель распознавания — скачайте её заново".into());
        }
        *g = m as usize;
    }
    Ok(*g as *mut c_void)
}

fn wanted() -> bool {
    WAKE_ON.load(SeqCst) || MANUAL.load(SeqCst)
}

fn ensure_thread(app: &AppHandle) {
    if RUNNING.swap(true, SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let r = listen_loop(&app);
        RUNNING.store(false, SeqCst);
        match r {
            Err(e) => {
                *lock(&LAST_ERR) = Some(e.clone());
                WAKE_ON.store(false, SeqCst);
                let manual = MANUAL.swap(false, SeqCst);
                lock(&MACHINE).reset();
                emit(&app, "error", e, manual);
            }
            // пока поток завершался, могли снова включить
            Ok(()) if wanted() => ensure_thread(&app),
            Ok(()) => {}
        }
    });
}

fn listen_loop(app: &AppHandle) -> Result<(), String> {
    let v = vosk(app)?;
    let model = model_ptr(app, v)?;
    let rec = unsafe { (v.rec_new)(model, RATE as f32) };
    if rec.is_null() {
        return Err("Не удалось запустить распознавание".into());
    }
    let r = Mic::open().map(|mut mic| {
        *lock(&LAST_ERR) = None;
        let mut was_muted = false;
        while wanted() {
            let muted = SPEAKING.load(SeqCst) || now_ms() < MUTED_UNTIL.load(SeqCst);
            if muted && !was_muted {
                unsafe { (v.reset)(rec) }; // недослушанное до речи Тука — забыть
            }
            was_muted = muted;
            let mut evs = Vec::new();
            mic.poll(|pcm| {
                let mut m = lock(&MACHINE);
                // без «Тук Тук» и без кнопки звук не разбираем вовсе
                if muted || pcm.is_empty() || (!WAKE_ON.load(SeqCst) && !m.listening()) {
                    return;
                }
                let now = now_ms();
                let res = unsafe { (v.accept)(rec, pcm.as_ptr(), pcm.len() as i32) };
                let ev = if res == 1 {
                    let t = logic::json_field(&c_text(unsafe { (v.result)(rec) }), "text");
                    m.on_final(&t, now)
                } else if res == 0 {
                    let t = logic::json_field(&c_text(unsafe { (v.partial)(rec) }), "partial");
                    m.on_partial(&t, now)
                } else {
                    None
                };
                evs.extend(ev);
            });
            evs.extend(lock(&MACHINE).tick(now_ms()));
            for e in evs {
                deliver(app, e);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    });
    unsafe { (v.rec_free)(rec) };
    r
}

/// Включить или выключить постоянное слушание «Тук Тук».
pub fn set_wake(app: &AppHandle, on: bool) -> Result<(), String> {
    if on {
        if !model_dir(app).map(|d| ready(&d)).unwrap_or(false) {
            return Err("Сначала скачайте модель распознавания".into());
        }
        vosk(app)?;
        WAKE_ON.store(true, SeqCst);
        ensure_thread(app);
    } else {
        WAKE_ON.store(false, SeqCst);
        if !MANUAL.load(SeqCst) {
            lock(&MACHINE).reset();
        }
    }
    Ok(())
}

/// Кнопка 🎤: start — слушать команду сразу; stop — отдать сказанное; cancel — отменить.
pub fn listen(app: &AppHandle, action: &str) -> Result<(), String> {
    match action {
        "start" => {
            if !model_dir(app).map(|d| ready(&d)).unwrap_or(false) {
                return Err("Скачайте распознавание речи: ⚙ → «Компьютер» → «Тук Тук»".into());
            }
            vosk(app)?;
            lock(&MACHINE).force_command(now_ms());
            MANUAL.store(true, SeqCst);
            ensure_thread(app);
        }
        "stop" => {
            let e = lock(&MACHINE).finish();
            deliver(app, e);
        }
        _ => {
            lock(&MACHINE).reset();
            let manual = MANUAL.swap(false, SeqCst);
            emit(app, "idle", String::new(), manual);
        }
    }
    Ok(())
}

// ---------------- Живой голос ----------------

static SPEAK_ID: AtomicU64 = AtomicU64::new(0);
static SPEAK_LOCK: Mutex<()> = Mutex::new(());
/// Загруженный синтезатор: (модель + высота, указатель).
static TTS: Mutex<Option<(String, usize)>> = Mutex::new(None);

fn tts_engine(sh: &Sherpa, dir: &Path, p: &logic::Preset) -> Result<*const c_void, String> {
    let key = format!("{}{}", p.model, p.pitch);
    let mut g = lock(&TTS);
    if let Some((k, ptr)) = g.as_ref() {
        if *k == key {
            return Ok(*ptr as *const c_void);
        }
    }
    if let Some((_, old)) = g.take() {
        unsafe { (sh.destroy)(old as *const c_void) };
    }
    let onnx = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .find(|p| p.extension().is_some_and(|x| x == "onnx"))
        .ok_or("Голос не скачан")?;
    let model = ascii_path(&onnx)?;
    let tokens = ascii_path(&dir.join("tokens.txt"))?;
    let espeak = ascii_path(&dir.join("espeak-ng-data"))?;
    let empty = CString::default();
    let cpu = CString::new("cpu").unwrap();
    let cfg = TtsConfig {
        model: TtsModel {
            vits: TtsVits {
                model: model.as_ptr(),
                lexicon: empty.as_ptr(),
                tokens: tokens.as_ptr(),
                data_dir: espeak.as_ptr(),
                noise_scale: p.noise,
                noise_scale_w: 0.8,
                length_scale: p.pitch,
                dict_dir: empty.as_ptr(),
            },
            num_threads: 2,
            debug: 0,
            provider: cpu.as_ptr(),
            other: [0; 43],
        },
        rule_fsts: empty.as_ptr(),
        max_num_sentences: 1,
        rule_fars: empty.as_ptr(),
        silence_scale: 0.2,
    };
    let t = unsafe { (sh.create)(&cfg) };
    if t.is_null() {
        return Err("Не удалось открыть голос — скачайте его заново".into());
    }
    *g = Some((key, t as usize));
    Ok(t)
}

/// Синтез одной фразы: PCM 16 бит и частота.
fn synth(sh: &Sherpa, tts: *const c_void, text: &str, pitch: f32) -> Option<(Vec<i16>, u32)> {
    let c = CString::new(text.replace('\0', " ")).ok()?;
    let a = unsafe { (sh.generate)(tts, c.as_ptr(), 0, 1.0) };
    if a.is_null() {
        return None;
    }
    let out = unsafe {
        let n = (*a).n.max(0) as usize;
        let rate = (*a).sample_rate.max(1) as u32;
        let s = if n == 0 || (*a).samples.is_null() { &[][..] } else { std::slice::from_raw_parts((*a).samples, n) };
        // как на Android: синтез медленнее в pitch раз, звук быстрее в pitch раз — голос звонче
        let pcm = logic::to_i16(&logic::speed_up(s, pitch));
        (sh.free_audio)(a);
        (pcm, rate)
    };
    Some(out)
}

/// Произнести текст живым голосом. Ok(false) — голос не скачан (тогда говорит WebView).
pub fn speak(app: &AppHandle, text: &str, preset: &str) -> Result<bool, String> {
    let p = logic::preset(preset);
    let dir = voice_dir(app, p.model)?;
    if !ready(&dir) || lib_path(app, "sherpa-onnx-c-api.dll").is_none() {
        return Ok(false);
    }
    let sh = sherpa(app)?;
    let id = SPEAK_ID.fetch_add(1, SeqCst) + 1; // прежняя речь замолкает
    let _one = lock(&SPEAK_LOCK);
    if SPEAK_ID.load(SeqCst) != id {
        return Ok(true);
    }
    let tts = tts_engine(sh, &dir, &p)?;
    let parts = logic::sentences(text);
    let mut it = parts.iter();
    let stop = || SPEAK_ID.load(SeqCst) != id;
    let first = loop {
        match it.next() {
            None => return Ok(true),
            Some(s) => {
                if let Some(x) = synth(sh, tts, s, p.pitch) {
                    break x;
                }
            }
        }
    };
    SPEAKING.store(true, SeqCst);
    let (pcm, rate) = first;
    let mut first = Some(pcm);
    let r = play(
        rate,
        || {
            if let Some(f) = first.take() {
                return Some(f);
            }
            loop {
                if stop() {
                    return None;
                }
                let s = it.next()?;
                if let Some((pcm, _)) = synth(sh, tts, s, p.pitch) {
                    return Some(pcm);
                }
            }
        },
        &stop,
    );
    MUTED_UNTIL.store(now_ms() + 200, SeqCst);
    SPEAKING.store(false, SeqCst);
    r.map(|_| true)
}

pub fn speak_stop() {
    SPEAK_ID.fetch_add(1, SeqCst);
}
