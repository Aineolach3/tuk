// Напоминания: когда сработать, просрочки, отложить, расписание на Android.

import type { Item } from './model.js';
import { nextOccurrence } from './parser.js';
import type { Store, StoredItem } from './store.js';
import * as P from './platform.js';

export const OVERDUE_ANGRY_MS = 10 * 60_000;

/** Момент, когда напоминание должно сработать с учётом «отложить». */
export function effectiveDue(store: Store, it: Item): number | null {
  if (it.kind !== 'reminder' || it.done || it.dueAt == null) return null;
  const snoozed = snoozeMap(store)[it.id];
  return snoozed && snoozed > (it.dueAt ?? 0) ? snoozed : it.dueAt;
}

function snoozeMap(store: Store): Record<string, number> {
  const d = store.data as unknown as { snoozed?: Record<string, number> };
  return (d.snoozed ??= {});
}

export function activeReminders(store: Store): StoredItem[] {
  return store.items.filter((i) => i.kind === 'reminder' && !i.done && i.dueAt != null);
}

/** Сработавшие и ещё не закрытые. */
export function ringing(store: Store, now = Date.now()): StoredItem[] {
  return activeReminders(store)
    .filter((i) => (effectiveDue(store, i) ?? Infinity) <= now)
    .sort((a, b) => (effectiveDue(store, a) ?? 0) - (effectiveDue(store, b) ?? 0));
}

export function isAngry(store: Store, now = Date.now()): boolean {
  return ringing(store, now).some((i) => now - (effectiveDue(store, i) ?? now) > OVERDUE_ANGRY_MS);
}

/** Какие напоминания нужно показать прямо сейчас (ещё не показывали). */
export function dueToFire(store: Store, now = Date.now()): StoredItem[] {
  const fired = store.data.fired;
  return ringing(store, now).filter((i) => fired[i.id] !== effectiveDue(store, i));
}

export function markFired(store: Store, it: Item): void {
  store.data.fired[it.id] = effectiveDue(store, it) ?? 0;
}

/** «Готово»: разовое закрываем, повторяющееся переносим на следующий раз. */
export function complete(store: Store, id: string): StoredItem | undefined {
  const it = store.get(id);
  if (!it) return;
  delete snoozeMap(store)[id];
  if (it.kind === 'reminder' && it.repeat && it.dueAt != null) {
    const next = nextOccurrence(it.dueAt, it.repeat, Date.now(), it.dueAt);
    return store.update(id, { dueAt: next });
  }
  return store.update(id, { done: true, doneAt: Date.now() });
}

export function snooze(store: Store, id: string, minutes: number): void {
  const it = store.get(id);
  if (!it) return;
  const until = Date.now() + minutes * 60_000;
  if (it.repeat) {
    // у повторяющихся не трогаем расписание, откладываем только на этом устройстве
    snoozeMap(store)[id] = until;
    store.changed('snooze');
  } else store.update(id, { dueAt: until });
}

// ---------- Android: системные уведомления по расписанию ----------

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 1) || 1;
}

type Sched = Record<string, { sig: string; ids: number[] }>;
function schedMap(store: Store): Sched {
  const d = store.data as unknown as { androidScheduled?: Sched };
  return (d.androidScheduled ??= {});
}

export async function syncAndroidSchedule(store: Store): Promise<void> {
  if (P.kind !== 'android') return;
  const scheduled = schedMap(store);
  const now = Date.now();
  const want = new Map<string, StoredItem>();
  for (const it of activeReminders(store)) {
    const due = effectiveDue(store, it)!;
    if (due > now || it.repeat) want.set(it.id, it);
  }
  const sigOf = (it: StoredItem) => `${effectiveDue(store, it)}|${it.repeat}|${it.text}`;
  // отменить лишние и изменившиеся
  for (const id of Object.keys(scheduled)) {
    const it = want.get(id);
    if (!it || sigOf(it) !== scheduled[id].sig) {
      await P.cancelNotifications(scheduled[id].ids);
      delete scheduled[id];
    }
  }
  // поставить новые
  for (const [id, it] of want) {
    if (scheduled[id]) continue;
    const due = effectiveDue(store, it)!;
    const ids: number[] = [];
    if (it.repeat === 'weekdays') {
      // пять еженедельных уведомлений: пн–пт
      for (let wd = 1; wd <= 5; wd++) {
        const d = new Date(due);
        d.setDate(d.getDate() + ((wd - d.getDay() + 7) % 7));
        const nid = hash32(id + ':' + wd);
        ids.push(nid);
        await P.scheduleNotification(nid, store.data.settings.name, it.text, d.getTime(), 'weekly');
      }
    } else {
      const nid = hash32(id);
      ids.push(nid);
      await P.scheduleNotification(nid, store.data.settings.name, it.text, due, it.repeat ?? null);
    }
    scheduled[id] = { sig: sigOf(it), ids };
  }
}
