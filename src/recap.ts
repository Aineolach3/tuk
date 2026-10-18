// Недельная сводка: что сделано за 7 дней, здоровье, серия дней. Рисуется картинкой 1080×1920.

import { Character, HOOD_COLORS } from './character.js';
import type { StoredItem } from './store.js';

const DAY = 86_400_000;
const WD = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

export interface Recap {
  from: number;
  to: number;
  tasksDone: number;
  remindersDone: number;
  created: number;
  notes: number;
  meds: number;
  talks: number;
  busiestDay: string | null;
  busiestCount: number;
  streak: number;
  sleepAvg: number | null;
  waterAvg: number | null;
  pressureAvg: [number, number] | null;
  moodAvg: number | null;
  perDay: number[]; // сделано по дням, от старого к новому
}

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function computeRecap(items: StoredItem[], chatTimes: number[], now = Date.now()): Recap {
  const to = now;
  const from = startOfDay(now) - 6 * DAY;
  const inRange = (t?: number | null) => t != null && t >= from && t <= to;
  const live = items.filter((i) => !i.deleted);
  const done = live.filter((i) => i.done && inRange(i.doneAt));
  const health = live.filter((i) => i.kind === 'health' && inRange(i.createdAt));
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  const perDay = Array.from({ length: 7 }, (_, k) => {
    const d0 = from + k * DAY;
    return done.filter((i) => i.doneAt! >= d0 && i.doneAt! < d0 + DAY).length;
  });
  const byWd = new Map<number, number>();
  for (const i of done) byWd.set(new Date(i.doneAt!).getDay(), (byWd.get(new Date(i.doneAt!).getDay()) ?? 0) + 1);
  let busiestDay: string | null = null, busiestCount = 0;
  for (const [wd, n] of byWd) if (n > busiestCount) { busiestCount = n; busiestDay = WD[wd]; }

  // серия дней подряд (до сегодня включительно), когда что-то записано или сделано
  const active = new Set<number>();
  for (const i of live) {
    active.add(startOfDay(i.createdAt));
    if (i.doneAt) active.add(startOfDay(i.doneAt));
  }
  for (const t of chatTimes) active.add(startOfDay(t));
  let streak = 0;
  for (let d = startOfDay(now); active.has(d); d -= DAY) streak++;

  const metric = (m: string) => health.filter((h) => h.health?.metric === m);
  const water = metric('water');
  const waterDays = new Set(water.map((w) => startOfDay(w.createdAt))).size;
  const pr = metric('pressure');

  return {
    from, to,
    tasksDone: done.filter((i) => i.kind === 'task').length,
    remindersDone: done.filter((i) => i.kind === 'reminder').length,
    created: live.filter((i) => i.kind !== 'health' && inRange(i.createdAt)).length,
    notes: live.filter((i) => i.kind === 'note' && inRange(i.createdAt)).length,
    meds: metric('meds').length,
    talks: chatTimes.filter((t) => t >= from && t <= to).length,
    busiestDay, busiestCount, streak,
    sleepAvg: avg(metric('sleep').map((h) => h.health!.value)),
    waterAvg: waterDays ? water.reduce((a, w) => a + w.health!.value, 0) / waterDays : null,
    pressureAvg: pr.length ? [Math.round(avg(pr.map((p) => p.health!.value))!), Math.round(avg(pr.map((p) => p.health!.value2 ?? 0))!)] : null,
    moodAvg: avg(metric('mood').map((h) => h.health!.value)),
    perDay,
  };
}

const fmt1 = (n: number) => (Math.round(n * 10) / 10).toString().replace('.', ',');
const range = (r: Recap) => {
  const f = new Date(r.from), t = new Date(r.to);
  const o: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' };
  return `${f.toLocaleDateString('ru-RU', o)} — ${t.toLocaleDateString('ru-RU', o)}`;
};

/** Рисует карточку сводки. Возвращает canvas 1080×1920. */
export function renderRecap(r: Recap, look: { name: string; hood?: number[]; outfit?: Character['outfit'] }): HTMLCanvasElement {
  const W = 1080, H = 1920;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;

  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#1d1a28');
  bg.addColorStop(1, '#0c0b11');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  // тёплое свечение антенны
  const glow = g.createRadialGradient(W / 2, 330, 10, W / 2, 330, 520);
  glow.addColorStop(0, 'rgba(244,196,112,0.22)');
  glow.addColorStop(1, 'rgba(244,196,112,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, W, 900);

  // персонаж
  const pc = document.createElement('canvas');
  pc.width = 560;
  pc.height = 520;
  Object.defineProperty(pc, 'getBoundingClientRect', { value: () => ({ width: 560, height: 520, left: 0, top: 0 }) });
  const ch = new Character(pc, { still: true });
  ch.hood = look.hood ?? HOOD_COLORS['Чёрный'];
  if (look.outfit) ch.outfit = look.outfit;
  ch.set('happy');
  ch.draw(performance.now() + 120);
  g.drawImage(pc, (W - 560) / 2, 90, 560, 520);

  g.textAlign = 'center';
  g.fillStyle = '#f3eef8';
  g.font = '800 84px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  g.fillText('Моя неделя', W / 2, 720);
  g.fillStyle = '#9d96ab';
  g.font = '500 40px system-ui, sans-serif';
  g.fillText(range(r), W / 2, 785);

  // плитки
  const tiles: [string, string][] = [
    [String(r.tasksDone), 'дел сделано'],
    [String(r.remindersDone + r.meds), 'напоминаний выполнено'],
    [String(r.streak), r.streak === 1 ? 'день подряд с Туком' : 'дней подряд с Туком'],
    [String(r.talks), 'сообщений в разговоре'],
  ];
  const tx = 80, tw = (W - 2 * tx - 40) / 2, th = 230;
  tiles.forEach(([v, label], i) => {
    const x = tx + (i % 2) * (tw + 40), y = 860 + Math.floor(i / 2) * (th + 36);
    g.fillStyle = '#1f1c2b';
    g.beginPath();
    g.roundRect(x, y, tw, th, 36);
    g.fill();
    g.fillStyle = '#f4c470';
    g.font = '800 104px system-ui, sans-serif';
    g.fillText(v, x + tw / 2, y + 125);
    g.fillStyle = '#c9c2d6';
    g.font = '500 34px system-ui, sans-serif';
    g.fillText(label, x + tw / 2, y + 185);
  });

  // столбики по дням
  const by = 1430, bh = 150, bx = 120, bw = W - 2 * bx;
  const max = Math.max(1, ...r.perDay);
  const days = Array.from({ length: 7 }, (_, k) => new Date(r.from + k * DAY));
  r.perDay.forEach((n, k) => {
    const w = bw / 7;
    const h = Math.max(8, (n / max) * bh);
    g.fillStyle = k === 6 ? '#f4c470' : '#4a4460';
    g.beginPath();
    g.roundRect(bx + k * w + w * 0.2, by + bh - h, w * 0.6, h, 12);
    g.fill();
    g.fillStyle = '#9d96ab';
    g.font = '500 30px system-ui, sans-serif';
    g.fillText(['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][days[k].getDay()], bx + k * w + w / 2, by + bh + 46);
  });

  // здоровье и факты
  const facts: string[] = [];
  if (r.busiestDay) facts.push(`Самый продуктивный день — ${r.busiestDay}`);
  if (r.sleepAvg != null) facts.push(`Сон в среднем ${fmt1(r.sleepAvg)} ч`);
  if (r.waterAvg != null) facts.push(`Воды в день ≈ ${Math.round(r.waterAvg)} мл`);
  if (r.pressureAvg) facts.push(`Давление в среднем ${r.pressureAvg[0]}/${r.pressureAvg[1]}`);
  if (!facts.length) facts.push('Записывайте дела и здоровье — в сводке станет больше фактов');
  g.fillStyle = '#e6e0ef';
  g.font = '500 38px system-ui, sans-serif';
  facts.slice(0, 3).forEach((f, i) => g.fillText(f, W / 2, 1700 + i * 56));

  g.fillStyle = '#5f5873';
  g.font = '500 28px system-ui, sans-serif';
  g.fillText('Тук · всё хранится только на ваших устройствах', W / 2, H - 50);
  return c;
}
