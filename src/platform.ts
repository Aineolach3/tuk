// Мост к платформе. В Tauri используем глобальный window.__TAURI__ (app.withGlobalTauri = true),
// поэтому фронтенду не нужны npm-пакеты. В обычном браузере — демо-режим на localStorage.

import type { Repeat } from './model.js';

export type BarMode = 'collapsed' | 'compact' | 'expanded';
export type PlatformKind = 'desktop' | 'android' | 'web';

export interface SyncRequestEvent {
  id: number;
  path: string;
  body: string;
}
export interface Found {
  ip: string;
  id: string;
  port: number;
  name: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const T: any = (globalThis as any).__TAURI__;
const invoke = (cmd: string, args?: Record<string, unknown>): Promise<any> => T.core.invoke(cmd, args);

export const kind: PlatformKind = !T ? 'web' : /android/i.test(navigator.userAgent) ? 'android' : 'desktop';

const LS_KEY = 'tuk-demo-data';

export async function loadData(): Promise<string | null> {
  if (!T) {
    try {
      return localStorage.getItem(LS_KEY);
    } catch {
      return null;
    }
  }
  return (await invoke('load_data')) ?? null;
}

export async function saveData(json: string): Promise<void> {
  if (!T) {
    try {
      localStorage.setItem(LS_KEY, json);
    } catch {
      /* демо без хранилища — ничего страшного */
    }
    return;
  }
  await invoke('save_data', { json });
}

export async function setMode(mode: BarMode): Promise<void> {
  const phase = mode === 'collapsed' ? 'hidden' : mode === 'compact' ? 'peek' : 'home';
  await islandPhase(phase);
}

// ---------- Остров (ПК) ----------
// Фазу выбирает машина состояний src/island.ts; Rust меняет размер окна,
// click-through и фокус (src-tauri/src/island.rs).

export type IslandPhaseName = 'hidden' | 'peek' | 'home';
// номер растёт и после перезагрузки страницы (Rust помнит последний): мс × 1000 + счётчик
let phaseCounter = 0;
const nextPhaseSeq = () => Date.now() * 1000 + (++phaseCounter % 1000);

/** Окно этой страницы — остров (а не питомец). */
const isIslandWindow = () => kind === 'desktop' && windowLabel() === 'main';

/** Сообщить Rust фазу острова. Номер по порядку: устаревший вызов IPC не применится. */
export async function islandPhase(phase: IslandPhaseName): Promise<void> {
  if (!isIslandWindow()) return;
  await invoke('island_set_phase', { phase, seq: nextPhaseSeq() }).catch(() => {});
}

/** Где на странице видимый остров (CSS px = логические px окна): вне него клики проходят насквозь. */
export async function islandRect(r: { x: number; y: number; width: number; height: number }): Promise<void> {
  if (!isIslandWindow()) return;
  await invoke('island_set_rect', { x: r.x, y: r.y, width: r.width, height: r.height }).catch(() => {});
}

/** Экран острова: основной или тот, где мышь. */
export async function islandScreen(screen: 'primary' | 'cursor'): Promise<void> {
  if (kind === 'desktop') await invoke('island_set_screen', { screen }).catch(() => {});
}

/** Поправить зум WebView2, если devicePixelRatio не совпал с масштабом окна. */
export async function islandFitZoom(): Promise<void> {
  if (isIslandWindow()) await invoke('island_fit_zoom', { dpr: window.devicePixelRatio || 1 }).catch(() => {});
}

export async function listen(event: string, cb: (payload: any) => void): Promise<void> {
  if (!T) return;
  await T.event.listen(event, (e: any) => cb(e.payload));
}

// ---------- Уведомления ----------

/** API плагина: window.__TAURI__.<имя> или __TAURI_PLUGIN_<ИМЯ>__ — зависит от версии плагина. */
function plugin(camel: string, iife: string): any | null {
  const g = globalThis as any;
  return T?.[camel] ?? g[iife] ?? null;
}

/** Если JS-обёртки плагина нет, работаем напрямую через его команды. */
function notificationFallback(): any {
  return {
    isPermissionGranted: async () => (await invoke('plugin:notification|is_permission_granted')) === true,
    requestPermission: async () => invoke('plugin:notification|request_permission'),
    sendNotification: (options: any) => invoke('plugin:notification|notify', { options }),
    cancel: (notifications: number[]) => invoke('plugin:notification|cancel', { notifications }),
    Schedule: {
      at: (date: Date, repeating = false, allowWhileIdle = false) => ({ at: { date, repeating, allowWhileIdle } }),
      interval: (interval: unknown, allowWhileIdle = false) => ({ interval: { interval, allowWhileIdle } }),
    },
  };
}

async function notifApi(): Promise<any | null> {
  if (!T) return null;
  const n = plugin('notification', '__TAURI_PLUGIN_NOTIFICATION__') ?? notificationFallback();
  let ok = await n.isPermissionGranted().catch(() => false);
  if (!ok) ok = (await n.requestPermission().catch(() => 'denied')) === 'granted';
  return ok ? n : null;
}

export async function notify(title: string, body: string): Promise<void> {
  if (!T) {
    if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
    return;
  }
  const n = await notifApi();
  n?.sendNotification({ title, body });
}

export async function askNotifyPermission(): Promise<void> {
  if (!T) {
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    return;
  }
  await notifApi();
}

/** Android: системное уведомление по расписанию — сработает, даже если приложение закрыто. */
export async function scheduleNotification(id: number, title: string, body: string, at: number, repeat: Repeat | null): Promise<void> {
  if (kind !== 'android') return;
  const n = await notifApi();
  if (!n) return;
  const d = new Date(at);
  const S = n.Schedule;
  let schedule: unknown;
  if (repeat === 'daily') schedule = S.interval({ hour: d.getHours(), minute: d.getMinutes() }, true);
  // в плагине Tauri дни недели как в iOS: 1 — воскресенье … 7 — суббота
  else if (repeat === 'weekly') schedule = S.interval({ weekday: d.getDay() + 1, hour: d.getHours(), minute: d.getMinutes() }, true);
  else if (repeat === 'hourly') schedule = S.interval({ minute: d.getMinutes() }, true);
  else schedule = S.at(d, false, true);
  n.sendNotification({ id, title, body, schedule });
}

export async function cancelNotifications(ids: number[]): Promise<void> {
  if (kind !== 'android' || !ids.length) return;
  const n = await notifApi();
  await n?.cancel?.(ids);
}

// ---------- Сеть (Rust) ----------

export async function localIp(): Promise<string> {
  if (!T) return '192.168.1.10';
  return invoke('local_ip');
}

export async function startServer(port: number, beacon: string): Promise<void> {
  if (!T) return;
  await invoke('server_start', { port, beacon });
}

/**
 * Запросы, которые ещё ждут ответа страницы (формат как у события `sync-request`).
 * Вызвать после перезагрузки страницы: ждущие запросы разрешений Claude Code не потеряются.
 */
export async function serverInflight(): Promise<SyncRequestEvent[]> {
  if (kind !== 'desktop') return [];
  const raw: string[] = await invoke('server_inflight').catch(() => []);
  return raw.map((r) => JSON.parse(r) as SyncRequestEvent);
}

export async function serverReply(id: number, status: number, body: string): Promise<void> {
  await invoke('server_reply', { id, status, body });
}

export async function httpPost(host: string, port: number, path: string, body: string): Promise<string> {
  if (!T) throw new Error('В демо-режиме связи нет');
  return invoke('http_post', { host, port, path, body });
}

export async function discover(ms: number): Promise<Found[]> {
  if (!T) return [];
  const raw: string[] = await invoke('discover', { ms });
  const out: Found[] = [];
  for (const line of raw) {
    // «ip|TUK1|id|port|имя»
    const [ip, tag, id, port, ...name] = line.split('|');
    if (tag === 'TUK1' && id && !out.some((f) => f.id === id)) out.push({ ip, id, port: +port || 47800, name: name.join('|') });
  }
  return out;
}

export async function scanQr(): Promise<string | null> {
  if (kind !== 'android') return null;
  const bs = plugin('barcodeScanner', '__TAURI_PLUGIN_BARCODE_SCANNER__') ?? {
    checkPermissions: () => invoke('plugin:barcode-scanner|check_permissions').then((r: any) => r?.camera ?? r),
    requestPermissions: () => invoke('plugin:barcode-scanner|request_permissions').then((r: any) => r?.camera ?? r),
    scan: (o: any) => invoke('plugin:barcode-scanner|scan', o),
  };
  const perm = await bs.checkPermissions?.();
  if (perm && perm !== 'granted') {
    const r = await bs.requestPermissions?.();
    if (r && r !== 'granted') throw new Error('Нет доступа к камере');
  }
  const res = await bs.scan({ windowed: false, formats: [bs.Format?.QRCode ?? 'QR_CODE'] });
  return res?.content ?? null;
}

export async function setAutostart(on: boolean): Promise<void> {
  if (kind === 'desktop') await invoke('set_autostart', { enabled: on }).catch(() => {});
}

/** Сохранить картинку (base64 PNG) в «Изображения» или «Загрузки». Возвращает путь. */
export async function saveImage(name: string, base64: string): Promise<string> {
  if (!T) throw new Error('В демо-режиме сохранить нельзя — сделайте снимок экрана');
  return invoke('save_image', { name, base64 });
}

// ---------- Окна, питомец ----------

export function windowLabel(): string {
  try {
    return T?.window?.getCurrentWindow?.().label ?? 'main';
  } catch {
    return 'main';
  }
}

export async function emit(event: string, payload: unknown): Promise<void> {
  if (T?.event?.emit) await T.event.emit(event, payload).catch(() => {});
}

export const petShow = (show: boolean) => (kind === 'desktop' ? invoke('pet_show', { show }) : Promise.resolve());

// ---------- Файлы (ПК) ----------

/** Файл, брошенный из Проводника (событие `files-drop`). */
export interface DroppedFile {
  name: string;
  path: string;
  size: number;
  /** Содержимое base64; нет — больше 50 МБ, папка или не прочитать. */
  data?: string;
  dir?: boolean;
  error?: string;
}

/** Пути последнего броска (если страница перезагрузилась и событие пропустила). */
export const droppedPaths = (): Promise<string[]> => (kind === 'desktop' ? invoke('dropped_paths') : Promise.resolve([]));

/** Байты брошенного файла (base64), не больше maxBytes (≤ 50 МБ). Только для брошенных файлов. */
export async function readDroppedFile(path: string, maxBytes?: number): Promise<Uint8Array> {
  const b64: string = await invoke('read_file', { path, maxBytes });
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Текст брошенного файла (UTF-8), не больше maxChars символов. */
export const readDroppedText = (path: string, maxChars?: number): Promise<{ text: string; truncated: boolean; size: number }> =>
  invoke('read_text', { path, maxChars });

/** «Показать в папке»: Проводник с выделенным файлом. */
export async function revealPath(path: string): Promise<void> {
  if (kind === 'desktop') await invoke('reveal_path', { path });
}

/** «Открыть»: файл в программе по умолчанию. */
export async function openPath(path: string): Promise<void> {
  if (kind === 'desktop') await invoke('open_path', { path });
}

// ---------- Локальный ИИ (Ollama, LM Studio) через Rust ----------
// fetch из WebView упирается в COEP/смешанное содержимое; Rust ходит сам,
// только на этот компьютер и в домашнюю сеть (src-tauri/src/localhttp.rs).

/** Есть ли Rust-прокси (ПК и телефон в приложении; в браузере — нет). */
export const hasLocalHttp = (): boolean => !!T;

/** Запрос целиком: { status, body }. */
export function localHttp(method: 'GET' | 'POST' | 'DELETE', url: string, body?: string): Promise<{ status: number; body: string }> {
  return invoke('local_http', { method, url, body });
}

/**
 * Потоковый запрос: onText получает куски ответа (как пришли по сети).
 * Промис завершается статусом; signal.abort() останавливает запрос.
 */
export async function localHttpStream(method: 'GET' | 'POST', url: string, body: string | undefined, onText: (piece: string) => void, signal?: AbortSignal): Promise<number> {
  let id = -1;
  const early: { id: number; text: string }[] = [];
  let finish: (st: number) => void = () => {};
  let fail: (e: Error) => void = () => {};
  const done = new Promise<number>((res, rej) => {
    finish = res;
    fail = rej;
  });
  let doneEarly: { id: number; status: number; error?: string | null } | null = null;
  const settle = (d: { status: number; error?: string | null }) => (d.error ? fail(new Error(d.error)) : finish(d.status));
  const un1 = await T.event.listen('local-http-chunk', (e: any) => {
    if (id < 0) early.push(e.payload);
    else if (e.payload.id === id) onText(e.payload.text);
  });
  const un2 = await T.event.listen('local-http-done', (e: any) => {
    if (id < 0) doneEarly = e.payload;
    else if (e.payload.id === id) settle(e.payload);
  });
  try {
    id = await invoke('local_http_stream', { method, url, body });
    for (const c of early) if (c.id === id) onText(c.text);
    const de = doneEarly as { id: number; status: number; error?: string | null } | null;
    if (de && de.id === id) settle(de);
    const stop = () => void invoke('local_http_cancel', { id }).catch(() => {});
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }
    return await done;
  } finally {
    un1?.();
    un2?.();
  }
}
export const petDrag = () => invoke('pet_drag').catch(() => {});
export const cursorRel = (): Promise<[number, number] | null> => invoke('cursor_rel').catch(() => null);

// ---------- Музыка (Windows) ----------

export interface Media {
  title: string;
  artist: string;
  app: string;
  playing: boolean;
}

export async function mediaInfo(): Promise<Media | null> {
  if (kind !== 'desktop') return null;
  const raw: string = await invoke('media_info');
  return raw && raw !== 'null' ? (JSON.parse(raw) as Media) : null;
}
export const mediaThumb = (): Promise<string> => (kind === 'desktop' ? invoke('media_thumb') : Promise.resolve(''));
export const mediaControl = (action: 'toggle' | 'next' | 'prev') => invoke('media_control', { action });

// ---------- Claude Code ----------

export async function claudeInfo(): Promise<{ exe: string; settings: string; exists: boolean } | null> {
  if (kind !== 'desktop') return null;
  return JSON.parse(await invoke('claude_info'));
}
export const claudeRead = (): Promise<string> => invoke('claude_read');
export const claudeWrite = (json: string): Promise<string> => invoke('claude_write', { json });

// ---------- Отпечаток пальца (телефон) ----------

/** true — подтверждено; если биометрии нет на устройстве — тоже true (подтверждение кнопкой). */
export async function biometric(reason: string): Promise<boolean> {
  if (kind !== 'android') return true;
  const b = T?.biometric ?? (globalThis as any).__TAURI_PLUGIN_BIOMETRIC__;
  try {
    if (b?.authenticate) {
      await b.authenticate(reason, { allowDeviceCredential: true, title: 'Тук', subtitle: reason });
      return true;
    }
    await invoke('plugin:biometric|authenticate', { reason, allowDeviceCredential: true });
    return true;
  } catch (e) {
    return /not ?available|no biometric|not enrolled|NoHardware|unavailable/i.test(String((e as Error)?.message ?? e));
  }
}

export async function quit(): Promise<void> {
  if (T) await invoke('quit_app');
}

// ---------------- Остров (Android) ----------------

export interface IslandArgs {
  mood?: string;
  text?: string;
  badge?: number;
  data?: string;
  frames?: number;
  fps?: number;
  show?: boolean;
  wake?: boolean;
}

/** Остров поверх приложений: check | grant | config | download | update | sprite | look | consume | back. */
export async function island(action: string, args: IslandArgs = {}): Promise<any> {
  if (kind !== 'android') return null;
  return invoke('plugin:tuk|island', { action, ...args });
}

// ---------------- Голос ----------------

/** Можно ли говорить с Туком голосом на этом устройстве (ПК — когда скачано распознавание). */
export function canListen(): boolean {
  return kind === 'android' || (kind === 'desktop' && pcVoiceReady);
}

/** Распознать фразу (Android: системный распознаватель; ПК: Vosk офлайн). */
export async function hear(): Promise<string> {
  if (kind === 'desktop') return pcHear();
  if (kind !== 'android') throw new Error('Голосовой ввод доступен в приложении');
  const r = await invoke('plugin:tuk|listen', { action: 'start' });
  return String(r?.text ?? '');
}

/** Промежуточный текст, пока человек говорит. */
export async function listenPartial(): Promise<{ text: string; listening: boolean }> {
  if (kind === 'desktop') return { text: pcPartial, listening: !!pcHearWait };
  if (kind !== 'android') return { text: '', listening: false };
  return invoke('plugin:tuk|listen', { action: 'partial' });
}

export async function listenStop(cancel = false): Promise<void> {
  if (kind === 'android') await invoke('plugin:tuk|listen', { action: cancel ? 'cancel' : 'stop' });
  else if (kind === 'desktop') {
    if (cancel && pcHearWait) {
      const w = pcHearWait;
      pcHearWait = null;
      w.fail(new Error('Отменено'));
    }
    await invoke('voice_listen', { action: cancel ? 'cancel' : 'stop' }).catch(() => {});
  }
}

/** Произнести текст; промис завершается, когда Тук договорил. */
export async function speak(text: string, voicePreset?: string): Promise<void> {
  if (kind === 'android') {
    await invoke('plugin:tuk|speak', { text, voice: voicePreset || undefined });
    return;
  }
  // ПК: живой голос (sherpa-onnx), если он скачан; иначе — голос Windows через WebView
  if (kind === 'desktop' && voicePreset) {
    const done = await invoke('voice_speak', { text, preset: voicePreset }).catch((e: unknown) => {
      console.warn('живой голос:', e);
      return false;
    });
    if (done) return;
  }
  const ss = (globalThis as any).speechSynthesis as SpeechSynthesis | undefined;
  if (!ss) return;
  ss.cancel();
  await new Promise<void>((res) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ru-RU';
    const v = ss.getVoices().find((x) => /^ru/i.test(x.lang));
    if (v) u.voice = v;
    u.onend = () => res();
    u.onerror = () => res();
    ss.speak(u);
  });
}

export async function speakStop(): Promise<void> {
  if (kind === 'android') await invoke('plugin:tuk|speak', { stop: true }).catch(() => {});
  else {
    if (kind === 'desktop') await invoke('voice_speak_stop').catch(() => {});
    (globalThis as any).speechSynthesis?.cancel();
  }
}

// ---------------- Голос на ПК: «Тук Тук» (Vosk) и живой голос (sherpa-onnx) ----------------

/** Что знает Rust про голос на ПК (src-tauri/src/voice). */
export interface PcVoiceStatus {
  libs: boolean; // библиотеки есть в сборке
  model: 'none' | 'downloading' | 'ready' | 'error'; // распознавание (~45 МБ)
  voice: 'none' | 'downloading' | 'ready' | 'error'; // живой голос выбранного пресета (~67 МБ)
  progress: number;
  error?: string | null;
  wake: boolean; // слушает «Тук Тук»
  listening: boolean; // слушает команду
}

/** Событие от распознавания: услышал «Тук Тук», говорят, команда готова, тишина, ошибка. */
export interface PcWakeEvent {
  state: 'listen' | 'partial' | 'command' | 'idle' | 'error';
  text: string;
  manual: boolean; // ответ на 🎤, а не «Тук Тук»
}

let pcVoiceReady = false;
let pcPartial = '';
let pcHearWait: { ok: (t: string) => void; fail: (e: Error) => void } | null = null;
let pcWakeCb: ((e: PcWakeEvent) => void) | null = null;
let pcListening = false;

export async function pcVoiceStatus(preset = 'tuk'): Promise<PcVoiceStatus | null> {
  if (kind !== 'desktop') return null;
  const st = (await invoke('voice_status', { preset }).catch(() => null)) as PcVoiceStatus | null;
  pcVoiceReady = !!st?.libs && st.model === 'ready';
  return st;
}

/** Скачать распознавание (`model`) или живой голос (`voice`). Прогресс — в pcVoiceStatus. */
export async function pcVoiceDownload(what: 'model' | 'voice', preset = 'tuk'): Promise<void> {
  await invoke('voice_download', { what, preset });
}

/** Включить или выключить постоянное слушание «Тук Тук». */
export async function pcWake(on: boolean): Promise<void> {
  await pcListenEvents();
  await invoke('voice_wake', { on });
}

/** Подписка на «Тук Тук» (команды, сказанные без нажатия на 🎤). */
export function onPcWake(cb: (e: PcWakeEvent) => void): void {
  pcWakeCb = cb;
  void pcListenEvents();
}

async function pcListenEvents(): Promise<void> {
  if (pcListening || kind !== 'desktop') return;
  pcListening = true;
  await listen('voice-wake', (e: PcWakeEvent) => {
    if (e.state === 'listen' || e.state === 'idle' || e.state === 'command') pcPartial = '';
    if (e.state === 'partial') pcPartial = e.text;
    // ответ на 🎤 — промису hear(), остальное — приложению
    if (e.manual && pcHearWait) {
      const w = pcHearWait;
      if (e.state === 'command') (pcHearWait = null), w.ok(e.text);
      else if (e.state === 'idle') (pcHearWait = null), w.ok('');
      else if (e.state === 'error') (pcHearWait = null), w.fail(new Error(e.text));
      return;
    }
    pcWakeCb?.(e);
  });
}

async function pcHear(): Promise<string> {
  await pcListenEvents();
  pcHearWait?.fail(new Error('Отменено'));
  pcPartial = '';
  const p = new Promise<string>((ok, fail) => (pcHearWait = { ok, fail }));
  try {
    await invoke('voice_listen', { action: 'start' });
  } catch (e) {
    pcHearWait = null;
    throw e instanceof Error ? e : new Error(String(e));
  }
  return p;
}

// ---------------- Нативный мозг, живой голос, действия (Android) ----------------

/** llama.cpp на телефоне: status | download | load | chat | poll | stop | delete. */
export async function llm(action: string, args: Record<string, unknown> = {}): Promise<any> {
  return invoke('plugin:tuk|llm', { action, ...args });
}

/** Живой голос: status | download (voice: tuk | bright | boy | calm). */
export async function voice(action: string, preset: string): Promise<{ state: string; progress?: number; error?: string } | null> {
  if (kind === 'desktop') {
    // ПК: те же голоса piper-ru, синтез sherpa-onnx в Rust (src-tauri/src/voice)
    if (action === 'download') await pcVoiceDownload('voice', preset);
    const st = await pcVoiceStatus(preset);
    if (!st?.libs) return null;
    return { state: st.voice, progress: st.progress, error: st.error ?? undefined };
  }
  if (kind !== 'android') return null;
  return invoke('plugin:tuk|voice', { action, voice: preset });
}

/** Действие на телефоне (будильник, звонок, фонарик…). */
export async function act(action: string, args: Record<string, unknown> = {}): Promise<any> {
  if (kind !== 'android') throw new Error('Это действие доступно на телефоне');
  return invoke('plugin:tuk|act', { action, ...args });
}

/** ПК: открыть сайт, файл или программу (notepad, calc, ms-settings: …). */
export async function openTarget(target: string): Promise<void> {
  if (kind === 'desktop') await invoke('open_target', { target });
  else if (kind === 'web') window.open(target, '_blank');
  else await act('url', { url: target });
}

/** Освободить место от старого мозга в WebView (раньше модель хранилась там). */
export async function clearWebModelCache(): Promise<void> {
  try {
    const root: any = await (navigator.storage as any)?.getDirectory?.();
    if (!root) return;
    for await (const [name] of root.entries()) await root.removeEntry(name, { recursive: true });
  } catch {
    /* нечего чистить */
  }
}
