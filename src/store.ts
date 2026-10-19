// Хранилище записей. Сохранение на диск делает платформа (Rust-команда или localStorage в демо).

import { type Item, newId } from './model.js';
import type { ChatMsg, ModelId } from './brain.js';

export type StoredItem = Item & { _rev?: number; _dirty?: boolean };

export interface Peer {
  id: string;
  name: string;
  lastSeen: number;
}

export interface SyncState {
  role: 'none' | 'server' | 'client';
  key?: string; // общий ключ шифрования
  // ПК (server)
  peers?: Peer[];
  // телефон (client)
  host?: string;
  port?: number;
  pcId?: string;
  pcName?: string;
  cursor?: number;
  lastSync?: number;
  lastError?: string;
}

export interface Settings {
  name: string; // как зовут помощника
  sound: boolean;
  autostart: boolean;
  sleepAfterSec: number;
  model?: ModelId; // какой мозг
  usePcBrain?: boolean; // телефон: думать на ПК, когда он рядом
  volume?: number; // 0..1
  outfit?: import('./character.js').Outfit | 'auto';
  hoodColor?: string;
  lightColor?: string;
  dance?: boolean; // танцевать под музыку
  island?: boolean; // Android: Тук над приложениями
  wake?: boolean; // Android: слушать «Тук Тук»
  voicePreset?: string; // живой голос: tuk | bright | boy | calm | '' (системный)
  voiceLoop?: boolean; // продолжать разговор голосом после ответа
  onboarded?: boolean; // первый запуск пройден (3 шага: питомец, хоткей, мозг)
  localAi?: import('./localai.js').LocalAi; // мозг из Ollama / LM Studio на этом ПК или в домашней сети
  agentAutoClean?: boolean; // убирать закончившие и зависшие сессии сами (по умолчанию да)
}

export interface Data {
  v: 1;
  deviceId: string;
  deviceName: string;
  rev: number;
  items: Record<string, StoredItem>;
  fired: Record<string, number>; // id напоминания → dueAt, о котором уже напомнили (только на этом устройстве)
  sync: SyncState;
  settings: Settings;
  chat?: ChatMsg[]; // история разговора (только на этом устройстве)
  recapSeen?: string; // неделя, сводку за которую уже показали
  webCacheCleared?: boolean; // Android: старый мозг из WebView удалён
  islandLook?: string; // для какого наряда уже отправлены кадры острова
  agentRules?: import('./agents.js').Rule[]; // «разрешать всегда»
}

export function emptyData(deviceName: string): Data {
  return {
    v: 1,
    deviceId: newId(),
    deviceName,
    rev: 0,
    items: {},
    fired: {},
    sync: { role: 'none' },
    settings: { name: 'Тук', sound: true, autostart: true, sleepAfterSec: 120 },
  };
}

export function strip(it: StoredItem): Item {
  const { _rev, _dirty, ...rest } = it;
  void _rev;
  void _dirty;
  return rest;
}

type Listener = (reason: string) => void;

export class Store {
  data: Data;
  private listeners: Listener[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(data: Data, private persist: (json: string) => Promise<void> | void) {
    this.data = data;
  }

  onChange(fn: Listener): void {
    this.listeners.push(fn);
  }

  /** Сообщить подписчикам и сохранить с задержкой. */
  changed(reason = 'edit'): void {
    for (const l of this.listeners) l(reason);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 400);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.persist(JSON.stringify(this.data));
  }

  get items(): StoredItem[] {
    return Object.values(this.data.items).filter((i) => !i.deleted);
  }

  get(id: string): StoredItem | undefined {
    const it = this.data.items[id];
    return it && !it.deleted ? it : undefined;
  }

  private touch(it: StoredItem): StoredItem {
    it.updatedAt = Math.max(Date.now(), (it.updatedAt ?? 0) + 1);
    it.origin = this.data.deviceId;
    it._rev = ++this.data.rev;
    it._dirty = true;
    return it;
  }

  add(partial: Omit<Item, 'id' | 'createdAt' | 'updatedAt' | 'origin'>): StoredItem {
    const now = Date.now();
    const it: StoredItem = { ...partial, id: newId(), createdAt: now, updatedAt: 0, origin: this.data.deviceId };
    this.touch(it);
    this.data.items[it.id] = it;
    this.changed('add');
    return it;
  }

  update(id: string, patch: Partial<Item>): StoredItem | undefined {
    const it = this.data.items[id];
    if (!it) return undefined;
    Object.assign(it, patch);
    this.touch(it);
    this.changed('update');
    return it;
  }

  remove(id: string): void {
    const it = this.data.items[id];
    if (!it) return;
    it.deleted = true;
    this.touch(it);
    this.changed('remove');
  }
}
