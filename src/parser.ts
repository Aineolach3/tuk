// Разбор русских фраз без нейросети: правила и регулярные выражения.
// «напомни завтра в 9 позвонить поставщику» → напоминание на завтра 9:00.

import type { Metric, Repeat } from './model.js';

export type Parsed =
  | { type: 'reminder'; text: string; dueAt: number; repeat: Repeat | null; tag?: string }
  | { type: 'task'; text: string; dueAt: number | null; allDay: boolean; reason?: 'no-time'; explicit?: boolean }
  | { type: 'note'; text: string }
  | { type: 'health'; records: { metric: Metric; value: number; value2?: number; unit: string }[]; text: string }
  | { type: 'done'; query: string }
  | { type: 'delete'; query: string }
  | { type: 'query'; what: 'today' | 'tasks' | 'reminders' | 'health' | 'notes' }
  | { type: 'greet' }
  | { type: 'help' }
  | { type: 'empty' };

// В JS \b не работает с кириллицей, поэтому границы слов — через lookbehind/lookahead.
const L = '(?<![\\p{L}\\d])';
const R = '(?![\\p{L}\\d])';
function rx(src: string, flags = 'iu'): RegExp {
  return new RegExp(src.replaceAll('‹', L).replaceAll('›', R), flags);
}

const NUM_WORDS: Record<string, number> = {
  одну: 1, один: 1, одна: 1, две: 2, два: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7,
  восемь: 8, девять: 9, десять: 10, пятнадцать: 15, двадцать: 20, тридцать: 30, сорок: 40,
  пятьдесят: 50, полтора: 1.5, полторы: 1.5,
};
const NUM_WORD_SRC = Object.keys(NUM_WORDS).join('|');

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS: [string, number][] = [
  ['понедельник', 1], ['вторник', 2], ['сред', 3], ['четверг', 4], ['пятниц', 5], ['суббот', 6], ['воскресень', 0],
];
function weekdayOf(word: string): number {
  for (const [stem, d] of WEEKDAYS) if (word.startsWith(stem)) return d;
  return -1;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Убирает кавычки, лишние пробелы и точку в конце; регистр не трогает. */
export function prep(s: string): string {
  return s
    .replace(/[«»"“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?…]+$/u, '');
}

/** Нижний регистр и «е» вместо «ё» — без изменения длины строки. */
function lower(s: string): string {
  const l = s.toLowerCase().replaceAll('ё', 'е');
  return l.length === s.length ? l : s;
}

export function normalize(s: string): string {
  return lower(prep(s));
}

/** Заменяет совпадение пробелами той же длины, чтобы позиции в исходном тексте сохранились. */
function blank(s: string, re: RegExp): string {
  const m = s.match(re);
  if (!m || m.index === undefined) return s;
  return s.slice(0, m.index) + ' '.repeat(m[0].length) + s.slice(m.index + m[0].length);
}

/** Собирает текст из исходника (с заглавными буквами) по маске вырезанных мест. */
function restore(masked: string, original: string): string {
  let out = '';
  for (let i = 0; i < masked.length; i++) out += masked[i] === ' ' ? ' ' : original[i];
  return out.replace(/\s+/g, ' ').trim();
}

function toNum(s: string): number {
  if (s in NUM_WORDS) return NUM_WORDS[s];
  return parseFloat(s.replace(',', '.'));
}

function atTime(base: Date, h: number, m: number): Date {
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}
function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export interface When {
  date: Date | null;
  hasTime: boolean;
  repeat: Repeat | null;
  rest: string;
}

/** Достаёт из фразы дату, время и повтор; возвращает остаток текста. */
export function extractWhen(input: string, now: Date, original = input): When {
  let s = ' ' + input + ' ';
  const orig = ' ' + original + ' ';
  const cut = (re: RegExp, fn: (m: RegExpMatchArray) => void): boolean => {
    const m = s.match(re);
    if (!m || m.index === undefined) return false;
    fn(m);
    s = s.slice(0, m.index) + ' '.repeat(m[0].length) + s.slice(m.index + m[0].length);
    return true;
  };

  let repeat: Repeat | null = null;
  let repeatWeekday = -1;
  let defaultHour = 9;
  let dayOffset: number | null = null;
  let weekday = -1;
  let nextWeek = false;
  let exact: Date | null = null; // конкретная дата без времени
  let h: number | null = null;
  let mnt = 0;
  let suffix = '';
  let partOfDay: number | null = null;
  let relative: { n: number; unit: 'min' | 'hour' | 'day' | 'week' | 'month' } | null = null;

  // --- Повторы ---
  cut(rx('‹(?:каждый|каждые)\\s+(?:день|сутки)›|‹ежедневно›'), () => (repeat = 'daily'));
  if (!repeat) cut(rx('‹каждое\\s+утро›'), () => { repeat = 'daily'; defaultHour = 9; });
  if (!repeat) cut(rx('‹каждый\\s+вечер›'), () => { repeat = 'daily'; defaultHour = 20; });
  if (!repeat) cut(rx('‹(?:по\\s+будням|в\\s+будни|каждый\\s+будний\\s+день)›'), () => (repeat = 'weekdays'));
  if (!repeat) cut(rx('‹(?:каждую\\s+неделю|еженедельно)›'), () => (repeat = 'weekly'));
  if (!repeat)
    cut(rx('‹(?:каждый|каждую|каждое|по)\\s+(понедельник\\p{L}*|вторник\\p{L}*|сред\\p{L}*|четверг\\p{L}*|пятниц\\p{L}*|суббот\\p{L}*|воскресень\\p{L}*)›'), (m) => {
      repeat = 'weekly';
      repeatWeekday = weekdayOf(m[1]);
    });
  if (!repeat) cut(rx('‹(?:каждый\\s+час|ежечасно)›'), () => (repeat = 'hourly'));

  // --- Относительное время: «через 10 минут», «через полчаса» ---
  cut(rx('‹через\\s+(полчаса|пол\\s?часа)›'), () => (relative = { n: 30, unit: 'min' }));
  if (!relative)
    cut(
      rx(`‹через\\s+(?:(\\d+(?:[.,]\\d+)?|${NUM_WORD_SRC})\\s*)?(мин\\p{L}*|м|час\\p{L}*|ч|дн\\p{L}*|день|сутки|сут\\p{L}*|недел\\p{L}*|месяц\\p{L}*)›`),
      (m) => {
        const n = m[1] ? toNum(m[1]) : 1;
        const u = m[2];
        const unit = u.startsWith('м') && !u.startsWith('мес') ? 'min'
          : u.startsWith('ч') ? 'hour'
          : u.startsWith('нед') ? 'week'
          : u.startsWith('мес') ? 'month'
          : 'day';
        relative = { n, unit };
      },
    );

  // --- Время суток ---
  const UNITS_AFTER = '(?!\\s*(?:кг|мл|л|%|раз|шаг|лет|год|мм|см|м|км|руб|р|шт|°|градус|стакан|таблет|минут\\s+(?:ходьб|бега)))';
  cut(rx('‹(?:в|к|на)\\s+(\\d{1,2})[:.](\\d{2})(?:\\s*(утра|дня|вечера|ночи))?›'), (m) => {
    h = +m[1]; mnt = +m[2]; suffix = m[3] ?? '';
  });
  if (h === null)
    cut(rx(`‹(?:в|к)\\s+(\\d{1,2})(?:\\s*ч(?:ас(?:а|ов)?)?\\.?)?(?:\\s+(\\d{1,2})\\s*мин\\p{L}*)?(?:\\s*(утра|дня|вечера|ночи))?›${UNITS_AFTER}`), (m) => {
      h = +m[1]; mnt = m[2] ? +m[2] : 0; suffix = m[3] ?? '';
    });
  if (h === null)
    cut(rx('‹(\\d{1,2}):(\\d{2})(?:\\s*(утра|дня|вечера|ночи))?›'), (m) => {
      h = +m[1]; mnt = +m[2]; suffix = m[3] ?? '';
    });
  if (h === null) cut(rx('‹в\\s+полдень›'), () => { h = 12; mnt = 0; });
  if (h === null) cut(rx('‹в\\s+полночь›'), () => { h = 0; mnt = 0; suffix = 'ночи'; });
  if (h !== null) {
    let hh: number = h;
    if (suffix === 'дня' && hh < 12) hh += 12;
    if (suffix === 'вечера' && hh < 12) hh += 12;
    if (suffix === 'ночи' && hh >= 9 && hh < 12) hh += 12;
    if (suffix === 'утра' && hh === 12) hh = 0;
    if (hh > 23 || mnt > 59) { h = null; } else h = hh;
  }
  if (h === null) {
    cut(rx('‹(?:утром|с\\s+утра|поутру)›'), () => (partOfDay = 9));
    if (partOfDay === null) cut(rx('‹(?:днем|в\\s+обед)›'), () => (partOfDay = 13));
    if (partOfDay === null) cut(rx('‹вечером›'), () => (partOfDay = 19));
    if (partOfDay === null) cut(rx('‹ночью›'), () => (partOfDay = 23));
  }

  // --- День ---
  if (!cut(rx('‹послезавтра›'), () => (dayOffset = 2)))
    if (!cut(rx('‹завтра›'), () => (dayOffset = 1)))
      cut(rx('‹сегодня›'), () => (dayOffset = 0));

  cut(rx('‹(?:в|во)\\s+(?:(эт[уио]\\p{L}*|следующ\\p{L}*|ближайш\\p{L}*)\\s+)?(понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)›'), (m) => {
    weekday = weekdayOf(m[2]);
    nextWeek = !!m[1] && m[1].startsWith('след');
  });

  cut(rx(`‹(\\d{1,2})\\s+(${MONTHS.join('|')})(?:\\s+(\\d{4}))?(?:\\s*г(?:ода|\\.)?)?›`), (m) => {
    const day = +m[1];
    const mon = MONTHS.indexOf(m[2]);
    const year = m[3] ? +m[3] : now.getFullYear();
    let d = new Date(year, mon, day);
    if (!m[3] && startOfDay(d) < startOfDay(now)) d = new Date(year + 1, mon, day);
    exact = d;
  });
  if (!exact)
    cut(rx('‹(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{2}|\\d{4}))?›'), (m) => {
      const day = +m[1];
      const mon = +m[2] - 1;
      if (mon < 0 || mon > 11 || day < 1 || day > 31) return;
      let year = m[3] ? +m[3] : now.getFullYear();
      if (year < 100) year += 2000;
      let d = new Date(year, mon, day);
      if (!m[3] && startOfDay(d) < startOfDay(now)) d = new Date(year + 1, mon, day);
      exact = d;
    });
  if (!exact)
    cut(rx('‹(\\d{1,2})(?:-?(?:го|е))?\\s+числа›'), (m) => {
      const day = +m[1];
      let d = new Date(now.getFullYear(), now.getMonth(), day);
      if (startOfDay(d) < startOfDay(now)) d = new Date(now.getFullYear(), now.getMonth() + 1, day);
      exact = d;
    });

  const rest = restore(s, orig.length === s.length ? orig : s);

  // --- Сборка даты ---
  const hasClock = h !== null || partOfDay !== null;
  const hour = h ?? partOfDay ?? defaultHour;
  let date: Date | null = null;
  const rel = relative as { n: number; unit: 'min' | 'hour' | 'day' | 'week' | 'month' } | null;

  if (rel) {
    const n = rel.n;
    if (rel.unit === 'min') date = new Date(now.getTime() + Math.round(n * MIN));
    else if (rel.unit === 'hour') date = new Date(now.getTime() + Math.round(n * HOUR));
    else {
      const days = rel.unit === 'day' ? n : rel.unit === 'week' ? n * 7 : 0;
      let d = rel.unit === 'month' ? new Date(now.getFullYear(), now.getMonth() + Math.round(n), now.getDate()) : addDays(now, Math.round(days));
      d = hasClock ? atTime(d, hour, mnt) : atTime(d, now.getHours(), now.getMinutes());
      date = d;
    }
    return { date, hasTime: true, repeat, rest };
  }

  const exactDate = exact as Date | null;
  if (exactDate) {
    date = atTime(exactDate, hour, mnt);
  } else if (dayOffset !== null) {
    date = atTime(addDays(now, dayOffset), hour, mnt);
  } else if (weekday >= 0 || repeatWeekday >= 0) {
    const wd = weekday >= 0 ? weekday : repeatWeekday;
    let diff = (wd - now.getDay() + 7) % 7;
    if (nextWeek && weekday >= 0) {
      // «в следующую пятницу» — пятница следующей календарной недели (неделя с понедельника)
      const toMonday = (8 - now.getDay()) % 7 || 7;
      diff = toMonday + ((wd + 6) % 7);
    }
    let d = atTime(addDays(now, diff), hour, mnt);
    if (d.getTime() <= now.getTime() && (hasClock || diff > 0 || repeat)) d = addDays(d, 7);
    date = d;
  } else if (hasClock) {
    let d = atTime(now, hour, mnt);
    if (d.getTime() <= now.getTime()) {
      // «в 6», сказанное в 15:00, скорее всего значит 18:00
      const pm = atTime(now, hour + 12, mnt);
      if (h !== null && !suffix && !repeat && hour >= 1 && hour < 12 && pm.getTime() > now.getTime()) d = pm;
      else d = addDays(d, 1);
    }
    date = d;
  } else if (repeat === 'hourly') {
    const d = new Date(now);
    d.setMinutes(0, 0, 0);
    date = new Date(d.getTime() + HOUR);
  } else if (repeat) {
    let d = atTime(now, defaultHour, 0);
    if (d.getTime() <= now.getTime()) d = addDays(d, 1);
    date = d;
  }

  if (date && repeat) date = new Date(nextOccurrence(date.getTime() - 1, repeat, now.getTime() - 1, date.getTime()));
  return { date, hasTime: hasClock || !!repeat, repeat, rest };
}

/** Следующий момент повтора после `after`. `first` — исходное время (берём из него часы и минуты). */
export function nextOccurrence(from: number, repeat: Repeat, after: number, first = from): number {
  const base = new Date(first);
  let t = first;
  const step = (d: number) => {
    const x = new Date(t);
    x.setDate(x.getDate() + d);
    x.setHours(base.getHours(), base.getMinutes(), 0, 0);
    return x.getTime();
  };
  let guard = 0;
  while ((t <= after || (repeat === 'weekdays' && isWeekend(t))) && guard++ < 2000) {
    if (repeat === 'hourly') t += HOUR;
    else if (repeat === 'daily') t = step(1);
    else if (repeat === 'weekly') t = step(7);
    else t = step(1);
  }
  void from;
  return t;
}
function isWeekend(t: number): boolean {
  const d = new Date(t).getDay();
  return d === 0 || d === 6;
}

// ---------------- Команды ----------------

const REMINDER_TRIGGER = rx('^(?:пожалуйста\\s+)?(?:напомни(?:те)?|напомнить|напоминание|поставь\\s+напоминание|создай\\s+напоминание|не\\s+дай\\s+(?:мне\\s+)?забыть|разбуди(?:\\s+меня)?|будильник)›[:,]?');
const TASK_TRIGGER = rx('^(?:запиши(?:те)?|записать|добавь(?:те)?(?:\\s+(?:задачу|в\\s+задачи|в\\s+список))?|задача|новая\\s+задача|надо|нужно|не\\s+забыть)›[:,]?');
const NOTE_TRIGGER = rx('^(?:заметка|запомни|мысль|идея|записка)›[:,]?');
const DONE_TRIGGER = rx('^(?:сделал[аи]?|сделано|готово|выполнил[аи]?|выполнено|закрой|отметь|вычеркни)›[:,]?\\s*');
const DELETE_TRIGGER = rx('^(?:удали(?:ть)?|убери|отмени)›[:,]?\\s*');

function cleanText(s: string): string {
  let t = s.replace(rx('‹пожалуйста›'), ' ').replace(/\s+/g, ' ').trim();
  const lead = rx('^(?:напомни(?:те)?(?:\\s+мне)?|напомнить|мне|нам|нужно|надо|необходимо|что|о\\s+том,?\\s+что|о\\s+том,?\\s+чтобы|чтобы|чтоб|про|о|об|насчет|что\\s+надо|что\\s+нужно)›[,:]?\\s*');
  for (let i = 0; i < 4; i++) t = t.replace(lead, '');
  t = t.replace(/^[,:;\-–—\s]+|[,:;\-–—\s]+$/g, '').replace(/\s+([,.])/g, '$1');
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

function parseHealth(s: string): { metric: Metric; value: number; value2?: number; unit: string }[] {
  const out: { metric: Metric; value: number; value2?: number; unit: string }[] = [];
  const num = (x: string) => parseFloat(x.replace(',', '.'));
  let m = s.match(rx('(?:‹давлени\\p{L}*\\s*|^)(\\d{2,3})\\s*(?:/|\\\\|на|-|\\s)\\s*(\\d{2,3})›'));
  if (m && (/давлен/.test(s) || /^\d{2,3}\s*(\/|на)\s*\d{2,3}/.test(s))) {
    const a = +m[1], b = +m[2];
    if (a >= 60 && a <= 260 && b >= 30 && b <= 180) out.push({ metric: 'pressure', value: Math.max(a, b), value2: Math.min(a, b), unit: 'мм рт. ст.' });
  }
  if ((m = s.match(rx('‹пульс\\p{L}*\\s*(\\d{2,3})›')))) out.push({ metric: 'pulse', value: +m[1], unit: 'уд/мин' });
  if ((m = s.match(rx('‹температур\\p{L}*\\s*(\\d{2}(?:[.,]\\d{1,2})?)›')))) out.push({ metric: 'temp', value: num(m[1]), unit: '°C' });
  if ((m = s.match(rx('‹(?:вес|вешу|взвесил\\p{L}*)\\s*(\\d{2,3}(?:[.,]\\d{1,2})?)\\s*(?:кг)?›')))) out.push({ metric: 'weight', value: num(m[1]), unit: 'кг' });
  if ((m = s.match(rx('‹(?:сон|спал[аи]?|поспал[аи]?)\\s*(\\d{1,2}(?:[.,]\\d)?)\\s*(?:ч|час\\p{L}*)?(?:\\s*(\\d{1,2})\\s*мин\\p{L}*)?›')))) {
    const v = num(m[1]) + (m[2] ? +m[2] / 60 : 0);
    if (v > 0 && v <= 24) out.push({ metric: 'sleep', value: Math.round(v * 10) / 10, unit: 'ч' });
  }
  if ((m = s.match(rx('‹(?:вод[аыу]|выпил[аи]?(?:\\s+воды)?)\\s*(\\d+(?:[.,]\\d+)?)\\s*(мл|л|литр\\p{L}*|стакан\\p{L}*)?(?:\\s+воды)?›'))) && /вод|выпил/.test(s)) {
    const unit = m[2] ?? 'мл';
    let ml = num(m[1]);
    if (unit.startsWith('л')) ml *= 1000;
    else if (unit.startsWith('стакан')) ml *= 250;
    else if (!m[2] && ml < 10) ml *= 250; // «вода 2» — скорее стаканы
    if (/вод/.test(s) || m[2]) out.push({ metric: 'water', value: Math.round(ml), unit: 'мл' });
  } else if (rx('‹выпил[аи]?\\s+(?:стакан|кружку|чашку)\\s+воды›').test(s)) {
    out.push({ metric: 'water', value: 250, unit: 'мл' });
  }
  if ((m = s.match(rx('‹(\\d{3,6})\\s*шаг\\p{L}*›')))) out.push({ metric: 'steps', value: +m[1], unit: 'шагов' });
  if ((m = s.match(rx('‹(?:самочувствие|настроение|чувствую\\s+себя|состояние)›\\s*(?:—|-|:)?\\s*(.*)$')))) {
    const t = m[1];
    let v = 0;
    const n = t.match(/([1-5])(?:\s*из\s*5)?/);
    if (n) v = +n[1];
    else if (/отличн|супер|прекрасн/.test(t)) v = 5;
    else if (/хорош/.test(t)) v = 4;
    else if (/нормальн|норм|средн|ничего/.test(t)) v = 3;
    else if (/так себе|не очень|плохо/.test(t)) v = 2;
    else if (/ужасн|очень плохо|отвратит/.test(t)) v = 1;
    if (/очень плохо/.test(t)) v = 1;
    if (v) out.push({ metric: 'mood', value: v, unit: '' });
  }
  if (rx('‹(?:принял[аи]?|выпил[аи]?)\\s+(?:таблетк\\p{L}*|лекарств\\p{L}*|витамин\\p{L}*|капли|таблетки)›').test(s)) out.push({ metric: 'meds', value: 1, unit: '' });
  return out;
}

export function parse(input: string, now: Date = new Date()): Parsed {
  const o = prep(input);
  const s = lower(o);
  if (!s) return { type: 'empty' };

  if (/^(привет|здравствуй|здравствуйте|добрый (день|вечер)|доброе утро|хай|ку-?ку)/.test(s)) return { type: 'greet' };
  if (/^(помощь|помоги|что ты умеешь|как тобой пользоваться|справка)/.test(s)) return { type: 'help' };

  // Запросы
  if (/^(что (у меня )?(на сегодня|сегодня)|план на сегодня|сегодня$|что по плану|что дальше)/.test(s)) return { type: 'query', what: 'today' };
  if (/^(покажи |список |мои )?(задачи|список задач|дела)$/.test(s)) return { type: 'query', what: 'tasks' };
  if (/^(покажи |мои )?напоминания$/.test(s)) return { type: 'query', what: 'reminders' };
  if (/^(покажи |мое |моё )?(здоровье|давление|показатели)$/.test(s)) return { type: 'query', what: 'health' };
  if (/^(покажи |мои )?заметки$/.test(s)) return { type: 'query', what: 'notes' };

  // Напоминания
  const isRem = REMINDER_TRIGGER.test(s);
  if (isRem) {
    const body = blank(s, REMINDER_TRIGGER);
    const w = extractWhen(body, now, o);
    const text = cleanText(w.rest);
    const tag = /таблет|лекарств|витамин|капл|давлен|укол/.test(text.toLowerCase()) ? 'здоровье' : undefined;
    if (w.date && w.hasTime) return { type: 'reminder', text: text || 'Напоминание', dueAt: w.date.getTime(), repeat: w.repeat, tag };
    if (w.date) {
      // День назван, время нет: на сегодня — через час, на другой день — в 9:00
      let due = w.date.getTime();
      if (due <= now.getTime()) due = Math.ceil((now.getTime() + HOUR) / (5 * MIN)) * 5 * MIN;
      return { type: 'reminder', text: text || 'Напоминание', dueAt: due, repeat: w.repeat, tag };
    }
    return { type: 'task', text: text || 'Без названия', dueAt: null, allDay: false, reason: 'no-time', explicit: true };
  }

  if (DONE_TRIGGER.test(s)) return { type: 'done', query: s.replace(DONE_TRIGGER, '').trim() };
  if (DELETE_TRIGGER.test(s)) return { type: 'delete', query: s.replace(DELETE_TRIGGER, '').trim() };

  if (NOTE_TRIGGER.test(s)) return { type: 'note', text: cleanText(input.trim().replace(rx('^(?:заметка|запомни|мысль|идея|записка)›[:,]?', 'iu'), '')) };

  // Здоровье
  const health = parseHealth(s);
  if (health.length) return { type: 'health', records: health, text: input.trim() };

  // Задача или напоминание по наличию времени
  const explicit = TASK_TRIGGER.test(s);
  const body = blank(s, TASK_TRIGGER);
  const w = extractWhen(body, now, o);
  const text = cleanText(w.rest);
  if (w.date && w.hasTime) {
    const tag = /таблет|лекарств|витамин|капл|укол/.test(text.toLowerCase()) ? 'здоровье' : undefined;
    return { type: 'reminder', text: text || 'Напоминание', dueAt: w.date.getTime(), repeat: w.repeat, tag };
  }
  if (w.date) return { type: 'task', text: text || 'Без названия', dueAt: startOfDay(w.date).getTime(), allDay: true, explicit: true };
  return { type: 'task', text: cleanText(restore(body, o)) || 'Без названия', dueAt: null, allDay: false, explicit };
}

// ---------------- Форматирование ----------------

const WD_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MON_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

export function fmtTime(t: number): string {
  const d = new Date(t);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtDay(t: number, now = new Date()): string {
  const d = startOfDay(new Date(t)).getTime();
  const today = startOfDay(now).getTime();
  const diff = Math.round((d - today) / DAY);
  if (diff === 0) return 'сегодня';
  if (diff === 1) return 'завтра';
  if (diff === 2) return 'послезавтра';
  if (diff === -1) return 'вчера';
  const x = new Date(t);
  const base = `${WD_SHORT[x.getDay()]}, ${x.getDate()} ${MON_SHORT[x.getMonth()]}`;
  return x.getFullYear() !== now.getFullYear() ? `${base} ${x.getFullYear()}` : base;
}

export function fmtWhen(t: number, allDay = false, now = new Date()): string {
  return allDay ? fmtDay(t, now) : `${fmtDay(t, now)} в ${fmtTime(t)}`;
}

export const REPEAT_LABEL: Record<Repeat, string> = {
  hourly: 'каждый час',
  daily: 'каждый день',
  weekdays: 'по будням',
  weekly: 'каждую неделю',
};
