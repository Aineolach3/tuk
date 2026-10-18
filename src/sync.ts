// Протокол синхронизации ПК ↔ телефон.
// ПК — сервер: хранит счётчик ревизий. Телефон — клиент: отправляет свои изменения
// и забирает всё, что изменилось на ПК с прошлого раза. Конфликт — побеждает более поздняя правка.

import { type Item, isNewer } from './model.js';
import { type Data, type StoredItem, strip } from './store.js';
import { decryptWith, encryptWith, keyFromPin } from './crypto.js';

export const PROTO = 1;
export const SYNC_PORT = 47800;

export interface SyncRequest {
  from: string;
  name: string;
  since: number;
  changes: Item[];
}
export interface SyncResponse {
  rev: number;
  serverId: string;
  serverName: string;
  changes: Item[];
}

/** Применить чужие записи. Возвращает число реально изменённых. */
export function applyRemote(data: Data, incoming: Item[]): number {
  let n = 0;
  for (const inc of incoming) {
    if (!inc || typeof inc.id !== 'string') continue;
    const local = data.items[inc.id];
    if (local && !isNewer(inc, local)) continue;
    const it: StoredItem = { ...inc, _rev: ++data.rev, _dirty: false };
    data.items[inc.id] = it;
    n++;
  }
  return n;
}

// ---------- ПК ----------

export function serverHandle(data: Data, req: SyncRequest): { resp: SyncResponse; changed: number } {
  const received = new Map(req.changes.map((c) => [c.id, c.updatedAt]));
  const changed = applyRemote(data, req.changes);
  const out: Item[] = [];
  for (const it of Object.values(data.items)) {
    if ((it._rev ?? 0) <= req.since) continue;
    // не отправлять обратно то, что телефон только что прислал
    if (received.get(it.id) === it.updatedAt && it.origin === req.from) continue;
    out.push(strip(it));
  }
  const peers = (data.sync.peers ??= []);
  const p = peers.find((x) => x.id === req.from);
  if (p) {
    p.lastSeen = Date.now();
    p.name = req.name;
  } else peers.push({ id: req.from, name: req.name, lastSeen: Date.now() });
  return { resp: { rev: data.rev, serverId: data.deviceId, serverName: data.deviceName, changes: out }, changed };
}

// ---------- Телефон ----------

export function clientRequest(data: Data): SyncRequest {
  const changes = Object.values(data.items)
    .filter((i) => i._dirty)
    .map(strip);
  return { from: data.deviceId, name: data.deviceName, since: data.sync.cursor ?? 0, changes };
}

export function clientApply(data: Data, sent: SyncRequest, resp: SyncResponse): number {
  const changed = applyRemote(data, resp.changes);
  for (const s of sent.changes) {
    const local = data.items[s.id];
    if (local && local.updatedAt === s.updatedAt) local._dirty = false;
  }
  data.sync.cursor = resp.rev;
  data.sync.lastSync = Date.now();
  data.sync.lastError = undefined;
  data.sync.pcId = resp.serverId;
  data.sync.pcName = resp.serverName;
  return changed;
}

// ---------- Конверты (то, что идёт по сети) ----------

export interface Envelope {
  v: number;
  d: string; // id устройства-отправителя (открыто, чтобы сервер знал, кто это)
  c: string; // зашифрованное содержимое
}

export async function seal(key: string, from: string, payload: unknown): Promise<string> {
  const env: Envelope = { v: PROTO, d: from, c: await encryptWith(key, JSON.stringify(payload)) };
  return JSON.stringify(env);
}

export async function open<T>(key: string, body: string): Promise<{ from: string; payload: T }> {
  const env = JSON.parse(body) as Envelope;
  if (env.v !== PROTO) throw new Error('Разные версии приложения на ПК и телефоне');
  return { from: env.d, payload: JSON.parse(await decryptWith(key, env.c)) as T };
}

// ---------- Код для QR ----------

export interface PairCode {
  h: string; // IP ПК
  p: number; // порт
  k: string; // ключ
  d: string; // id ПК
  n: string; // имя ПК
}

export function makePairCode(c: PairCode): string {
  return 'TUK1:' + btoa(unescape(encodeURIComponent(JSON.stringify(c))));
}

export function readPairCode(s: string): PairCode | null {
  const t = s.trim();
  if (!t.startsWith('TUK1:')) return null;
  try {
    const c = JSON.parse(decodeURIComponent(escape(atob(t.slice(5))))) as PairCode;
    if (!c.h || !c.k || !c.d) return null;
    return { ...c, p: c.p || SYNC_PORT };
  } catch {
    return null;
  }
}

// ---------- Сопряжение по PIN ----------

export interface PinHello {
  t: number;
  d: string;
  n: string;
}
export interface PinGrant {
  key: string;
  pcId: string;
  pcName: string;
}

export async function pinRequest(pin: string, pcId: string, me: { id: string; name: string }): Promise<string> {
  const k = await keyFromPin(pin, pcId);
  return seal(k, me.id, { t: Date.now(), d: me.id, n: me.name } satisfies PinHello);
}

/** ПК: проверить PIN-запрос и выдать ключ. Бросает исключение при неверном PIN. */
export async function pinAnswer(pin: string, data: Data, body: string): Promise<string> {
  const k = await keyFromPin(pin, data.deviceId);
  const { payload } = await open<PinHello>(k, body);
  if (Math.abs(Date.now() - payload.t) > 5 * 60_000) throw new Error('Просроченный запрос');
  const grant: PinGrant = { key: data.sync.key!, pcId: data.deviceId, pcName: data.deviceName };
  return seal(k, data.deviceId, grant);
}

export async function pinAccept(pin: string, pcId: string, body: string): Promise<PinGrant> {
  const k = await keyFromPin(pin, pcId);
  return (await open<PinGrant>(k, body)).payload;
}
