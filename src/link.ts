// Связь ПК ↔ телефон. ПК всегда сервер, телефон — клиент.

import * as P from './platform.js';
import type { Store } from './store.js';
import { randomKey, randomPin } from './crypto.js';
import type { ChatMsg } from './brain.js';
import {
  SYNC_PORT, clientApply, clientRequest, makePairCode, open, pinAccept, pinAnswer, pinRequest,
  readPairCode, seal, serverHandle, type SyncRequest, type SyncResponse,
} from './sync.js';

export type LinkStatus = { state: 'off' | 'ok' | 'syncing' | 'error'; text: string };

export class Link {
  status: LinkStatus = { state: 'off', text: 'Не связан' };
  pin: { code: string; until: number; attempts: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  onStatus: (s: LinkStatus) => void = () => {};
  onRemoteChange: (n: number) => void = () => {};
  /** ПК: ответить телефону своим мозгом (null — мозг не готов). */
  chatHandler: ((messages: ChatMsg[]) => Promise<string>) | null = null;
  /** ПК: события хуков Claude Code (только с этого компьютера — проверяет Rust). */
  hookHandler: ((reqId: number, body: string) => void) | null = null;
  /** ПК: состояние агентов для телефона и решение по разрешению. */
  agentsHandler: (() => unknown) | null = null;
  decideHandler: ((reqId: number, d: 'allow' | 'deny' | 'always') => boolean) | null = null;

  constructor(private store: Store) {}

  private set(s: LinkStatus) {
    this.status = s;
    this.onStatus(s);
  }

  // ================= ПК =================

  async startServer(): Promise<void> {
    const d = this.store.data;
    if (!d.sync.key) {
      d.sync = { role: 'server', key: randomKey(), peers: [] };
      this.store.changed('link');
    }
    d.sync.role = 'server';
    await P.listen('sync-request', (payload: string) => this.handle(JSON.parse(payload)));
    await P.startServer(SYNC_PORT, `TUK1|${d.deviceId}|${SYNC_PORT}|${d.deviceName}`);
    this.refreshServerStatus();
    setInterval(() => this.refreshServerStatus(), 30_000);
  }

  refreshServerStatus(): void {
    const peers = this.store.data.sync.peers ?? [];
    if (!peers.length) return this.set({ state: 'off', text: 'Телефон не подключён' });
    const last = Math.max(...peers.map((p) => p.lastSeen));
    const fresh = Date.now() - last < 2 * 60_000;
    const names = [...new Set(peers.map((p) => p.name))];
    const who = names.length === 1 && peers.length > 1 ? `${names[0]} ×${peers.length}` : names.join(', ');
    this.set({ state: fresh ? 'ok' : 'off', text: `${who} · ${ago(last)}` });
  }

  private async handle(req: P.SyncRequestEvent): Promise<void> {
    const d = this.store.data;
    try {
      if (req.path === '/hello') {
        return P.serverReply(req.id, 200, JSON.stringify({ app: 'tuk', id: d.deviceId, name: d.deviceName }));
      }
      if (req.path === '/sync') {
        const { payload } = await open<SyncRequest>(d.sync.key!, req.body);
        const { resp, changed } = serverHandle(d, payload);
        if (changed) this.onRemoteChange(changed);
        this.store.changed('sync');
        this.refreshServerStatus();
        return P.serverReply(req.id, 200, await seal(d.sync.key!, d.deviceId, resp));
      }
      if (req.path === '/hook') {
        if (!this.hookHandler) return P.serverReply(req.id, 200, '');
        return this.hookHandler(req.id, req.body); // ответит сам, когда будет решение
      }
      if (req.path === '/agents') {
        await open(d.sync.key!, req.body);
        return P.serverReply(req.id, 200, await seal(d.sync.key!, d.deviceId, this.agentsHandler?.() ?? { sessions: [], pending: [] }));
      }
      if (req.path === '/agent-decide') {
        const { payload } = await open<{ reqId: number; d: 'allow' | 'deny' | 'always' }>(d.sync.key!, req.body);
        const ok = this.decideHandler?.(payload.reqId, payload.d) ?? false;
        return P.serverReply(req.id, 200, await seal(d.sync.key!, d.deviceId, { ok }));
      }
      if (req.path === '/chat') {
        const { payload } = await open<{ messages: ChatMsg[] }>(d.sync.key!, req.body);
        if (!this.chatHandler) return P.serverReply(req.id, 503, 'Мозг на ПК не загружен');
        try {
          const text = await this.chatHandler(payload.messages);
          return P.serverReply(req.id, 200, await seal(d.sync.key!, d.deviceId, { text }));
        } catch (e) {
          return P.serverReply(req.id, 503, String((e as Error).message ?? e));
        }
      }
      if (req.path === '/pair') {
        const pin = this.pin;
        if (!pin || Date.now() > pin.until || pin.attempts >= 5) return P.serverReply(req.id, 403, 'Код не активен');
        try {
          const answer = await pinAnswer(pin.code, d, req.body);
          this.pin = null;
          return P.serverReply(req.id, 200, answer);
        } catch {
          pin.attempts++;
          return P.serverReply(req.id, 403, 'Неверный код');
        }
      }
      return P.serverReply(req.id, 404, 'Нет такого адреса');
    } catch (e) {
      return P.serverReply(req.id, 400, String((e as Error).message ?? e));
    }
  }

  async pairCode(): Promise<string> {
    const d = this.store.data;
    const ip = await P.localIp();
    return makePairCode({ h: ip, p: SYNC_PORT, k: d.sync.key!, d: d.deviceId, n: d.deviceName });
  }

  startPin(): string {
    this.pin = { code: randomPin(), until: Date.now() + 3 * 60_000, attempts: 0 };
    return this.pin.code;
  }

  /** Новый ключ: все связанные устройства придётся связать заново. */
  resetKey(): void {
    this.store.data.sync = { role: 'server', key: randomKey(), peers: [] };
    this.store.changed('link');
    this.refreshServerStatus();
  }

  // ================= Телефон =================

  startClient(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.syncNow(), 20_000);
    this.store.onChange((reason) => {
      if (reason === 'sync' || reason === 'link' || reason === 'snooze') return;
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.syncNow(), 1500);
    });
    document.addEventListener('visibilitychange', () => !document.hidden && this.syncNow());
    void this.syncNow();
  }

  get linked(): boolean {
    const s = this.store.data.sync;
    return s.role === 'client' && !!s.key && !!s.host;
  }

  async syncNow(): Promise<void> {
    if (!this.linked || this.busy) {
      if (!this.linked) this.set({ state: 'off', text: 'Не связан с ПК' });
      return;
    }
    this.busy = true;
    const d = this.store.data;
    const s = d.sync;
    this.set({ state: 'syncing', text: 'Синхронизация…' });
    try {
      const req = clientRequest(d);
      let body: string;
      try {
        body = await P.httpPost(s.host!, s.port ?? SYNC_PORT, '/sync', await seal(s.key!, d.deviceId, req));
      } catch (e) {
        // ПК мог сменить адрес — ищем его по сети
        const found = (await P.discover(2500)).find((f) => f.id === s.pcId);
        if (!found) throw e;
        s.host = found.ip;
        s.port = found.port;
        body = await P.httpPost(s.host, s.port, '/sync', await seal(s.key!, d.deviceId, req));
      }
      const { payload } = await open<SyncResponse>(s.key!, body);
      const changed = clientApply(d, req, payload);
      this.store.changed('sync');
      if (changed) this.onRemoteChange(changed);
      this.set({ state: 'ok', text: `${s.pcName ?? 'ПК'} · только что` });
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      s.lastError = msg;
      const when = s.lastSync ? ` · было ${ago(s.lastSync)}` : '';
      this.set({ state: 'error', text: `ПК не отвечает${when}` });
    } finally {
      this.busy = false;
    }
  }

  /** Телефон: спросить мозг ПК. Бросает исключение, если ПК недоступен или мозг там не загружен. */
  async askPc(messages: ChatMsg[]): Promise<string> {
    if (!this.linked) throw new Error('Телефон не связан с ПК');
    const d = this.store.data;
    const s = d.sync;
    const body = await P.httpPost(s.host!, s.port ?? SYNC_PORT, '/chat', await seal(s.key!, d.deviceId, { messages }));
    const { payload } = await open<{ text: string }>(s.key!, body);
    return payload.text;
  }

  /** Телефон: что делают агенты на ПК. */
  async askAgents<T>(): Promise<T> {
    const d = this.store.data, s = d.sync;
    const body = await P.httpPost(s.host!, s.port ?? SYNC_PORT, '/agents', await seal(s.key!, d.deviceId, {}));
    return (await open<T>(s.key!, body)).payload;
  }

  async sendDecision(reqId: number, dec: 'allow' | 'deny' | 'always'): Promise<boolean> {
    const d = this.store.data, s = d.sync;
    const body = await P.httpPost(s.host!, s.port ?? SYNC_PORT, '/agent-decide', await seal(s.key!, d.deviceId, { reqId, d: dec }));
    return (await open<{ ok: boolean }>(s.key!, body)).payload.ok;
  }

  async pairByCode(code: string): Promise<void> {
    const c = readPairCode(code);
    if (!c) throw new Error('Это не код связи с ПК');
    this.store.data.sync = { role: 'client', key: c.k, host: c.h, port: c.p, pcId: c.d, pcName: c.n, cursor: 0 };
    this.markAllDirty();
    this.store.changed('link');
    await this.syncNow();
    if (this.status.state === 'error') throw new Error(`Код принят, но ПК по адресу ${c.h} не отвечает. Проверьте, что ПК и телефон в одной сети Wi-Fi.`);
  }

  async pairByPin(host: string, port: number, pin: string): Promise<void> {
    const d = this.store.data;
    const hello = JSON.parse(await P.httpPost(host, port, '/hello', '{}')) as { id: string; name: string };
    const req = await pinRequest(pin, hello.id, { id: d.deviceId, name: d.deviceName });
    let answer: string;
    try {
      answer = await P.httpPost(host, port, '/pair', req);
    } catch (e) {
      throw new Error(/403/.test(String(e)) ? 'Неверный или устаревший код' : String((e as Error).message ?? e));
    }
    const grant = await pinAccept(pin, hello.id, answer);
    d.sync = { role: 'client', key: grant.key, host, port, pcId: grant.pcId, pcName: grant.pcName, cursor: 0 };
    this.markAllDirty();
    this.store.changed('link');
    await this.syncNow();
  }

  unlink(): void {
    this.store.data.sync = { role: 'none' };
    this.store.changed('link');
    this.set({ state: 'off', text: 'Не связан с ПК' });
  }

  /** При первой связи отправить на ПК всё, что уже есть на телефоне. */
  private markAllDirty(): void {
    for (const it of Object.values(this.store.data.items)) it._dirty = true;
  }
}

export function ago(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'только что';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}
