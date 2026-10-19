// «Кто рядом»: другие Туки в той же локальной сети (UDP-broadcast, порт 47802 — src-tauri/src/net.rs).
// Только с согласия: настройка «Показываться рядом» выключена по умолчанию. В пакете — ничего
// о человеке: случайный id (новый при каждом включении), метка «свои устройства» (хэш общего
// ключа связи, меняется каждый час — чужим ничего не говорит), выбранное имя, цвет капюшона и наряд.
//
// Пакет: TUKN1|вид|id|группа|кому|капюшон|наряд|имя, вид — here | hi | bye.
// Rust проверяет и фильтрует пакеты сам; здесь та же проверка ещё раз (и для тестов).

import { Character, HOOD_COLORS, type Mood, type Outfit } from './character.js';

export const NEAR_TAG = 'TUKN1';
/** Сколько ждать следующего «я здесь» (маяк — раз в 4 с), прежде чем убрать соседа. */
export const NEAR_TTL = 15_000;
/** Не чаще одного «привета» одному соседу за столько мс. */
export const HI_COOLDOWN = 5_000;
export const NAME_MAX = 24;

export type NearKind = 'here' | 'hi' | 'bye';

export interface NearPacket {
  kind: NearKind;
  id: string;
  group: string;
  to: string;
  hood: string;
  outfit: string;
  name: string;
}

export interface NearPeer {
  id: string;
  name: string;
  hood: string;
  outfit: string;
  ip: string;
  first: number;
  seen: number;
}

const TOKEN = /^[A-Za-z0-9_-]*$/;

/** Имя для показа соседям: без управляющих символов и «|», не длиннее 24. Пусто — «Тук». */
export function cleanName(s: string): string {
  const t = [...String(s ?? '').replace(/[\u0000-\u001f\u007f|]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, NAME_MAX).join('').trim();
  return t || 'Тук';
}

/** Собрать пакет. Поля чистятся, чтобы Rust его принял. */
export function packet(p: NearPacket): string {
  const tok = (s: string, n: number) => (TOKEN.test(s) ? s.slice(0, n) : '');
  const hood = /^[\p{L} -]{0,20}$/u.test(p.hood) ? p.hood : '';
  return [NEAR_TAG, p.kind, tok(p.id, 32), tok(p.group, 32), tok(p.to, 32), hood, tok(p.outfit, 16), cleanName(p.name)].join('|');
}

/** Разбор пакета (строка или JSON от Rust). Всё подозрительное — null. */
export function parsePacket(raw: string): NearPacket | null {
  if (typeof raw !== 'string' || raw.length > 400) return null;
  let f: NearPacket;
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      f = { kind: j.kind, id: j.id, group: j.group ?? '', to: j.to ?? '', hood: j.hood ?? '', outfit: j.outfit ?? '', name: j.name };
    } catch {
      return null;
    }
  } else {
    const parts = raw.split('|');
    if (parts.length !== 8 || parts[0] !== NEAR_TAG) return null;
    const [, kind, id, group, to, hood, outfit, name] = parts;
    f = { kind: kind as NearKind, id, group, to, hood, outfit, name };
  }
  if (!['here', 'hi', 'bye'].includes(f.kind)) return null;
  for (const [v, n] of [[f.id, 32], [f.group, 32], [f.to, 32], [f.outfit, 16]] as [unknown, number][])
    if (typeof v !== 'string' || v.length > n || !TOKEN.test(v)) return null;
  if (f.id.length < 8 || (f.kind === 'hi' && !f.to)) return null;
  if (typeof f.hood !== 'string' || !/^[\p{L} -]{0,20}$/u.test(f.hood)) return null;
  if (typeof f.name !== 'string') return null;
  const name = f.name.trim();
  if (!name || [...name].length > NAME_MAX || /[\u0000-\u001f\u007f|]/.test(name)) return null;
  return { ...f, name };
}

/** Случайный id на время, пока «рядом» включено. */
export function nearId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Метка «свои устройства» на час `hour` (номер часа от 1970): 12 hex от SHA-256(ключ связи). */
export async function groupToken(key: string | undefined, hour: number): Promise<string> {
  if (!key) return '';
  const data = new TextEncoder().encode(`tuk-near:${key}:${hour}`);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...h.slice(0, 6)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Метки своих устройств: этот час и соседние (часы на ПК и телефоне могут разойтись). */
export async function myGroups(key: string | undefined, now = Date.now()): Promise<string[]> {
  if (!key) return [];
  const h = Math.floor(now / 3_600_000);
  return Promise.all([h - 1, h, h + 1].map((x) => groupToken(key, x)));
}

export type NearEvent = { type: 'new' | 'hi' | 'bye'; peer: NearPeer } | null;

/** Список соседей. Без DOM и Tauri — проверяется тестами. */
export class NearList {
  peers = new Map<string, NearPeer>();
  private lastHi = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  /**
   * Пакет от сети. myId — свой id (свои пакеты и чужие «приветы» мимо),
   * groups — метки своих устройств (свой телефон / ПК в списке не показываем).
   */
  handle(raw: string, myId: string, groups: string[], ip = ''): NearEvent {
    const p = parsePacket(raw);
    if (!p || p.id === myId) return null;
    if (p.group && groups.includes(p.group)) return null;
    if (p.kind === 'hi' && p.to !== myId) return null;
    const t = this.now();
    if (p.kind === 'bye') {
      const peer = this.peers.get(p.id);
      if (!peer) return null;
      this.peers.delete(p.id);
      return { type: 'bye', peer };
    }
    let peer = this.peers.get(p.id);
    const fresh = !peer;
    if (!peer) {
      // не больше 12 соседей: в большой сети показываем первых
      if (this.peers.size >= 12) return null;
      peer = { id: p.id, name: p.name, hood: p.hood, outfit: p.outfit, ip, first: t, seen: t };
      this.peers.set(p.id, peer);
    }
    Object.assign(peer, { name: p.name, hood: p.hood, outfit: p.outfit, seen: t, ...(ip ? { ip } : {}) });
    if (p.kind === 'hi') {
      const last = this.lastHi.get(p.id) ?? -Infinity;
      if (t - last < HI_COOLDOWN) return fresh ? { type: 'new', peer } : null;
      this.lastHi.set(p.id, t);
      return { type: 'hi', peer };
    }
    return fresh ? { type: 'new', peer } : null;
  }

  /** Можно ли сейчас отправить «привет» этому соседу (и отметить, что отправили). */
  canGreet(id: string): boolean {
    const t = this.now();
    const k = 'out:' + id;
    if (!this.peers.has(id) || t - (this.lastHi.get(k) ?? -Infinity) < HI_COOLDOWN) return false;
    this.lastHi.set(k, t);
    return true;
  }

  /** Убрать тех, кто давно молчит. Возвращает убранных. */
  sweep(): NearPeer[] {
    const t = this.now();
    const gone: NearPeer[] = [];
    for (const p of [...this.peers.values()])
      if (t - p.seen > NEAR_TTL) {
        this.peers.delete(p.id);
        gone.push(p);
      }
    return gone;
  }

  clear(): void {
    this.peers.clear();
    this.lastHi.clear();
  }

  get list(): NearPeer[] {
    return [...this.peers.values()].sort((a, b) => a.first - b.first);
  }
}

// ---------- Связь с Rust (команды nearby_set / nearby_send, событие nearby) ----------
// Сетевой код общий для ПК и Android (src-tauri/src/net.rs), поэтому протокол одинаковый.

/* eslint-disable @typescript-eslint/no-explicit-any */
const TAURI = (): any => (globalThis as any).__TAURI__;

export interface NearLook {
  name: string;
  hood: string;
  outfit: string;
}

export class Nearby {
  readonly list = new NearList();
  id = '';
  private groups: string[] = [];
  private groupsAt = 0;
  private unlisten: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Новый сосед, «привет» от соседа, сосед ушёл. */
  onEvent: (e: NonNullable<NearEvent>) => void = () => {};
  onChange: () => void = () => {};

  constructor(private key: () => string | undefined) {}

  get on(): boolean {
    return !!this.id;
  }

  static available(): boolean {
    return !!TAURI()?.core?.invoke;
  }

  private async refreshGroups(): Promise<void> {
    if (Date.now() - this.groupsAt < 600_000) return;
    this.groupsAt = Date.now();
    this.groups = await myGroups(this.key());
  }

  private async here(look: NearLook): Promise<string> {
    await this.refreshGroups();
    // в свой пакет — метка этого часа (у своих устройств она совпадёт с одной из трёх)
    const group = this.key() ? await groupToken(this.key(), Math.floor(Date.now() / 3_600_000)) : '';
    return packet({ kind: 'here', id: this.id, group, to: '', ...look });
  }

  /** Включить или обновить имя/наряд. */
  async start(look: NearLook): Promise<void> {
    const T = TAURI();
    if (!T) return;
    if (!this.id) this.id = nearId();
    if (!this.unlisten) {
      this.unlisten = await T.event.listen('nearby', (e: any) => {
        let ip = '';
        try {
          ip = String(JSON.parse(e.payload).ip ?? '');
        } catch {
          /* не JSON — разбор ниже отбросит */
        }
        const ev = this.list.handle(String(e.payload), this.id, this.groups, ip);
        if (ev) this.onEvent(ev);
        this.onChange();
      });
    }
    try {
      await T.core.invoke('nearby_set', { packet: await this.here(look) });
    } catch (e) {
      await this.stop();
      throw e;
    }
    this.timer ??= setInterval(async () => {
      const gone = this.list.sweep();
      for (const peer of gone) this.onEvent({ type: 'bye', peer });
      if (gone.length) this.onChange();
      // метка своих устройств меняется раз в час — обновим свой пакет
      if (Date.now() - this.groupsAt >= 600_000) await T.core.invoke('nearby_set', { packet: await this.here(look) }).catch(() => {});
    }, 3000);
  }

  async stop(): Promise<void> {
    const T = TAURI();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unlisten?.();
    this.unlisten = null;
    this.id = '';
    this.list.clear();
    this.onChange();
    await T?.core.invoke('nearby_set', { packet: null }).catch(() => {});
  }

  /** «Привет» соседу. false — рано (не чаще раза в 5 с) или соседа уже нет. */
  async greet(peerId: string, look: NearLook): Promise<boolean> {
    const T = TAURI();
    if (!T || !this.id || !this.list.canGreet(peerId)) return false;
    await T.core.invoke('nearby_send', { packet: packet({ kind: 'hi', id: this.id, group: '', to: peerId, ...look }) });
    return true;
  }
}

// ---------- Полоска соседей на острове ----------


const OUTFITS = new Set(['none', 'scarf', 'santa', 'glasses', 'headphones', 'pumpkin', 'flowers', 'bowtie', 'crown']);
const escN = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Маленькие Туки соседей в строке острова (после текста). Картинки неподвижные;
 * на «привет» конкретный сосед на 2,5 с оживает и машет. Клик — отправить «привет».
 */
export class NearStrip {
  private el: HTMLElement | null = null;
  private live = new Map<string, { ch: Character; until: ReturnType<typeof setTimeout> }>();

  constructor(private host: () => HTMLElement | null) {}

  private draw(c: HTMLCanvasElement, p: NearPeer, mood: Mood = 'idle'): Character {
    const ch = new Character(c, { still: true });
    ch.hood = HOOD_COLORS[p.hood] ?? HOOD_COLORS['Чёрный'];
    ch.outfit = (OUTFITS.has(p.outfit) ? p.outfit : 'none') as Outfit;
    ch.set(mood);
    ch.draw(performance.now());
    return ch;
  }

  render(peers: NearPeer[]): void {
    const host = this.host();
    if (!host) return;
    if (!peers.length) {
      this.el?.remove();
      this.el = null;
      return;
    }
    if (!this.el || !this.el.isConnected) {
      this.el = document.createElement('div');
      this.el.id = 'near-strip';
      host.after(this.el);
    }
    const key = peers.map((p) => `${p.id}:${p.name}:${p.hood}:${p.outfit}`).join(',');
    if (this.el.dataset.key === key) return;
    this.el.dataset.key = key;
    this.el.innerHTML = peers
      .slice(0, 4)
      .map((p) => `<button class="near" data-act="near-hi" data-id="${escN(p.id)}" title="${escN(p.name)} рядом — помахать"><canvas data-near="${escN(p.id)}"></canvas><span>${escN(p.name)}</span></button>`)
      .join('') + (peers.length > 4 ? `<span class="near-more">+${peers.length - 4}</span>` : '');
    for (const c of this.el.querySelectorAll<HTMLCanvasElement>('canvas[data-near]')) {
      const p = peers.find((x) => x.id === c.dataset.near);
      if (p) this.draw(c, p);
    }
    this.live.clear();
  }

  /** Сосед машет (или радуется) 2,5 с — анимированный персонаж на месте картинки. */
  animate(peer: NearPeer, mood: Mood): void {
    const c = this.el?.querySelector<HTMLCanvasElement>(`canvas[data-near="${CSS.escape(peer.id)}"]`);
    if (!c) return;
    const old = this.live.get(peer.id);
    if (old) {
      clearTimeout(old.until);
      old.ch.destroy();
    }
    const ch = new Character(c);
    ch.hood = HOOD_COLORS[peer.hood] ?? HOOD_COLORS['Чёрный'];
    ch.outfit = (OUTFITS.has(peer.outfit) ? peer.outfit : 'none') as Outfit;
    ch.set(mood);
    ch.jump();
    const until = setTimeout(() => {
      ch.destroy();
      this.live.delete(peer.id);
      if (c.isConnected) this.draw(c, peer);
    }, 2500);
    this.live.set(peer.id, { ch, until });
  }
}

/** Раздел настроек «Кто рядом». */
export function nearSettingsHtml(on: boolean, name: string, peers: NearPeer[], available: boolean): string {
  if (!available) return '';
  return `<h3>Кто рядом</h3>
    <label class="toggle"><input type="checkbox" id="set-nearby" ${on ? 'checked' : ''}> Показываться рядом</label>
    <label class="field"><span>Имя для соседей</span><input id="set-nearname" maxlength="${NAME_MAX}" value="${escN(name)}" placeholder="Тук"></label>
    <p class="muted small">Другие Туки в этой же сети Wi-Fi увидят только это имя, цвет капюшона и наряд — больше ничего. Ваши связанные устройства в списке не появляются. По умолчанию выключено.</p>
    ${on ? (peers.length ? `<ul>${peers.map((p) => `<li class="item"><span class="dot"></span><div class="body"><div class="t">${escN(p.name)}</div><div class="m">${escN(p.hood || 'Чёрный')}</div></div><button class="pill ghost small" data-act="near-hi" data-id="${escN(p.id)}">Привет 👋</button></li>`).join('')}</ul>` : '<p class="muted small">Пока никого рядом.</p>') : ''}`;
}
