// Команды-действия: будильник, таймер, звонок, сообщение, открыть приложение, фонарик,
// громкость, музыка, маршрут, поиск, календарь, заряд, время. Понимает живую речь:
// «поставь будильник на семь утра», «разбуди в половину восьмого», «позвони маме».

export type Action =
  | { kind: 'alarm'; hour: number; minute: number; days?: number[]; label?: string }
  | { kind: 'timer'; seconds: number; label?: string }
  | { kind: 'call'; who?: string; number?: string }
  | { kind: 'sms'; who?: string; number?: string; text: string }
  | { kind: 'open'; app: string }
  | { kind: 'torch'; on: boolean }
  | { kind: 'volume'; dir: 'up' | 'down' | 'mute' | 'unmute' | 'max' }
  | { kind: 'media'; key: 'play' | 'pause' | 'toggle' | 'next' | 'prev' }
  | { kind: 'navigate'; place: string }
  | { kind: 'search'; query: string }
  | { kind: 'battery' }
  | { kind: 'time' }
  | { kind: 'date' }
  | { kind: 'calendar'; title: string; at: number }
  | { kind: 'camera' }
  | { kind: 'settings'; which: 'wifi' | 'bluetooth' | 'main' | 'display' | 'sound' | 'location' }
  | { kind: 'alarmCtrl'; op: 'dismiss' | 'snooze' | 'showAlarms' | 'showTimers' }
  | { kind: 'dnd'; on: boolean }
  | { kind: 'ringer'; mode: 'silent' | 'vibrate' | 'normal' }
  | { kind: 'brightness'; dir: 'up' | 'down' | 'max' | 'min' | 'auto' }
  | { kind: 'rotate'; lock: boolean }
  | { kind: 'stop' };

// ---------- Числа словами → цифры ----------

const UNITS: Record<string, number> = {
  ноль: 0, один: 1, одна: 1, одну: 1, одного: 1, два: 2, две: 2, двух: 2, три: 3, трех: 3, четыре: 4, четырех: 4,
  пять: 5, пяти: 5, шесть: 6, шести: 6, семь: 7, семи: 7, восемь: 8, восьми: 8, девять: 9, девяти: 9,
};
const TEENS: Record<string, number> = {
  десять: 10, десяти: 10, одиннадцать: 11, одиннадцати: 11, двенадцать: 12, двенадцати: 12, тринадцать: 13, тринадцати: 13,
  четырнадцать: 14, четырнадцати: 14, пятнадцать: 15, пятнадцати: 15, шестнадцать: 16, шестнадцати: 16,
  семнадцать: 17, семнадцати: 17, восемнадцать: 18, восемнадцати: 18, девятнадцать: 19, девятнадцати: 19,
};
const TENS: Record<string, number> = {
  двадцать: 20, двадцати: 20, тридцать: 30, тридцати: 30, сорок: 40, сорока: 40, пятьдесят: 50, пятидесяти: 50,
  шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90,
};
const HUNDREDS: Record<string, number> = { сто: 100, двести: 200, триста: 300, четыреста: 400, пятьсот: 500 };

/** «двадцать пять минут» → «25 минут», «семь тридцать» → «7 30». Регистр не важен, «ё» → «е». */
export function wordsToDigits(input: string): string {
  const words = input.toLowerCase().replaceAll('ё', 'е').split(/(\s+)/);
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    let val: number | null = null;
    let j = i;
    const take = (dict: Record<string, number>) => {
      const ww = words[j];
      if (ww !== undefined && dict[ww] !== undefined) {
        val = (val ?? 0) + dict[ww];
        j += 2; // слово + пробел
        return true;
      }
      return false;
    };
    if (take(HUNDREDS)) {
      if (!take(TEENS)) {
        take(TENS);
        take(UNITS);
      }
    } else if (take(TEENS)) {
      // ok
    } else if (take(TENS)) {
      take(UNITS);
    } else take(UNITS);
    if (val !== null) {
      out.push(String(val));
      // вернуть разделитель после последнего числа
      i = j - 1;
      if (i < words.length && /^\s+$/.test(words[i] ?? '')) {
        out.push(words[i]);
        i++;
      }
      continue;
    }
    out.push(w);
    i++;
  }
  return out.join('').replace(/\s+$/, '');
}

// ---------- Время для будильника ----------

const ORD_GEN: Record<string, number> = {
  первого: 1, второго: 2, третьего: 3, четвертого: 4, пятого: 5, шестого: 6, седьмого: 7, восьмого: 8,
  девятого: 9, десятого: 10, одиннадцатого: 11, двенадцатого: 12,
};

/** Время из фразы: «7», «7:30», «7 30», «пол восьмого», «без пятнадцати 8», «в 7 вечера». */
export function parseClock(s0: string): { hour: number; minute: number } | null {
  const s = ' ' + wordsToDigits(s0) + ' ';
  let hour: number | null = null;
  let minute = 0;
  let m: RegExpMatchArray | null;
  if (/\sполдень\s|\sполдня\s/.test(s)) return { hour: 12, minute: 0 };
  if (/\sполночь\s/.test(s)) return { hour: 0, minute: 0 };
  if ((m = s.match(/(?:\sв|\sна)?\s(?:половину|пол|полвторого)\s?(\p{L}+)/u)) && ORD_GEN[m[1]]) {
    hour = ORD_GEN[m[1]] - 1;
    minute = 30;
  } else if ((m = s.match(/\sчетверть\s(\p{L}+)/u)) && ORD_GEN[m[1]]) {
    hour = ORD_GEN[m[1]] - 1;
    minute = 15;
  } else if ((m = s.match(/\sбез\s(\d{1,2}|четверти)(?:\sминут\p{L}*)?\s(\d{1,2})\s/u))) {
    const before = m[1] === 'четверти' ? 15 : +m[1];
    hour = (+m[2] + 23) % 24;
    minute = 60 - before;
  } else if ((m = s.match(/(\d{1,2})[:.](\d{2})/))) {
    hour = +m[1];
    minute = +m[2];
  } else if ((m = s.match(/(?:\sв|\sна|\sк)\s(\d{1,2})(?:\s(?:час\p{L}*))?(?:\s(\d{1,2})(?:\sмин\p{L}*)?)?(?=\s)/u))) {
    hour = +m[1];
    if (m[2] !== undefined) minute = +m[2];
  } else if ((m = s.match(/\sв\sчас\s/))) {
    hour = 1;
  } else if ((m = s.match(/\s(\d{1,2})(?:\s(\d{2}))?\s(?:утра|вечера|дня|ночи|часов|часа|час)\s/u))) {
    hour = +m[1];
    if (m[2] !== undefined) minute = +m[2];
  }
  if (hour === null || hour > 24 || minute > 59) return null;
  if (/\s(?:вечера|дня)\s/.test(s) && hour < 12) hour += 12;
  if (/\sночи\s/.test(s) && hour === 12) hour = 0;
  if (hour === 24) hour = 0;
  return { hour, minute };
}

/** Длительность: «5 минут», «полчаса», «полтора часа», «1 час 20 минут», «30 секунд». */
export function parseDuration(s0: string): number | null {
  const s = ' ' + wordsToDigits(s0).replace(/,/g, '.') + ' ';
  if (/\sполчаса\s/.test(s)) return 1800;
  if (/\sполтора\sчаса\s/.test(s)) return 5400;
  if (/\sполторы\sминуты\s/.test(s)) return 90;
  let total = 0;
  let found = false;
  for (const [re, k] of [
    [/(\d+(?:\.\d+)?)\s?(?:ч|час|часа|часов)(?=\s)/u, 3600],
    [/(\d+(?:\.\d+)?)\s?(?:мин|минуту|минуты|минут|минутку)(?=\s)/u, 60],
    [/(\d+)\s?(?:сек|секунду|секунды|секунд)(?=\s)/u, 1],
  ] as [RegExp, number][]) {
    const m = s.match(re);
    if (m) {
      total += +m[1] * k;
      found = true;
    }
  }
  if (!found) {
    if (/\sминуту\s/.test(s)) return 60;
    if (/\sчас\s/.test(s)) return 3600;
    return null;
  }
  return Math.round(total);
}

// ---------- Приложения ----------

/** Как называют приложения вслух → что искать среди названий установленных. */
export const APP_ALIASES: Record<string, string[]> = {
  telegram: ['телеграм', 'телеграмм', 'телега', 'telegram'],
  whatsapp: ['ватсап', 'вотсап', 'whatsapp', 'ватсапп'],
  youtube: ['ютуб', 'ютюб', 'youtube'],
  vk: ['вконтакте', 'вк', 'контакт'],
  camera: ['камера', 'камеру'],
  gallery: ['галерея', 'галерею', 'фото', 'фотографии'],
  settings: ['настройки'],
  maps: ['карты', 'гугл карты', 'яндекс карты'],
  calculator: ['калькулятор'],
  calendar: ['календарь'],
  clock: ['часы', 'будильник'],
  chrome: ['хром', 'браузер', 'chrome', 'интернет'],
  yandex: ['яндекс'],
  music: ['музыка', 'музыку', 'яндекс музыка', 'яндекс музыку', 'спотифай', 'spotify'],
  notes: ['заметки', 'samsung notes'],
  phone: ['телефон', 'звонилка', 'звонки'],
  messages: ['сообщения', 'смс'],
  mail: ['почта', 'почту', 'gmail', 'джимейл'],
  play: ['плей маркет', 'play маркет', 'google play', 'гугл плей', 'магазин приложений'],
  files: ['файлы', 'мои файлы', 'проводник'],
  notepad: ['блокнот'],
  ozon: ['озон', 'ozon'],
  wb: ['вайлдберриз', 'валдберис', 'wildberries'],
  sber: ['сбер', 'сбербанк', 'сбербанк онлайн'],
  tinkoff: ['тинькофф', 'тбанк', 'т-банк'],
  gosuslugi: ['госуслуги'],
  claude: ['клод', 'claude'],
};

/** Что искать в названиях установленных приложений для каждого «ключа». */
const APP_LABELS: Record<string, string[]> = {
  telegram: ['telegram', 'телеграм'], whatsapp: ['whatsapp'], youtube: ['youtube'], vk: ['вконтакте', 'vk'],
  camera: ['камера', 'camera'], gallery: ['галерея', 'gallery', 'google фото', 'photos'], settings: ['настройки', 'settings'],
  maps: ['карты', 'maps', 'навигатор'], calculator: ['калькулятор', 'calculator'], calendar: ['календарь', 'calendar'],
  clock: ['часы', 'clock'], chrome: ['chrome', 'samsung internet', 'интернет', 'браузер'], yandex: ['яндекс', 'yandex'],
  music: ['музыка', 'music', 'spotify'], notes: ['samsung notes', 'заметки', 'notes', 'keep'], phone: ['телефон', 'phone'],
  messages: ['сообщения', 'messages'], mail: ['gmail', 'почта', 'mail'], play: ['play маркет', 'play store', 'google play'],
  files: ['мои файлы', 'файлы', 'files'], notepad: ['блокнот', 'notepad'], ozon: ['ozon'], wb: ['wildberries'],
  sber: ['сбербанк', 'сбер', 'sber'], tinkoff: ['т-банк', 'тинькофф', 'tinkoff'], gosuslugi: ['госуслуги'], claude: ['claude'],
};

/** Программы и сайты на ПК для тех же «ключей». */
export const PC_TARGETS: Record<string, string> = {
  notepad: 'notepad', calculator: 'calc', files: 'explorer', settings: 'ms-settings:', chrome: 'https://ya.ru',
  youtube: 'https://www.youtube.com', telegram: 'tg://', whatsapp: 'whatsapp:', vk: 'https://vk.com', mail: 'https://mail.yandex.ru',
  maps: 'https://yandex.ru/maps', music: 'https://music.yandex.ru', yandex: 'https://ya.ru', calendar: 'outlookcal:',
  camera: 'microsoft.windows.camera:', ozon: 'https://www.ozon.ru', wb: 'https://www.wildberries.ru', gosuslugi: 'https://www.gosuslugi.ru',
  claude: 'https://claude.ai', clock: 'ms-clock:', gallery: 'ms-photos:',
};
const PC_EXTRA: [RegExp, string][] = [
  [/^(?:диспетчер\s+задач)/i, 'taskmgr'], [/^(?:пэйнт|паинт|paint)/i, 'mspaint'], [/^(?:ворд|word)/i, 'winword'],
  [/^(?:эксель|excel)/i, 'excel'], [/^(?:командн\p{L}*\s+строк\p{L}*|cmd|терминал)/iu, 'cmd'],
  [/^(?:панель\s+управления)/i, 'control'], [/^(?:загрузки)/i, 'shell:Downloads'], [/^(?:документы)/i, 'shell:Personal'],
];

function appKey(phrase: string): string | null {
  const p = phrase.toLowerCase().replaceAll('ё', 'е').trim();
  const ps = p.split(' ').map(stem).join(' ');
  for (const [key, names] of Object.entries(APP_ALIASES)) {
    for (const n of names) if (p === n || ps === n.split(' ').map(stem).join(' ')) return key;
  }
  return null;
}

/** Найти установленное приложение по названию, сказанному вслух. */
export function matchApp(phrase: string, apps: { label: string; pkg: string }[]): { label: string; pkg: string } | null {
  const key = appKey(phrase);
  const lab = (a: { label: string }) => a.label.toLowerCase().replaceAll('ё', 'е');
  if (key) {
    for (const want of APP_LABELS[key] ?? []) {
      const hit = apps.find((a) => lab(a) === want) ?? apps.find((a) => lab(a).includes(want));
      if (hit) return hit;
    }
  }
  const p = phrase.toLowerCase().replaceAll('ё', 'е').trim();
  const ps = stem(p);
  return apps.find((a) => lab(a) === p) ?? apps.find((a) => stem(lab(a)) === ps) ?? apps.find((a) => ps.length >= 3 && lab(a).startsWith(ps)) ?? null;
}

/** Что открыть на ПК по фразе: программа, сайт или null. */
export function pcTarget(phrase: string): string | null {
  const p = phrase.trim();
  const dom = p.match(/((?:https?:\/\/)?[\w-]+(?:\.[\w-]+)*\.(?:ru|com|org|net|рф|io|ai|dev|su|me|tv|info)(?:\/\S*)?)/i);
  if (dom) return /^https?:/i.test(dom[1]) ? dom[1] : 'https://' + dom[1];
  for (const [rx, t] of PC_EXTRA) if (rx.test(p)) return t;
  const key = appKey(p);
  return key ? PC_TARGETS[key] ?? null : null;
}

/** Основа слова без падежного окончания (для имён и названий). */
function stem(w: string): string {
  const s = w.toLowerCase().replaceAll('ё', 'е');
  if (s.length <= 3) return s;
  return s.replace(/(ами|ями|ого|его|ому|ему|ой|ей|ою|ею|ам|ям|ах|ях|ом|ем|ую|юю|ии|ия|ие|ья|ье|у|ю|а|я|е|и|ы|ь|й|о)$/u, '');
}

// ---------- Разбор команд ----------

const L = '(?<![\\p{L}\\d])';
const R = '(?![\\p{L}\\d])';
const re = (src: string) => new RegExp(src.replaceAll('‹', L).replaceAll('›', R), 'iu');

function clean(s: string): string {
  return s
    .replace(/[«»"“”]/g, '')
    .replace(/^[\s,.!?]+|[\s,.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Убрать вежливые и служебные слова в начале: «Тук, пожалуйста, …». */
function strip(s: string): string {
  return s
    .replace(re('^\\s*(?:тук[\\s,-]*)+'), '')
    .replace(re('‹(?:пожалуйста|будь\\s+добр|будь\\s+другом|слушай|а\\s+ну|давай|можешь|можно|ты\\s+можешь)›[,\\s]*'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseAction(input: string, now: Date = new Date()): Action | null {
  const raw = strip(clean(input));
  const s = raw.toLowerCase().replaceAll('ё', 'е');
  let m: RegExpMatchArray | null;

  // стоп — оборвать речь, ответ, музыку
  if (re('^(?:стоп|хватит|тихо|замолчи|помолчи|отмена|перестань|заткнись)$').test(s)) return { kind: 'stop' };

  // управление будильником и таймером (через приложение «Часы»)
  if (re('‹(?:будильник\\p{L}*|разбуди\\p{L}*)›').test(s) && re('‹(?:выключи|отключи|убери|сбрось|останови|отмени)›').test(s)) return { kind: 'alarmCtrl', op: 'dismiss' };
  if (re('‹(?:отложи|поспать\\s+еще|еще\\s+поспать|подремать)›').test(s) && re('‹(?:будильник\\p{L}*|разбуди\\p{L}*)›|^отложи$').test(s)) return { kind: 'alarmCtrl', op: 'snooze' };
  if (re('‹(?:таймер\\p{L}*)›').test(s) && re('‹(?:выключи|отключи|останови|сбрось|отмени|стоп)›').test(s)) return { kind: 'alarmCtrl', op: 'showTimers' };
  if (re('‹(?:покажи|открой|мои|показать)›').test(s) && re('‹будильник\\p{L}*›').test(s)) return { kind: 'alarmCtrl', op: 'showAlarms' };
  if (re('‹(?:покажи|открой|мои|показать)›').test(s) && re('‹таймер\\p{L}*›').test(s)) return { kind: 'alarmCtrl', op: 'showTimers' };

  // не беспокоить
  if (re('‹(?:не\\s+беспокоить|режим\\s+(?:сна|тишины)|ночной\\s+режим|тихий\\s+режим|дэнэдэ|dnd)›').test(s)) {
    return { kind: 'dnd', on: !re('‹(?:выключи|отключи|убери|сними|отмени)›').test(s) };
  }

  // режим звонка
  if (re('‹(?:беззвучн\\p{L}*|без\\s+звука)\\s*режим\\p{L}*›|‹(?:поставь|включи|переведи)\\s+(?:на\\s+)?беззвучн\\p{L}*›|‹режим\\s+без\\s+звука›').test(s)) return { kind: 'ringer', mode: 'silent' };
  if (re('‹(?:режим\\s+)?вибрац\\p{L}*›|‹(?:поставь|включи|переведи)\\s+(?:на\\s+)?вибр\\p{L}*›|‹(?:на\\s+)?вибро›').test(s)) return { kind: 'ringer', mode: 'vibrate' };
  if (re('‹(?:режим\\s+со\\s+звуком|включи\\s+звук\\s+звонка|обычный\\s+режим|со\\s+звуком)›').test(s)) return { kind: 'ringer', mode: 'normal' };

  // яркость
  if (re('‹яркост\\p{L}*›').test(s)) {
    if (re('‹(?:авто|автоматическ\\p{L}*|адаптивн\\p{L}*)›').test(s)) return { kind: 'brightness', dir: 'auto' };
    if (re('‹(?:на\\s+)?(?:максимум|полную|ярче\\s+всего)›|‹сделай\\s+ярче›|‹ярче›').test(s)) return { kind: 'brightness', dir: 'max' };
    if (re('‹(?:на\\s+)?минимум›|‹темнее\\s+всего›').test(s)) return { kind: 'brightness', dir: 'min' };
    if (re('‹(?:прибавь|добавь|подними|увеличь|побольше)›').test(s)) return { kind: 'brightness', dir: 'up' };
    if (re('‹(?:убавь|уменьши|сбавь|темнее|поменьше|приглуши)›').test(s)) return { kind: 'brightness', dir: 'down' };
  }
  if (re('^(?:сделай\\s+)?(?:поярче|светлее)$').test(s)) return { kind: 'brightness', dir: 'up' };
  if (re('^(?:сделай\\s+)?(?:потемнее|потусклее)$').test(s)) return { kind: 'brightness', dir: 'down' };

  // автоповорот
  if (re('‹(?:автоповорот\\p{L}*|поворот\\s+экрана|авто[\\s-]?поворот)›').test(s)) {
    return { kind: 'rotate', lock: re('‹(?:выключи|отключи|убери|зафиксируй|заблокируй)›').test(s) };
  }
  if (re('‹(?:зафиксируй|заблокируй|закрепи)\\s+(?:экран|ориентацию|поворот)›').test(s)) return { kind: 'rotate', lock: true };

  // будильник
  if (re('‹(?:будильник\\p{L}*|разбуди(?:те)?|подними\\s+меня)›').test(s) && !re('‹(?:выключи|отключи|убери|удали)›').test(s)) {
    // «будильник через 8 часов» — от текущего момента
    const rel = re('‹через›').test(s) ? parseDuration(s) : null;
    if (rel) {
      const at = new Date(now.getTime() + rel * 1000);
      return { kind: 'alarm', hour: at.getHours(), minute: at.getMinutes() };
    }
    const t = parseClock(s);
    if (t) {
      let days: number[] | undefined;
      if (re('‹(?:по\\s+будням|в\\s+будни|будние)›').test(s)) days = [2, 3, 4, 5, 6];
      else if (re('‹(?:каждый\\s+день|ежедневно)›').test(s)) days = [1, 2, 3, 4, 5, 6, 7];
      else if (re('‹(?:по\\s+выходным|в\\s+выходные)›').test(s)) days = [7, 1];
      const label = (s.match(re('‹(?:с\\s+подписью|подпиши|назови)\\s+(.+)$')) ?? [])[1];
      return { kind: 'alarm', ...t, days, label: label ? clean(label) : undefined };
    }
  }

  // таймер
  if (re('‹(?:таймер\\p{L}*|засеки|засечь|отсчитай)›').test(s)) {
    const d = parseDuration(s);
    if (d) return { kind: 'timer', seconds: d };
  }

  // звонок
  if ((m = s.match(re('^(?:позвони(?:ть|те)?|набери(?:те)?|вызови|звони|позвонить)\\s+(?:мне\\s+)?(?:на\\s+номер\\s+|по\\s+номеру\\s+)?(.+)$')))) {
    const rest = m[1].trim();
    const digits = rest.replace(/[^\d+]/g, '');
    if (digits.replace(/\D/g, '').length >= 3 && /^[\d\s+()-]+$/.test(rest)) return { kind: 'call', number: digits };
    const who = clean(rest.replace(re('‹(?:по\\s+телефону|на\\s+мобильный|на\\s+сотовый|пожалуйста)›'), ''));
    if (who) {
      const orig = raw.slice(raw.toLowerCase().replaceAll('ё', 'е').lastIndexOf(who.toLowerCase())) || who;
      return { kind: 'call', who: clean(orig.slice(0, who.length)) || who };
    }
  }

  // сообщение
  if ((m = raw.match(re('^(?:напиши|отправь|пошли|скинь)\\s+(?:смс\\s+|сообщение\\s+|эсэмэску\\s+)?(\\p{L}+(?:\\s+\\p{L}+)?)\\s*(?:,\\s*)?(?:сообщение\\s+|смс\\s+)?(?:что\\s+|чтобы\\s+|:\\s*)(.+)$')))) {
    return { kind: 'sms', who: clean(m[1]), text: clean(m[2]).replace(/^./, (c) => c.toUpperCase()) };
  }
  if ((m = raw.match(re('^(?:отправь|напиши)\\s+(?:смс|сообщение)\\s+(\\p{L}+)\\s+(.+)$')))) {
    return { kind: 'sms', who: clean(m[1]), text: clean(m[2]).replace(/^./, (c) => c.toUpperCase()) };
  }

  // фонарик
  if (re('‹(?:фонарик|фонарь|фонарика)›').test(s)) {
    return { kind: 'torch', on: !re('‹(?:выключи|отключи|погаси|убери)›').test(s) };
  }

  // громкость
  if (re('‹(?:громче|погромче|прибавь\\s+(?:звук|громкость))›').test(s)) return { kind: 'volume', dir: 'up' };
  if (re('‹(?:тише|потише|убавь\\s+(?:звук|громкость))›').test(s)) return { kind: 'volume', dir: 'down' };
  if (re('‹(?:выключи|отключи)\\s+звук›|‹без\\s+звука›|‹беззвучн\\p{L}*›').test(s)) return { kind: 'volume', dir: 'mute' };
  if (re('‹(?:включи)\\s+звук›').test(s)) return { kind: 'volume', dir: 'unmute' };
  if (re('‹(?:громкость|звук)\\s+на\\s+(?:максимум|полную)›|‹на\\s+полную\\s+громкость›').test(s)) return { kind: 'volume', dir: 'max' };

  // музыка
  if (re('^(?:следующ\\p{L}*|дальше|переключи|другую)(?:\\s+(?:трек|песн\\p{L}*|композици\\p{L}*))?$').test(s) || re('‹следующ\\p{L}*\\s+(?:трек|песн\\p{L}*)›').test(s))
    return { kind: 'media', key: 'next' };
  if (re('‹(?:предыдущ\\p{L}*|прошл\\p{L}*)\\s+(?:трек|песн\\p{L}*)›|^назад$').test(s)) return { kind: 'media', key: 'prev' };
  if (re('^(?:пауза|стоп|останови|поставь\\s+на\\s+паузу|выключи\\s+музыку|останови\\s+музыку)$').test(s)) return { kind: 'media', key: 'pause' };
  if (re('^(?:включи|запусти|играй|продолжи)\\s+(?:музыку|песню|плеер|воспроизведение)$|^продолжи$|^играй$').test(s)) return { kind: 'media', key: 'play' };

  // маршрут
  if ((m = raw.match(re('^(?:проложи\\s+маршрут|построй\\s+маршрут|маршрут|как\\s+(?:доехать|добраться|пройти|проехать)|навигатор|поехали|веди\\s+меня)\\s+(?:до|к|в|на)?\\s*(.+)$'))))
    return { kind: 'navigate', place: clean(m[1]) };

  // поиск
  if ((m = raw.match(re('^(?:найди|поищи|ищи|загугли|погугли)\\s+(?:в\\s+(?:интернете|гугле|яндексе|сети)\\s+)?(?:что\\s+такое\\s+)?(.+)$'))) && re('‹(?:интернет\\p{L}*|гугл\\p{L}*|яндекс\\p{L}*|сети|загугли|погугли)›').test(s))
    return { kind: 'search', query: clean(m[1].replace(re('‹в\\s+(?:интернете|гугле|яндексе|сети)›'), '')) };

  // заряд, время, дата
  if (re('‹(?:заряд\\p{L}*|батаре\\p{L}*|аккумулятор\\p{L}*)›').test(s) && re('‹(?:сколько|какой|какая|уровень|процент\\p{L}*)›').test(s)) return { kind: 'battery' };
  if (re('‹(?:который\\s+час|сколько\\s+(?:сейчас\\s+)?времени|какое\\s+время)›').test(s)) return { kind: 'time' };
  if (re('‹(?:какое\\s+(?:сегодня\\s+)?число|какой\\s+сегодня\\s+день|какая\\s+сегодня\\s+дата|какое\\s+сегодня)›').test(s)) return { kind: 'date' };

  // камера
  if (re('^(?:сфотографируй|сделай\\s+(?:фото|снимок|селфи)|открой\\s+камеру|включи\\s+камеру)').test(s)) return { kind: 'camera' };

  // настройки
  if (re('‹(?:настройки|включи|выключи|открой)\\s+(?:вай[\\s-]?фай|wi-?fi)›|‹вай[\\s-]?фай›').test(s)) return { kind: 'settings', which: 'wifi' };
  if (re('‹блютуз\\p{L}*|bluetooth›').test(s)) return { kind: 'settings', which: 'bluetooth' };
  if (re('‹(?:геолокаци\\p{L}*|gps|местоположени\\p{L}*)›').test(s) && re('‹(?:включи|выключи|открой|настройки)›').test(s)) return { kind: 'settings', which: 'location' };
  if (re('‹(?:яркость|экран)›').test(s) && re('‹(?:настрой\\p{L}*|открой)›').test(s)) return { kind: 'settings', which: 'display' };

  // календарь
  if ((m = raw.match(re('^(?:добавь|запиши|поставь|создай)\\s+(?:в\\s+календарь\\s+)?(?:встречу|событие|мероприятие)\\s*(.*)$'))) || (m = raw.match(re('^(?:добавь|запиши)\\s+в\\s+календарь\\s+(.+)$')))) {
    const t = parseClock(m[1]);
    const day = /завтра/i.test(m[1]) ? 1 : /послезавтра/i.test(m[1]) ? 2 : 0;
    if (t) {
      const at = new Date(now);
      at.setDate(at.getDate() + day);
      at.setHours(t.hour, t.minute, 0, 0);
      if (at.getTime() < now.getTime() && day === 0) at.setDate(at.getDate() + 1);
      const title = clean(
        wordsToDigits(m[1])
          .replace(re('‹(?:сегодня|завтра|послезавтра)›'), '')
          .replace(re('‹(?:в|на|к)\\s+\\d{1,2}(?:[:.\\s]\\d{2})?(?:\\s+(?:утра|вечера|дня|ночи|часов|часа))?›'), '')
          .replace(/^(?:на|про|по поводу)\s+/i, ''),
      );
      return { kind: 'calendar', title: title || 'Встреча', at: at.getTime() };
    }
  }

  // открыть приложение — в конце, чтобы «открой камеру» и т. п. сработали выше
  if ((m = raw.match(re('^(?:открой|запусти|включи|зайди\\s+в)\\s+(?:приложение\\s+)?(.+)$')))) {
    const app = clean(m[1]);
    if (app && !re('‹(?:музыку|свет|звук)›').test(app)) return { kind: 'open', app };
  }
  return null;
}

// ---------- Контакты ----------

export interface Contact {
  name: string;
  phones: string[];
}

/** Уменьшительные → полные имена (и наоборот). */
const NICK: Record<string, string[]> = {
  саша: ['александр', 'александра', 'шура'], женя: ['евгений', 'евгения'], дима: ['дмитрий'], миша: ['михаил'],
  коля: ['николай'], вова: ['владимир'], володя: ['владимир'], лена: ['елена'], таня: ['татьяна'], катя: ['екатерина'],
  оля: ['ольга'], наташа: ['наталья', 'наталия'], сережа: ['сергей'], леша: ['алексей'], паша: ['павел'],
  ваня: ['иван'], маша: ['мария'], настя: ['анастасия'], юля: ['юлия'], света: ['светлана'], ира: ['ирина'],
  аня: ['анна'], андрюша: ['андрей'], петя: ['петр'], костя: ['константин'], толя: ['анатолий'], гоша: ['георгий'],
  витя: ['виктор'], слава: ['вячеслав', 'ярослав', 'станислав'], валя: ['валентина', 'валентин'], галя: ['галина'],
  люба: ['любовь'], надя: ['надежда'], вера: ['вера'], рома: ['роман'], артем: ['артем'], стас: ['станислав'],
  макс: ['максим'], max: ['максим'], тема: ['артем'], даша: ['дарья'], ксюша: ['ксения'], поля: ['полина'],
  вика: ['виктория'], лиза: ['елизавета'], соня: ['софия', 'софья'], гриша: ['григорий'], леня: ['леонид'],
  боря: ['борис'], федя: ['федор'], степа: ['степан'], егор: ['егор'], илюша: ['илья'], кирюша: ['кирилл'],
};

const FAMILY: Record<string, string[]> = {
  мам: ['мама', 'мамочка', 'мамуля', 'mom', 'мать'], пап: ['папа', 'папочка', 'папуля', 'dad', 'отец'],
  бабушк: ['бабушка', 'бабуля', 'ба'], дедушк: ['дедушка', 'дедуля', 'дед'], брат: ['брат', 'братишка'],
  сестр: ['сестра', 'сестренка'], сын: ['сын', 'сынок', 'сынуля'], доч: ['дочь', 'дочка', 'доча'],
  жен: ['жена', 'любимая', 'зая'], муж: ['муж', 'любимый'],
};

function normName(s: string): string {
  return s.toLowerCase().replaceAll('ё', 'е').replace(/[^\p{L}\d\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Насколько слово запроса похоже на слово из имени контакта (0..1). */
function wordScore(q: string, c: string): number {
  if (q === c) return 1;
  const qs = stem(q), cs = stem(c);
  if (qs.length >= 2 && qs === cs) return 0.95;
  // мамочке → мама, сашеньке → саша
  const qn = qs.replace(/(очк|ечк|еньк|оньк|ушк|юшк|ул|ик)$/u, '');
  if (qn.length >= 3 && (cs === qn || cs.startsWith(qn))) return 0.85;
  if (qs.length >= 4 && cs.startsWith(qs)) return 0.8;
  if (cs.length >= 4 && qs.startsWith(cs)) return 0.75;
  return 0;
}

/** Подходящие контакты по фразе «маме», «Саше Иванову», «Дмитрию». Лучшие — первыми. */
export function matchContacts(query: string, contacts: Contact[]): { contact: Contact; score: number }[] {
  const qWords = normName(query).split(' ').filter((w) => w.length > 1);
  if (!qWords.length) return [];
  // варианты слов: само слово, полные имена по уменьшительным, семейные синонимы
  const variants = qWords.map((w) => {
    const v = new Set([w]);
    const st = stem(w);
    for (const [nick, full] of Object.entries(NICK)) {
      if (stem(nick) === st || nick === w) full.forEach((f) => v.add(f));
      if (full.some((f) => stem(f) === st)) v.add(nick);
    }
    for (const [root, syn] of Object.entries(FAMILY)) if (st.startsWith(root) || w.startsWith(root)) syn.forEach((f) => v.add(f));
    return [...v];
  });
  const res: { contact: Contact; score: number }[] = [];
  for (const c of contacts) {
    const cWords = normName(c.name).split(' ').filter(Boolean);
    if (!cWords.length || !c.phones.length) continue;
    let sum = 0;
    for (const vs of variants) {
      let best = 0;
      for (const v of vs) for (const cw of cWords) best = Math.max(best, wordScore(v, cw) * (v === vs[0] ? 1 : 0.92));
      sum += best;
    }
    const score = sum / qWords.length;
    if (score >= 0.7) res.push({ contact: c, score });
  }
  return res.sort((a, b) => b.score - a.score || a.contact.name.length - b.contact.name.length);
}

/** Падеж для ответа: «Звоню маме» — берём слово, как его сказал человек. */
export function phoneDisplay(p: string): string {
  return p.replace(/[^\d+]/g, '');
}
