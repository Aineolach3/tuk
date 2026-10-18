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
  if (kind === 'desktop') await invoke('set_mode', { mode }).catch(() => {});
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
}

/** Остров поверх приложений: check | grant | start | stop | update | sprite | consume | back. */
export async function island(action: string, args: IslandArgs = {}): Promise<any> {
  if (kind !== 'android') return null;
  return invoke('plugin:tuk|island', { action, ...args });
}

// ---------------- Голос ----------------

/** Можно ли говорить с Туком голосом на этом устройстве. */
export function canListen(): boolean {
  return kind === 'android';
}

/** Распознать фразу (Android: системный распознаватель, по возможности офлайн). */
export async function hear(): Promise<string> {
  if (kind !== 'android') throw new Error('Голосовой ввод на ПК появится в следующей версии');
  const r = await invoke('plugin:tuk|listen', { action: 'start' });
  return String(r?.text ?? '');
}

/** Промежуточный текст, пока человек говорит. */
export async function listenPartial(): Promise<{ text: string; listening: boolean }> {
  if (kind !== 'android') return { text: '', listening: false };
  return invoke('plugin:tuk|listen', { action: 'partial' });
}

export async function listenStop(cancel = false): Promise<void> {
  if (kind === 'android') await invoke('plugin:tuk|listen', { action: cancel ? 'cancel' : 'stop' });
}

/** Произнести текст; промис завершается, когда Тук договорил. */
export async function speak(text: string): Promise<void> {
  if (kind === 'android') {
    await invoke('plugin:tuk|speak', { text });
    return;
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
  else (globalThis as any).speechSynthesis?.cancel();
}
