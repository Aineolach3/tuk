//! Только для ПК: питомец на рабочем столе, музыка Windows, настройки хуков Claude Code.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------- Питомец ----------
//
// По мотивам Coucou (MIT, Louis Raillé): src-tauri/src/desktop.rs.
//
// Окно «pet» объявлено в tauri.conf.json и создаётся вместе с приложением
// (WebView2-окно, созданное позже, иногда приходит пустым), прозрачное, ровно
// по размеру персонажа. На Windows его не прячут, а уводят за край экрана:
// повторный show() может отнять фокус у программы, где человек печатает.
// Пока питомец на столе, опрос курсора делает окно прозрачным для кликов
// везде, кроме силуэта Тука.

pub const PET: &str = "pet";
/// Окно питомца, логические пиксели: ровно по Туку (фигура ≈ 1 : 1,2, холст без полей).
pub const PET_W: f64 = 120.0;
pub const PET_H: f64 = 144.0;
/// Отступ от краёв рабочей области, логические пиксели.
const PET_MARGIN: f64 = 16.0;
const PARKED: (i32, i32) = (-32000, -32000);

static PET_SHOWN: AtomicBool = AtomicBool::new(false);
static PET_POLL: AtomicBool = AtomicBool::new(false);
static PET_IGNORING: AtomicBool = AtomicBool::new(false);
/// Над питомцем тащат файл — окно принимает мышь целиком.
pub static PET_FILE_DRAG: AtomicBool = AtomicBool::new(false);
/// Последнее место питомца, ещё не записанное на диск.
static PET_DIRTY: Mutex<Option<(i32, i32)>> = Mutex::new(None);

/// Чистая геометрия питомца (с тестами внизу файла).
pub mod pet_logic {
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct Rect {
        pub x: f64,
        pub y: f64,
        pub w: f64,
        pub h: f64,
    }

    impl Rect {
        pub fn contains(&self, p: (f64, f64)) -> bool {
            p.0 >= self.x && p.0 < self.x + self.w && p.1 >= self.y && p.1 < self.y + self.h
        }
    }

    /// Монитор: весь экран, рабочая область (без панели задач), масштаб.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct Display {
        pub frame: Rect,
        pub work: Rect,
        pub scale: f64,
    }

    /// Попадает ли точка (логические px окна w×h) в силуэт Тука: эллипс по
    /// капюшону и куртке. Вне силуэта клики уходят на рабочий стол.
    pub fn over_body(local: (f64, f64), w: f64, h: f64) -> bool {
        let (cx, cy) = (w * 0.5, h * 0.52);
        let (rx, ry) = (w * 0.44, h * 0.5);
        let (dx, dy) = ((local.0 - cx) / rx, (local.1 - cy) / ry);
        dx * dx + dy * dy <= 1.0
    }

    /// Удержать окно w×h (в единицах экрана) внутри рабочей области с отступом.
    pub fn clamp_origin(o: (f64, f64), w: f64, h: f64, work: Rect, margin: f64) -> (f64, f64) {
        (
            o.0.max(work.x + margin).min(work.x + work.w - w - margin),
            o.1.max(work.y + margin).min(work.y + work.h - h - margin),
        )
    }

    /// Сохранённое место (физические px), проверенное по мониторам, подключённым сейчас:
    /// None — центр окна не попадает ни на один экран (монитор отключили).
    pub fn restore(spot: (f64, f64), displays: &[Display], w: f64, h: f64, margin: f64) -> Option<(f64, f64)> {
        displays.iter().find_map(|d| {
            let (pw, ph) = (w * d.scale, h * d.scale);
            d.frame
                .contains((spot.0 + pw / 2.0, spot.1 + ph / 2.0))
                .then(|| clamp_origin(spot, pw, ph, d.work, margin * d.scale))
        })
    }

    /// Первое появление: правый нижний угол рабочей области.
    pub fn default_spot(d: &Display, w: f64, h: f64, margin: f64) -> (f64, f64) {
        let m = margin * d.scale;
        (d.work.x + d.work.w - w * d.scale - m, d.work.y + d.work.h - h * d.scale - m)
    }
}

use pet_logic::{Display, Rect};

fn pet_pos_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("pet-position.txt"))
}

fn load_pet_pos(app: &AppHandle) -> Option<(i32, i32)> {
    let s = std::fs::read_to_string(pet_pos_file(app)?).ok()?;
    let (x, y) = s.trim().split_once(',')?;
    Some((x.trim().parse().ok()?, y.trim().parse().ok()?))
}

fn save_pet_pos(app: &AppHandle, x: i32, y: i32) {
    if let Some(f) = pet_pos_file(app) {
        let _ = std::fs::write(f, format!("{x},{y}"));
    }
}

fn displays(app: &AppHandle) -> Vec<Display> {
    let Ok(ms) = app.available_monitors() else { return Vec::new() };
    ms.iter()
        .map(|m| {
            let (p, s, wa) = (m.position(), m.size(), m.work_area());
            Display {
                frame: Rect { x: p.x as f64, y: p.y as f64, w: s.width as f64, h: s.height as f64 },
                work: Rect {
                    x: wa.position.x as f64,
                    y: wa.position.y as f64,
                    w: wa.size.width as f64,
                    h: wa.size.height as f64,
                },
                scale: m.scale_factor(),
            }
        })
        .collect()
}

/// Где показать питомца: сохранённое место, если оно на видимом мониторе, иначе угол основного экрана.
fn pet_spot(app: &AppHandle) -> Option<(i32, i32)> {
    let all = displays(app);
    let restored = load_pet_pos(app).and_then(|(x, y)| pet_logic::restore((x as f64, y as f64), &all, PET_W, PET_H, PET_MARGIN));
    let spot = restored.or_else(|| {
        let primary = app.primary_monitor().ok().flatten();
        let d = primary
            .and_then(|m| all.iter().copied().find(|d| d.frame.x == m.position().x as f64 && d.frame.y == m.position().y as f64))
            .or_else(|| all.first().copied())?;
        Some(pet_logic::default_spot(&d, PET_W, PET_H, PET_MARGIN))
    })?;
    Some((spot.0.round() as i32, spot.1.round() as i32))
}

pub fn pet_visible() -> bool {
    PET_SHOWN.load(Ordering::Relaxed)
}

/// Подготовить окно питомца при запуске: увести за край, подписаться на перемещения и файлы.
pub fn setup_pet(app: &AppHandle) {
    let Some(w) = app.get_webview_window(PET) else { return };
    #[cfg(windows)]
    crate::win32::make_non_activating(&w);
    let _ = w.set_size(tauri::LogicalSize::new(PET_W, PET_H));
    let _ = w.set_position(PhysicalPosition::new(PARKED.0, PARKED.1));
    #[cfg(not(windows))]
    let _ = w.hide();
    let _ = w.set_ignore_cursor_events(true);
    PET_IGNORING.store(true, Ordering::Relaxed);
    crate::files::install(app, &w);
    w.on_window_event(|e| {
        if let tauri::WindowEvent::Moved(p) = e {
            if PET_SHOWN.load(Ordering::Relaxed) && p.x > -30000 && p.y > -30000 {
                *PET_DIRTY.lock().unwrap() = Some((p.x, p.y));
            }
        }
    });
    spawn_pet_poll(app.clone());
}

pub fn pet_show(app: &AppHandle, show: bool) -> Result<(), String> {
    let w = app.get_webview_window(PET).ok_or("Окно питомца не создано")?;
    if show {
        let (x, y) = pet_spot(app).ok_or("Не нашёл ни одного монитора")?;
        let _ = w.set_size(tauri::LogicalSize::new(PET_W, PET_H));
        w.set_position(PhysicalPosition::new(x, y)).map_err(err)?;
        // окно с прошлого раза могло получить чужой масштаб — размер ещё раз
        let _ = w.set_size(tauri::LogicalSize::new(PET_W, PET_H));
        #[cfg(not(windows))]
        let _ = w.show();
        let _ = w.set_always_on_top(true);
        PET_SHOWN.store(true, Ordering::Relaxed);
        PET_IGNORING.store(false, Ordering::Relaxed);
        let _ = w.set_ignore_cursor_events(false);
        PET_POLL.store(true, Ordering::Relaxed);
        save_pet_pos(app, x, y);
    } else {
        flush_pet_pos(app);
        PET_SHOWN.store(false, Ordering::Relaxed);
        PET_POLL.store(false, Ordering::Relaxed);
        let _ = w.set_ignore_cursor_events(true);
        PET_IGNORING.store(true, Ordering::Relaxed);
        #[cfg(windows)]
        let _ = w.set_position(PhysicalPosition::new(PARKED.0, PARKED.1));
        #[cfg(not(windows))]
        let _ = w.hide();
    }
    let _ = app.emit_to(PET, "pet-visible", show);
    let _ = app.emit_to("main", "pet-visible", show);
    Ok(())
}

fn flush_pet_pos(app: &AppHandle) {
    if let Some((x, y)) = PET_DIRTY.lock().unwrap().take() {
        save_pet_pos(app, x, y);
    }
}

#[derive(serde::Serialize, Clone)]
struct PetCursor {
    x: f64,
    y: f64,
}

/// ~60 Гц, пока питомец на столе: click-through вне силуэта, «pet-cursor» для глаз;
/// раз в секунду — запись места на диск, если его двигали.
fn spawn_pet_poll(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_save = Instant::now();
        let mut last = (f64::MIN, f64::MIN);
        loop {
            if !PET_POLL.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(250));
                if last_save.elapsed() > Duration::from_secs(1) {
                    flush_pet_pos(&app);
                    last_save = Instant::now();
                }
                continue;
            }
            std::thread::sleep(Duration::from_millis(16));
            if last_save.elapsed() > Duration::from_secs(1) {
                flush_pet_pos(&app);
                last_save = Instant::now();
            }
            let Some(w) = app.get_webview_window(PET) else { continue };
            let (Ok(o), Ok(c)) = (w.outer_position(), w.cursor_position()) else { continue };
            let scale = w.scale_factor().unwrap_or(1.0);
            let local = ((c.x - o.x as f64) / scale, (c.y - o.y as f64) / scale);
            let over_window = local.0 >= 0.0 && local.0 <= PET_W && local.1 >= 0.0 && local.1 <= PET_H;
            let down = crate::island::left_button_down();
            let accept = pet_logic::over_body(local, PET_W, PET_H) || (down && over_window) || PET_FILE_DRAG.load(Ordering::Relaxed);
            if PET_IGNORING.load(Ordering::Relaxed) == accept {
                PET_IGNORING.store(!accept, Ordering::Relaxed);
                let _ = w.set_ignore_cursor_events(!accept);
            }
            if (local.0 - last.0).abs() >= 1.0 || (local.1 - last.1).abs() >= 1.0 {
                last = local;
                let _ = app.emit_to(PET, "pet-cursor", PetCursor { x: local.0, y: local.1 });
            }
        }
    });
}

/// Курсор относительно окна (логические пиксели) — чтобы глаза питомца следили за мышью по всему экрану.
pub fn cursor_rel(w: &tauri::WebviewWindow) -> Result<(f64, f64), String> {
    let c = w.cursor_position().map_err(err)?;
    let p = w.outer_position().map_err(err)?;
    let s = w.scale_factor().map_err(err)?;
    Ok(((c.x - p.x as f64) / s, (c.y - p.y as f64) / s))
}

// ---------- Claude Code ----------

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

pub fn claude_settings_path() -> PathBuf {
    home().join(".claude").join("settings.json")
}

/// {"exe": путь к Tuk.exe, "settings": путь к settings.json, "exists": есть ли файл}
pub fn claude_info() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(err)?;
    let p = claude_settings_path();
    Ok(format!(
        "{{\"exe\":{},\"settings\":{},\"exists\":{}}}",
        crate::net::json_str(&exe.display().to_string()),
        crate::net::json_str(&p.display().to_string()),
        p.exists()
    ))
}

pub fn claude_read() -> Result<String, String> {
    match std::fs::read_to_string(claude_settings_path()) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Записать settings.json; перед первой записью кладём резервную копию рядом.
pub fn claude_write(json: &str) -> Result<String, String> {
    let p = claude_settings_path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    let backup = p.with_extension("json.tuk-backup");
    if p.exists() && !backup.exists() {
        std::fs::copy(&p, &backup).map_err(err)?;
    }
    std::fs::write(&p, json).map_err(err)?;
    Ok(p.display().to_string())
}

// ---------- Музыка (Windows: системные медиа-элементы управления) ----------

#[cfg(windows)]
pub mod media {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager as Manager, GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Storage::Streams::DataReader;

    fn e<E: std::fmt::Debug>(x: E) -> String {
        format!("{x:?}")
    }

    /// Что играет: JSON или "null", если ничего.
    pub fn info() -> Result<String, String> {
        let mgr = Manager::RequestAsync().map_err(e)?.get().map_err(e)?;
        let Ok(s) = mgr.GetCurrentSession() else { return Ok("null".into()) };
        let props = s.TryGetMediaPropertiesAsync().map_err(e)?.get().map_err(e)?;
        let title = props.Title().map(|h| h.to_string()).unwrap_or_default();
        let artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();
        let app = s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default();
        let playing = s
            .GetPlaybackInfo()
            .and_then(|i| i.PlaybackStatus())
            .map(|st| st == Status::Playing)
            .unwrap_or(false);
        if title.is_empty() && !playing {
            return Ok("null".into());
        }
        let j = crate::net::json_str;
        Ok(format!(
            "{{\"title\":{},\"artist\":{},\"app\":{},\"playing\":{}}}",
            j(&title),
            j(&artist),
            j(&app),
            playing
        ))
    }

    /// Обложка в base64 (или пустая строка).
    pub fn thumb() -> Result<String, String> {
        let mgr = Manager::RequestAsync().map_err(e)?.get().map_err(e)?;
        let Ok(s) = mgr.GetCurrentSession() else { return Ok(String::new()) };
        let props = s.TryGetMediaPropertiesAsync().map_err(e)?.get().map_err(e)?;
        let Ok(r) = props.Thumbnail() else { return Ok(String::new()) };
        let stream = r.OpenReadAsync().map_err(e)?.get().map_err(e)?;
        let size = stream.Size().map_err(e)? as u32;
        if size == 0 || size > 8_000_000 {
            return Ok(String::new());
        }
        let reader = DataReader::CreateDataReader(&stream).map_err(e)?;
        reader.LoadAsync(size).map_err(e)?.get().map_err(e)?;
        let mut buf = vec![0u8; size as usize];
        reader.ReadBytes(&mut buf).map_err(e)?;
        Ok(crate::net::b64encode(&buf))
    }

    pub fn control(action: &str) -> Result<(), String> {
        let mgr = Manager::RequestAsync().map_err(e)?.get().map_err(e)?;
        let s = mgr.GetCurrentSession().map_err(e)?;
        let op = match action {
            "next" => s.TrySkipNextAsync(),
            "prev" => s.TrySkipPreviousAsync(),
            _ => s.TryTogglePlayPauseAsync(),
        };
        op.map_err(e)?.get().map_err(e)?;
        Ok(())
    }
}

#[cfg(test)]
mod pet_tests {
    use super::pet_logic::*;

    fn d(x: f64, y: f64, w: f64, h: f64, scale: f64) -> Display {
        let frame = Rect { x, y, w, h };
        Display { frame, work: Rect { h: h - 48.0 * scale, ..frame }, scale }
    }

    #[test]
    fn body_hit_is_the_silhouette_not_the_square() {
        assert!(over_body((60.0, 78.0), 120.0, 144.0));
        assert!(over_body((60.0, 10.0), 120.0, 144.0), "антенна/капюшон сверху");
        assert!(!over_body((2.0, 2.0), 120.0, 144.0), "угол окна пропускает клики");
        assert!(!over_body((118.0, 140.0), 120.0, 144.0));
    }

    #[test]
    fn saved_spot_on_unplugged_monitor_is_dropped() {
        let main = d(0.0, 0.0, 1920.0, 1080.0, 1.0);
        let right = d(1920.0, 0.0, 2560.0, 1440.0, 1.5);
        assert_eq!(restore((3000.0, 500.0), &[main, right], 120.0, 144.0, 16.0), Some((3000.0, 500.0)));
        assert_eq!(restore((3000.0, 500.0), &[main], 120.0, 144.0, 16.0), None);
    }

    #[test]
    fn spot_is_pulled_inside_work_area() {
        let main = d(0.0, 0.0, 1920.0, 1080.0, 1.0);
        // наполовину под панелью задач
        let (x, y) = restore((1850.0, 1000.0), &[main], 120.0, 144.0, 16.0).unwrap();
        assert_eq!((x, y), (1920.0 - 120.0 - 16.0, 1080.0 - 48.0 - 144.0 - 16.0));
        let (dx, dy) = default_spot(&main, 120.0, 144.0, 16.0);
        assert!(dx > 1700.0 && dy > 800.0);
    }
}
