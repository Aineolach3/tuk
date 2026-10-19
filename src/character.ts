// Персонаж «Тук»: малыш в чёрном капюшоне с антенной, белая маска с большими глазами,
// тактическая куртка с нашивкой «Т» и рюкзак. Рта нет — настроение показывают глаза
// и огонёк на кончике антенны. Рисуется в Canvas 2D, одинаково на Windows и Android.
//
// Движок анимации — по мотивам Coucou (MIT, Louis Raillé): пружины с подшагами,
// твины с изингами для реакций, глаза «на сфере», моргание по случайному таймеру,
// squash & stretch, «мягкие» части с запаздыванием. Рисунок, позы и персонаж — свои.
//
// Как устроено:
//  • requestAnimationFrame, всё считается от dt (а не «на кадр») — одинаково на 60 и 144 Гц;
//  • холст в физических пикселях (devicePixelRatio + ResizeObserver), перерисовка сразу
//    после смены размера — без пустого кадра;
//  • каждое настроение — процедурная поза; позы смешиваются весами, которые плавно
//    перетекают при смене настроения (никаких мгновенных скачков);
//  • реакции (тычок, прыжок, глоток, головокружение) — твины поверх позы;
//  • весь рисунок — в единицах U=100, масштаб задаёт одна матрица: градиенты не зависят
//    от размера и кешируются;
//  • экономия: скрытое окно — пауза, долгий покой — 15 к/с, сон — 12 к/с.

export type Mood =
  | 'sleep' | 'idle' | 'listen' | 'think' | 'write' | 'happy' | 'angry' | 'alert' | 'meet' | 'wave' | 'poke' | 'dizzy' | 'dance' | 'eat'
  | 'work' | 'search' | 'ready' | 'help' | 'carry' | 'near' | 'away';

export const MOOD_LABEL: Record<Mood, string> = {
  sleep: 'Отдыхает',
  idle: 'Бодрствует',
  listen: 'Слушает',
  think: 'Думает',
  write: 'Записывает',
  happy: 'Добрый',
  angry: 'Злой',
  alert: 'Напоминает',
  meet: 'Встреча',
  wave: 'Машет',
  poke: 'Ой!',
  dizzy: 'Голова кружится',
  dance: 'Танцует',
  eat: 'Глотает файл',
  work: 'Работает',
  search: 'Ищет',
  ready: 'Готов',
  help: 'Помогает',
  carry: 'Выполняет',
  near: 'Рядом',
  away: 'Уходит в фон',
};

/** Цвет огонька антенны для каждого настроения. */
const LIGHT: Record<Mood, [number, number, number]> = {
  sleep: [150, 170, 255],
  idle: [255, 240, 210],
  listen: [110, 210, 255],
  think: [255, 205, 70],
  write: [120, 255, 160],
  happy: [255, 200, 120],
  angry: [255, 60, 50],
  alert: [255, 150, 40],
  meet: [110, 230, 230],
  wave: [255, 240, 210],
  poke: [255, 120, 90],
  dizzy: [200, 140, 255],
  dance: [255, 90, 200],
  eat: [140, 220, 255],
  work: [255, 214, 150],
  search: [140, 220, 255],
  ready: [255, 240, 210],
  help: [120, 255, 190],
  carry: [255, 190, 90],
  near: [255, 228, 186],
  away: [160, 185, 255],
};

// ---------- Гардероб и цвета ----------

export type Outfit = 'none' | 'scarf' | 'santa' | 'glasses' | 'headphones' | 'pumpkin' | 'flowers' | 'bowtie' | 'crown';

export const OUTFIT_LABEL: Record<Outfit, string> = {
  none: 'Без наряда',
  scarf: 'Шарф',
  santa: 'Новогодняя шапка',
  glasses: 'Тёмные очки',
  headphones: 'Наушники',
  pumpkin: 'Тыква',
  flowers: 'Венок',
  bowtie: 'Бабочка',
  crown: 'Корона',
};

/** Цвет капюшона и куртки. */
export const HOOD_COLORS: Record<string, [number, number, number]> = {
  'Чёрный': [22, 22, 27],
  'Графит': [52, 54, 62],
  'Тёмно-синий': [22, 32, 62],
  'Хаки': [44, 50, 34],
  'Бордо': [62, 20, 30],
  'Белый': [225, 225, 232],
};

/** Цвет огонька в спокойном состоянии. */
export const LIGHT_COLORS: Record<string, [number, number, number]> = {
  'Тёплый': [255, 240, 210],
  'Голубой': [110, 210, 255],
  'Мятный': [120, 255, 190],
  'Розовый': [255, 120, 200],
  'Фиолетовый': [180, 130, 255],
  'Янтарь': [255, 180, 60],
};

/** Наряд по времени года. */
export function seasonalOutfit(d = new Date()): Outfit {
  const m = d.getMonth() + 1, day = d.getDate();
  if ((m === 12 && day >= 15) || (m === 1 && day <= 14)) return 'santa';
  if ((m === 10 && day >= 25) || (m === 11 && day <= 1)) return 'pumpkin';
  if (m >= 3 && m <= 5) return 'flowers';
  if (m >= 6 && m <= 8) return 'glasses';
  return 'scarf';
}

const INK = '#07070a';
const rgb = (c: ArrayLike<number>, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const frac = (v: number) => ((v % 1) + 1) % 1;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const TAU = Math.PI * 2;

/** Единица рисунка: полуширина капюшона. Весь рисунок — в этих единицах, масштаб — матрицей. */
const U = 100;

// ---------- Пружины и твины ----------

/**
 * Пружина: ω₀ = 2π / response, ζ = damping (1 — без перелёта, меньше — с «пружинкой»).
 * Шаг дробится по 1/240 с, чтобы просадка кадра не раскачала её.
 * По мотивам Coucou (MIT, Louis Raillé) — core/anim.ts, Spring.
 */
export class Spring {
  v: number;
  target: number;
  vel = 0;
  private w = 0;
  private z = 0;

  constructor(v: number, response = 0.4, damping = 0.8) {
    this.v = v;
    this.target = v;
    this.tune(response, damping);
  }

  tune(response: number, damping: number): void {
    this.w = TAU / response;
    this.z = damping;
  }

  snap(v = this.target): void {
    this.v = this.target = v;
    this.vel = 0;
  }

  step(dt: number): number {
    if (dt <= 0) return this.v;
    const n = Math.max(1, Math.ceil(dt * 240));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const acc = this.w * this.w * (this.target - this.v) - 2 * this.z * this.w * this.vel;
      this.vel += acc * h;
      this.v += this.vel * h;
    }
    return this.v;
  }

  get settled(): boolean {
    return Math.abs(this.target - this.v) < 0.002 && Math.abs(this.vel) < 0.01;
  }
}

/** Изинги — по мотивам Coucou (MIT, Louis Raillé), core/anim.ts. */
export const Ease = {
  lin: (t: number) => t,
  out: (t: number) => 1 - Math.pow(1 - t, 3),
  in: (t: number) => t * t,
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  back: (t: number) => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2),
};
type EaseFn = (t: number) => number;
type Key = readonly [to: number, ms: number, ease: EaseFn];

/** Каналы реакций поверх позы: масштаб, подскок (в долях U), вращение, раскрытие глаз, «рот-коробка». */
type Chan = 'sx' | 'sy' | 'hop' | 'roll' | 'open' | 'slot' | 'tilt';
const REST: Record<Chan, number> = { sx: 1, sy: 1, hop: 0, roll: 0, open: 1, slot: 0, tilt: 0 };

interface Tween {
  keys: Key[];
  i: number;
  from: number;
  start: number;
  done?: () => void;
}

// ---------- Позы ----------

type Kind = 'stand' | 'rest' | 'back';
const KIND: Partial<Record<Mood, Kind>> = { sleep: 'rest', away: 'back' };
const kindOf = (m: Mood): Kind => KIND[m] ?? 'stand';

/** Поза одного настроения в момент t (все сдвиги — в долях U). */
interface Pose {
  x: number;
  y: number;
  rot: number;
  sx: number;
  sy: number;
  armL: number;
  armR: number;
  outL: number;
  outR: number;
  sway: number;
  es: number;
  walk: number;
  /** Насколько отдалить «камеру», чтобы влезли предметы по бокам (1 — без отдаления). */
  reach: number;
  /** Сдвиг «камеры» по X (в долях U), если предметы только с одной стороны. */
  camX: number;
  /** Куда смотрит настроение; null — за курсором. */
  look: [number, number] | null;
  frontL: boolean;
  frontR: boolean;
}

const NUM_KEYS = ['x', 'y', 'rot', 'sx', 'sy', 'armL', 'armR', 'outL', 'outR', 'sway', 'es', 'walk', 'reach', 'camX'] as const;

function basePose(t: number): Pose {
  return {
    x: 0, y: 0, rot: 0, sx: 1, sy: 1, armL: 0.25, armR: -0.25, outL: 0.5, outR: 0.5,
    sway: Math.sin(t * 1.8) * 0.08, es: 1, walk: 0, reach: 1, camX: 0, look: null, frontL: false, frontR: false,
  };
}

/**
 * Танец: покачивание, подскок на каждую долю, приземление со сплющиванием.
 * По мотивам Coucou (MIT, Louis Raillé) — danceTransform.
 */
function dance(t: number, bpm: number) {
  const beat = (t * bpm) / 60;
  const hop = Math.abs(Math.sin(Math.PI * beat));
  const land = Math.pow(1 - hop, 6);
  return { dx: 0.08 * Math.sin(Math.PI * beat), dy: -0.2 * hop, rot: 0.12 * Math.sin(Math.PI * beat), sx: 1 + 0.06 * land, sy: 1 - 0.08 * land, ph: Math.sin(Math.PI * beat) };
}

function poseOf(m: Mood, t: number, age: number, bpm: number): Pose {
  const p = basePose(t);
  switch (m) {
    case 'idle':
      p.y = Math.sin(t * 2) * 0.02;
      break;
    case 'sleep':
      p.y = 0.03;
      p.reach = 0.7;
      p.camX = -0.22;
      p.sway = 0.45;
      break;
    case 'listen':
      p.sy = 1.03; p.y = -0.03; p.armL = 0.6; p.armR = -0.6; p.look = [0, 0]; p.es = 1.12;
      p.sway = -0.1 + Math.sin(t * 6) * 0.05;
      p.reach = 0.8; p.camX = 0.22;
      break;
    case 'think':
      p.rot = Math.sin(t * 1.3) * 0.05;
      p.look = [0.5 + Math.cos(t * 2) * 0.3, -0.8];
      p.armL = 0.3; p.armR = 1.95 + Math.sin(t * 1.3) * 0.04; p.outR = 0.48; p.frontR = true;
      p.reach = 0.82; p.camX = -0.22;
      break;
    case 'write':
      p.rot = 0.06; p.look = [0.2, 0.9]; p.armL = -0.5; p.armR = 0.5;
      break;
    case 'happy': {
      const ph = frac(t * 2.2);
      p.y = -Math.sin(ph * Math.PI) * 0.1;
      const sq = Math.pow(1 - Math.sin(ph * Math.PI), 8) * 0.07;
      p.sy = 1 - sq; p.sx = 1 + sq;
      p.armL = 2.5 + Math.sin(t * 6) * 0.12; p.armR = -2.5 - Math.sin(t * 6) * 0.12;
      p.sway = Math.sin(t * 8) * 0.25;
      break;
    }
    case 'angry':
      p.x = Math.sin(t * 45) * 0.025; p.armL = -0.3; p.armR = 0.3; p.sway = Math.sin(t * 40) * 0.05;
      break;
    case 'alert': {
      const b = Math.abs(Math.sin(t * 7));
      p.y = -b * 0.1;
      const land = Math.pow(1 - b, 6) * 0.06;
      p.sy = 1 - land; p.sx = 1 + land;
      p.armR = -2.2 + Math.sin(t * 9) * 0.3; p.look = [0, 0]; p.es = 1.14;
      p.sway = -0.1 + Math.sin(t * 6) * 0.06;
      p.reach = 0.86; p.camX = 0.14;
      break;
    }
    case 'meet':
      p.x = 0.35; p.rot = -0.06; p.look = [-1, 0.2]; p.armL = 2.4 + Math.sin(t * 10) * 0.4;
      p.reach = 0.8;
      break;
    case 'wave':
      p.rot = Math.sin(t * 6) * 0.04; p.armR = -2.6 + Math.sin(t * 12) * 0.35; p.outR = 0.6; p.frontR = true;
      break;
    case 'poke': {
      const k = Math.exp(-age * 5) * Math.abs(Math.cos(age * 18));
      p.sy = 1 - 0.1 * k; p.sx = 1 + 0.08 * k; p.armL = 0.7; p.armR = -0.7; p.look = [0, 0];
      break;
    }
    case 'dizzy':
      p.rot = Math.sin(t * 5) * 0.16; p.x = Math.sin(t * 2.5) * 0.06;
      p.armL = 0.9 + Math.sin(t * 4) * 0.3; p.armR = -0.9 + Math.cos(t * 4) * 0.3;
      break;
    case 'dance': {
      const d = dance(t, bpm);
      p.x = d.dx; p.y = d.dy; p.rot = d.rot; p.sx = d.sx; p.sy = d.sy;
      p.armL = 1.2 + d.ph * 1.2; p.armR = -1.2 + d.ph * 1.2;
      p.sway = -d.ph * 0.3;
      break;
    }
    case 'eat':
      p.look = [0, -0.9];
      p.armL = 0.9; p.armR = -0.9;
      break;
    case 'work': {
      const k = Math.sin(t * 18) * 0.06;
      p.y = Math.abs(Math.sin(t * 9)) * 0.012; p.rot = 0.03; p.look = [-0.35, 0.75]; p.armL = -0.75 + k; p.armR = 0.75 + k;
      break;
    }
    case 'search':
      p.rot = 0.07 + Math.sin(t * 1.6) * 0.03; p.x = Math.sin(t * 1.6) * 0.04; p.look = [0.85, 0.35];
      p.armL = 0.35; p.armR = -0.55; p.frontR = true;
      p.reach = 0.76; p.camX = 0.32;
      break;
    case 'ready':
      p.y = Math.sin(t * 2) * 0.02; p.look = [0, 0.1]; p.armL = -0.55; p.armR = 0.55;
      break;
    case 'help':
      p.rot = -0.04; p.look = [-0.9, -0.1]; p.armL = 2.05 + Math.sin(t * 3) * 0.08; p.frontL = true;
      p.reach = 0.74; p.camX = 0.38;
      break;
    case 'carry':
      p.y = -Math.abs(Math.sin(t * 7)) * 0.06; p.rot = 0.05 + Math.sin(t * 7) * 0.025; p.look = [0.6, 0];
      p.armL = -0.95; p.armR = 0.95; p.walk = Math.sin(t * 7);
      break;
    case 'near':
      p.x = 0.55; p.y = 0.1; p.look = [-0.5, 0.1]; p.armL = 0.3; p.armR = -1.9;
      p.reach = 0.84;
      break;
    case 'away': {
      const k = Ease.inOut(clamp(age / 1.4, 0, 1));
      const sc = 1 - 0.3 * k;
      p.sx = sc; p.sy = sc;
      p.y = -0.25 * k + Math.sin(t * 2.2) * 0.035;
      break;
    }
  }
  return p;
}

/** Яркость огонька 0..1 для настроения. */
function lightLevel(m: Mood, t: number): number {
  switch (m) {
    case 'sleep': return 0.18 + 0.12 * Math.sin(t * 1.3);
    case 'think': return 0.6 + 0.4 * Math.sin(t * 9);
    case 'alert': return 0.55 + 0.45 * Math.pow(Math.abs(Math.sin(t * 7)), 0.5);
    case 'angry': return 0.75 + 0.25 * Math.sin(t * 20);
    case 'listen': return 0.75 + 0.25 * Math.sin(t * 5);
    default: return 0.85 + 0.15 * Math.sin(t * 2);
  }
}

type EyeShape = 'open' | 'closed' | 'happy' | 'spiral' | 'squint' | 'angry';

interface Particle {
  kind: 'z' | 'heart' | 'spark' | 'note' | 'dust' | 'star';
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: number;
  life: number;
  age: number;
  color: string;
}

/** Спокойные настроения: в них можно сбавить частоту кадров. */
const CALM = new Set<Mood>(['idle', 'near', 'sleep', 'ready', 'work', 'write']);

export class Character {
  mood: Mood = 'idle';
  /** Наряд, цвет капюшона и цвет огонька в покое. */
  outfit: Outfit = 'none';
  hood: number[] = HOOD_COLORS['Чёрный'];
  idleLight: number[] | null = null;
  /** Темп танца, ударов в минуту (по умолчанию — средний поп). */
  bpm = 112;
  /** Принудительная экономия (например, остров свёрнут): не больше 15 к/с. */
  lowPower = false;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private still: boolean;
  private ro: ResizeObserver | null = null;
  private raf = 0;
  private timer = 0;
  private stopped = false;
  private last = -1;
  /** Часы движка, секунды; идут только вперёд и только на dt. */
  private clock = Math.random() * 10;

  // смешивание настроений
  private weights = new Map<Mood, Spring>();
  private since = new Map<Mood, number>();
  private dom: Mood = 'idle';
  private P: Pose = basePose(0);
  private kindW: Record<Kind, number> = { stand: 1, rest: 0, back: 0 };

  // реакции
  private chan: Record<Chan, number> = { ...REST };
  private tweens = new Map<Chan, Tween>();

  // пружины
  private yaw = new Spring(0, 0.24, 0.72);
  private pitch = new Spring(0, 0.24, 0.72);
  private es = new Spring(1, 0.3, 0.55);
  private zoom = new Spring(0, 0.45, 0.85);
  private reach = new Spring(1, 0.5, 0.9);
  private camX = new Spring(0, 0.5, 0.9);
  private flyRot = new Spring(0, 0.3, 0.6);
  private flyStretch = new Spring(0, 0.25, 0.6);
  private antLag = new Spring(0, 0.55, 0.3);
  private prevX = 0;
  private prevY = 0;

  // взгляд, моргание, огонёк
  private lookTarget = { x: 0, y: 0 };
  private nextWander = 0;
  private nextBlink = 2;
  private hoverOn = false;
  private shape: EyeShape = 'open';
  private light: number[] = [...LIGHT.idle];
  private lightLvl = 1;

  // частицы и предметы
  private particles: Particle[] = [];
  private spawnAcc = 0;
  private lastInput = 0;
  private off: HTMLCanvasElement | null = null;
  private grads = new Map<string, CanvasGradient>();
  private gradHood = '';

  private _peek = 0;

  constructor(canvas: HTMLCanvasElement, opts: { still?: boolean; fixed?: boolean } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.still = !!opts.still;
    this.weights.set('idle', new Spring(1, 0.32, 1));
    this.since.set('idle', this.clock);
    if (this.still) {
      // картинка без анимации — для превью в гардеробе; fixed — размер холста задан заранее
      if (!opts.fixed) this.resize();
      this.nextBlink = Infinity;
      this.nextWander = Infinity;
      return;
    }
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver((entries) => {
        const e = entries[entries.length - 1];
        const box = (e as ResizeObserverEntry & { devicePixelContentBoxSize?: ReadonlyArray<ResizeObserverSize> }).devicePixelContentBoxSize?.[0];
        this.resize(box ? [box.inlineSize, box.blockSize] : undefined);
        // смена размера очищает холст — сразу перерисовать, иначе мигнёт пустой кадр
        this.draw(performance.now());
      });
      try {
        this.ro.observe(canvas, { box: 'device-pixel-content-box' });
      } catch {
        this.ro.observe(canvas);
      }
    }
    this.resize();
    this.watchDpr();
    document.addEventListener('visibilitychange', this.onVisibility);
    // наведение: глаза растут и моргают
    canvas.addEventListener('pointerenter', () => this.hover(true));
    canvas.addEventListener('pointerleave', () => this.hover(false));
    this.lastInput = this.clock;
    this.schedule();
  }

  /**
   * Лист кадров (по горизонтали) для «острова» на Android — PNG в base64 без префикса.
   * Рисуется тем же кодом, поэтому наряд и цвета совпадают с приложением.
   */
  static sheet(look: { outfit: Outfit; hood: number[]; light: number[] | null }, mood: Mood, frames: number, fps: number, w: number, h: number): string {
    const one = document.createElement('canvas');
    one.width = w;
    one.height = h;
    const ch = new Character(one, { still: true, fixed: true });
    ch.outfit = look.outfit;
    ch.hood = look.hood;
    ch.idleLight = look.light;
    ch.set(mood);
    // разогрев: частицы (Zzz, ноты, сердечки) успевают появиться; «уход» — с начала
    let now = 0;
    ch.draw(now);
    if (mood !== 'away') for (let i = 0; i < 3 * fps; i++) ch.draw((now += 1000 / fps));
    const out = document.createElement('canvas');
    out.width = w * frames;
    out.height = h;
    const o = out.getContext('2d')!;
    for (let i = 0; i < frames; i++) {
      if (mood !== 'sleep' && i === 3) ch.blink();
      ch.draw((now += 1000 / fps));
      o.drawImage(one, i * w, 0);
    }
    return out.toDataURL('image/png').split(',')[1];
  }

  // ---------- Публичное API ----------

  /** Сдвиг к «голове крупно»: в свёрнутой строке видна голова (0 — в полный рост). */
  get peek(): number {
    return this._peek;
  }
  set peek(v: number) {
    this._peek = v;
    this.zoom.target = v > 0 ? 1 : 0;
    if (this.still) this.zoom.snap();
    this.wake();
  }

  set(mood: Mood): void {
    if (mood === this.mood) return;
    const prev = this.mood;
    this.mood = mood;
    this.since.set(mood, this.clock);
    for (const [m, s] of this.weights) s.target = m === mood ? 1 : 0;
    if (!this.weights.has(mood)) this.weights.set(mood, new Spring(0, 0.32, 1));
    this.weights.get(mood)!.target = 1;
    if (mood !== 'sleep') for (const p of this.particles) if (p.kind === 'z') p.life = Math.min(p.life, p.age + 0.4);
    this.wake();
    if (this.still) {
      // превью: сразу в позе, без переходов
      for (const [m, s] of this.weights) s.snap(m === mood ? 1 : 0);
      this.dom = mood;
      this.shape = this.shapeFor(mood, 1);
      return;
    }
    // реакции на вход в настроение
    switch (mood) {
      case 'poke': if (!this.tweens.has('sy')) this.squash(); break; // питомец мог уже сплющиться сам
      case 'happy': this.jump(); break;
      case 'dizzy': this.anim('roll', [[TAU, 1100, Ease.inOut]], () => (this.chan.roll = 0)); break;
      case 'alert': this.anim('hop', [[-0.28, 140, Ease.out], [0, 320, Ease.back]]); break;
      case 'eat': this.gulp(); break;
      case 'write': this.anim('hop', [[-0.08, 120, Ease.out], [0, 200, Ease.back]]); break;
      case 'wave': this.anim('tilt', [[-0.08, 160, Ease.out], [0, 400, Ease.back]]); break;
      case 'listen': this.blink(); break;
      default: if (prev !== 'sleep') this.blink();
    }
  }

  /** Куда смотреть: координаты в пикселях окна. */
  lookAtScreen(x: number, y: number): void {
    const r = this.canvas.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height * 0.4);
    // «на сфере»: tanh — у края экрана глаза упираются мягко, а не резко
    const nx = Math.tanh(dx / 260), ny = Math.tanh(dy / 200);
    if (Math.abs(nx - this.lookTarget.x) + Math.abs(ny - this.lookTarget.y) > 0.01) this.wake();
    this.lookTarget = { x: nx, y: ny };
    this.nextWander = this.clock + 2.5;
  }

  /** Курсор над персонажем: глаза растут, моргает. */
  hover(on: boolean): void {
    if (on === this.hoverOn) return;
    this.hoverOn = on;
    this.wake();
    if (on && this.mood !== 'sleep') this.blink();
  }

  /** Моргнуть (по мотивам Coucou). */
  blink(): void {
    if (this.tweens.has('open')) return;
    this.anim('open', [[0.06, 70, Ease.inOut], [1, 130, Ease.out]]);
  }

  /** Сплющиться от тычка. */
  squash(power = 1): void {
    this.wake();
    this.anim('sy', [[1 - 0.22 * power, 70, Ease.out], [1 + 0.1 * power, 130, Ease.out], [1, 170, Ease.inOut]]);
    this.anim('sx', [[1 + 0.16 * power, 70, Ease.out], [1 - 0.05 * power, 130, Ease.out], [1, 170, Ease.inOut]]);
    this.antLag.vel += 6 * power;
  }

  /** Радостный прыжок: присел, взлетел, приземлился со сплющиванием. */
  jump(): void {
    this.wake();
    this.anim('hop', [[0, 90, Ease.lin], [-0.45, 230, Ease.out], [0, 210, Ease.in]]);
    this.anim('sy', [[0.84, 90, Ease.out], [1.12, 150, Ease.out], [1, 290, Ease.inOut], [0.84, 70, Ease.out], [1, 240, Ease.back]]);
    this.anim('sx', [[1.12, 90, Ease.out], [0.92, 150, Ease.out], [1, 290, Ease.inOut], [1.14, 70, Ease.out], [1, 240, Ease.back]], () => this.puff(4));
    this.antLag.vel -= 5;
  }

  /** «Глотает файл»: открывает рот-коробку, жуёт, закрывает (по мотивам Coucou). */
  gulp(): void {
    this.wake();
    this.anim('slot', [[1, 220, Ease.out], [1, 260, Ease.lin], [0, 160, Ease.in], [0.25, 110, Ease.out], [0, 110, Ease.in], [0.2, 110, Ease.out], [0, 140, Ease.in]]);
    this.anim('sy', [[1, 400, Ease.lin], [0.8, 80, Ease.out], [1.16, 130, Ease.out], [1, 220, Ease.back]]);
    this.anim('sx', [[1, 400, Ease.lin], [1.24, 80, Ease.out], [0.94, 130, Ease.out], [1, 220, Ease.back]]);
  }

  /** Полёт при перетаскивании питомца: скорость окна в пикселях/с. 0,0 — висит. */
  setFlight(vx: number, vy: number): void {
    this.flyRot.target = clamp(vx / 1600, -0.45, 0.45);
    this.flyStretch.target = clamp(Math.hypot(vx, vy) / 5000, 0, 0.14);
    this.lookTarget = { x: Math.tanh(vx / 600), y: Math.tanh(vy / 600) };
    this.nextWander = this.clock + 1.5;
    this.wake();
  }

  /** Приземление после полёта. */
  land(): void {
    this.flyRot.target = 0;
    this.flyStretch.target = 0;
    this.squash(1.3);
    this.puff(6);
  }

  /** Попадает ли точка окна в фигуру (для click-through питомца). */
  contains(clientX: number, clientY: number): boolean {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const sx = this.canvas.width / r.width, sy = this.canvas.height / r.height;
    const { ox, oy, k } = this.frame0();
    const x = ((clientX - r.left) * sx - ox) / k - this.P.x * U;
    const y = ((clientY - r.top) * sy - oy) / k - (this.P.y + this.chan.hop) * U;
    const head = (x / (1.05 * U)) ** 2 + ((y + 0.3 * U) / (0.85 * U)) ** 2 <= 1;
    const body = Math.abs(x) < 0.65 * U && y > 0.2 * U && y < 1.15 * U;
    return head || body || (Math.hypot(x - 0.38 * U, y + 1.42 * U) < 0.2 * U);
  }

  /** Остановить анимацию и отписаться (если холст убирают со страницы). */
  destroy(): void {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.timer);
    this.ro?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  /** Кадр в момент now (мс, шкала performance.now). Для превью и листов кадров — тоже. */
  draw(now: number): void {
    const dt = this.last < 0 ? 0 : clamp((now - this.last) / 1000, 0, 0.1);
    const first = this.last < 0;
    this.last = now;
    this.update(dt);
    if (first) this.settle();
    this.render();
  }

  // ---------- Цикл кадров ----------

  private onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(this.raf);
      clearTimeout(this.timer);
      this.raf = this.timer = 0;
    } else {
      this.last = performance.now() - 16; // без огромного dt после паузы
      this.wake();
    }
  };

  private watchDpr() {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const on = () => {
      mq.removeEventListener('change', on);
      this.resize();
      this.draw(performance.now());
      this.watchDpr();
    };
    mq.addEventListener('change', on);
  }

  /** Сколько кадров в секунду нужно сейчас. */
  private fps(): number {
    if (this.dom === 'sleep' && this.tweens.size === 0) return 12;
    const quiet = this.clock - this.lastInput > 12 && this.tweens.size === 0 && CALM.has(this.mood) && !this.hoverOn;
    if (this.lowPower || quiet) return 15;
    return 60;
  }

  private schedule() {
    if (this.stopped || this.still || this.raf || this.timer) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    const fps = this.fps();
    if (fps >= 60) this.raf = requestAnimationFrame(this.tick);
    else this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.raf = requestAnimationFrame(this.tick);
    }, 1000 / fps - 4);
  }

  private tick = () => {
    this.raf = 0;
    if (this.stopped) return;
    this.draw(performance.now());
    this.schedule();
  };

  /** Что-то произошло — вернуть полные 60 к/с. */
  private wake() {
    this.lastInput = this.clock;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = 0;
      this.schedule();
    } else if (!this.raf) this.schedule();
  }

  private resize(devicePx?: [number, number]) {
    const dpr = window.devicePixelRatio || 1;
    // clientWidth/Height не зависят от transform (анимации появления окна)
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return; // холст не в документе — оставляем заданный размер
    const W = devicePx?.[0] || Math.round(w * dpr), H = devicePx?.[1] || Math.round(h * dpr);
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
  }

  // ---------- Твины ----------

  /** Твин канала по ключам [значение, мс, изинг]; по мотивам Coucou (MIT, Louis Raillé). */
  private anim(ch: Chan, keys: Key[], done?: () => void) {
    this.tweens.set(ch, { keys, i: 0, from: this.chan[ch], start: this.clock * 1000, done });
  }

  private stepTweens() {
    const nowMs = this.clock * 1000;
    for (const [ch, tw] of this.tweens) {
      let k = tw.keys[tw.i];
      let p = k[1] > 0 ? clamp((nowMs - tw.start) / k[1], 0, 1) : 1;
      // за длинный dt может пройти несколько ключей
      while (p >= 1) {
        tw.from = k[0];
        tw.start += k[1];
        tw.i++;
        if (tw.i >= tw.keys.length) break;
        k = tw.keys[tw.i];
        p = k[1] > 0 ? clamp((nowMs - tw.start) / k[1], 0, 1) : 1;
      }
      if (tw.i >= tw.keys.length) {
        this.chan[ch] = tw.from;
        this.tweens.delete(ch);
        tw.done?.();
        continue;
      }
      this.chan[ch] = tw.from + (k[0] - tw.from) * k[2](p);
    }
  }

  // ---------- Обновление ----------

  private update(dt: number) {
    this.clock += dt;
    const t = this.clock;
    this.stepTweens();

    // веса настроений
    let sum = 0, best = 0;
    for (const [m, s] of this.weights) {
      s.step(dt);
      s.v = clamp(s.v, 0, 1);
      if (s.target === 0 && s.v < 0.002) {
        this.weights.delete(m);
        continue;
      }
      sum += s.v;
      if (s.v > best) {
        best = s.v;
        this.dom = m;
      }
    }
    if (sum < 1e-4) {
      this.weights.set(this.mood, new Spring(1, 0.32, 1));
      sum = 1;
      this.dom = this.mood;
    }

    // смешанная поза
    const P = basePose(t);
    for (const k of NUM_KEYS) P[k] = 0;
    let lx = 0, ly = 0;
    const cur = this.cursorLook(t);
    this.kindW = { stand: 0, rest: 0, back: 0 };
    for (const [m, s] of this.weights) {
      const w = s.v / sum;
      if (w <= 0) continue;
      const p = poseOf(m, t, t - (this.since.get(m) ?? t), this.bpm);
      for (const k of NUM_KEYS) P[k] += p[k] * w;
      const lk = p.look ?? cur;
      lx += lk[0] * w;
      ly += lk[1] * w;
      this.kindW[kindOf(m)] += w;
    }
    const domPose = poseOf(this.dom, t, 0, this.bpm);
    P.frontL = domPose.frontL;
    P.frontR = domPose.frontR;
    this.P = P;

    // взгляд «на сфере»: поворот головы-шара (yaw) и наклон (pitch)
    this.yaw.target = lx * 0.42;
    this.pitch.target = ly * 0.32;
    this.yaw.step(dt);
    this.pitch.step(dt);

    this.es.target = P.es * (this.hoverOn && this.mood !== 'sleep' ? 1.16 : 1);
    this.es.step(dt);
    this.reach.target = P.reach;
    this.reach.step(dt);
    this.camX.target = P.camX;
    this.camX.step(dt);
    this.zoom.step(dt);
    this.flyRot.step(dt);
    this.flyStretch.step(dt);

    // «мягкая» антенна запаздывает за телом
    if (dt > 0) {
      const y = P.y + this.chan.hop;
      const vx = (P.x - this.prevX) / dt, vy = (y - this.prevY) / dt;
      this.antLag.target = clamp(-vx * 0.5 + vy * 0.25 - this.flyRot.v * 0.8, -0.6, 0.6);
      this.antLag.step(dt);
      this.prevX = P.x;
      this.prevY = y;
    }

    // огонёк
    const target = this.lightTarget(t);
    const kl = 1 - Math.exp(-dt * 7);
    this.light = mix(this.light, target, kl);
    let lvl = 0;
    for (const [m, s] of this.weights) lvl += lightLevel(m, t) * (s.v / sum);
    this.lightLvl = lvl;

    // глаза: смена формы — через моргание, чтобы не было «щелчка»
    const want = this.shapeFor(this.dom, t - (this.since.get(this.dom) ?? t));
    if (want !== this.shape) {
      if (this.chan.open < 0.35 || this.still) this.shape = want;
      else if (!this.tweens.has('open')) this.blink();
    }
    if (t > this.nextBlink) {
      if (this.mood !== 'sleep' && this.mood !== 'dizzy') {
        this.blink();
        if (Math.random() < 0.22) setTimeout(() => this.blink(), 230);
      }
      this.nextBlink = t + 2.2 + Math.random() * 3.2;
    }

    this.stepParticles(dt);
  }

  /** Пружины сразу в целевых значениях — первый кадр без «въезда». */
  private settle() {
    for (const s of [this.yaw, this.pitch, this.es, this.reach, this.camX, this.zoom]) s.snap();
    for (const [m, s] of this.weights) s.snap(m === this.mood ? 1 : 0);
    this.light = [...this.lightTarget(this.clock)];
  }

  private cursorLook(t: number): [number, number] {
    if (t > this.nextWander) {
      this.nextWander = t + 1.5 + Math.random() * 2.5;
      this.lookTarget = { x: (Math.random() - 0.5) * 1.4, y: (Math.random() - 0.5) * 0.8 };
    }
    return [this.lookTarget.x, this.lookTarget.y];
  }

  private lightTarget(t: number): number[] {
    let sum = 0;
    const out = [0, 0, 0];
    for (const [m, s] of this.weights) {
      const c = m === 'idle' && this.idleLight ? this.idleLight : m === 'dance' ? [127 + 127 * Math.sin(t * 3), 127 + 127 * Math.sin(t * 3 + 2), 127 + 127 * Math.sin(t * 3 + 4)] : LIGHT[m];
      for (let i = 0; i < 3; i++) out[i] += c[i] * s.v;
      sum += s.v;
    }
    return sum > 0 ? out.map((v) => v / sum) : [...LIGHT.idle];
  }

  private shapeFor(m: Mood, age: number): EyeShape {
    switch (m) {
      case 'sleep': return 'closed';
      case 'happy': case 'dance': return 'happy';
      case 'eat': return age > 0.75 ? 'happy' : 'open';
      case 'dizzy': return 'spiral';
      case 'poke': return 'squint';
      case 'angry': return 'angry';
      default: return 'open';
    }
  }

  // ---------- Частицы ----------

  private spawn(p: Omit<Particle, 'age'>) {
    if (this.particles.length < 40) this.particles.push({ ...p, age: 0 });
  }

  /** Облачка пыли у ног (приземление). */
  private puff(n: number) {
    for (let i = 0; i < n; i++) {
      const s = i % 2 ? 1 : -1;
      this.spawn({ kind: 'dust', x: s * (20 + Math.random() * 30) + this.P.x * U, y: 105 + this.P.y * U, vx: s * (40 + Math.random() * 50), vy: -20 - Math.random() * 20, g: 30, life: 0.5 + Math.random() * 0.2, color: 'rgba(200,200,215,0.5)' });
    }
  }

  private stepParticles(dt: number) {
    const m = this.dom;
    const every = m === 'sleep' ? 1.4 : m === 'happy' ? 0.5 : m === 'angry' ? 0.26 : m === 'dance' ? 60 / this.bpm : 0;
    if (every && (this.weights.get(m)?.v ?? 0) > 0.5) {
      this.spawnAcc += dt;
      if (this.spawnAcc > every) {
        this.spawnAcc = 0;
        const bx = this.P.x * U, by = this.P.y * U;
        const r = Math.random;
        if (m === 'sleep') this.spawn({ kind: 'z', x: bx + 75, y: by - 55, vx: 15, vy: -35, g: 0, life: 2.6, color: '#aebcff' });
        if (m === 'happy') this.spawn({ kind: 'heart', x: bx + (r() - 0.5) * 140, y: by - 100, vx: (r() - 0.5) * 30, vy: -55, g: 0, life: 1.4, color: '#ff5d7a' });
        if (m === 'dance') this.spawn({ kind: 'note', x: bx + (r() - 0.5) * 160, y: by - 90, vx: (r() - 0.5) * 30, vy: -50, g: 0, life: 1.6, color: rgb(this.light) });
        if (m === 'angry') this.spawn({ kind: 'spark', x: bx + 40, y: by - 142, vx: (r() - 0.5) * 120, vy: -(40 + r() * 60), g: 160, life: 0.6, color: rgb(LIGHT.angry) });
      }
    } else this.spawnAcc = 0;
    let j = 0;
    for (const p of this.particles) {
      p.age += dt;
      if (p.age >= p.life) continue;
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      this.particles[j++] = p;
    }
    this.particles.length = j;
  }

  // ---------- Кадр ----------

  /** Размер единицы (полуширины капюшона) в пикселях холста для текущего кадрирования. */
  private targetU(): number {
    const W = this.canvas.width, H = this.canvas.height;
    const full = Math.min(W / 2.15, H / 2.75);
    const head = Math.min(W / 2.15, H / 2.0);
    return lerp(full, head, clamp(this.zoom.v, 0, 1));
  }

  /** Начало координат и масштаб рисунка (unit → пиксели холста). */
  private frame0() {
    const W = this.canvas.width, H = this.canvas.height;
    const z = clamp(this.zoom.v, 0, 1);
    const u = this.targetU() * lerp(this.reach.v, 1, z * 0.6);
    const k = u / U;
    return { ox: W / 2 - this.camX.v * u * (1 - z), oy: H / 2 + lerp(0.15, 0.5, z) * u, k };
  }

  private render() {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const { ox, oy, k } = this.frame0();
    const t = this.clock;
    if (this.hood.join() !== this.gradHood) {
      this.grads.clear();
      this.gradHood = this.hood.join();
    }

    ctx.setTransform(k, 0, 0, k, ox, oy);
    const P = this.P;
    const hop = this.chan.hop;

    // тень на полу: меньше и бледнее, когда Тук в воздухе
    if (this.kindW.rest < 0.99) {
      const air = clamp(-(P.y + hop) * 2.2, 0, 0.8);
      ctx.save();
      ctx.globalAlpha = (1 - this.kindW.rest) * (1 - air * 0.7);
      ctx.translate(P.x * U, 0);
      ctx.scale(1, 0.22);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse(0, 112 / 0.22, 75 * (1 - air * 0.4), 50, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    // виды фигуры: стоя, лёжа, со спины; при переходе — честный cross-fade через буфер
    const kinds = (['stand', 'rest', 'back'] as Kind[]).filter((kd) => this.kindW[kd] > 0.01);
    if (kinds.length === 1) this.drawKind(kinds[0], t);
    else {
      const off = (this.off ??= document.createElement('canvas'));
      if (off.width !== W || off.height !== H) {
        off.width = W;
        off.height = H;
      }
      const o = off.getContext('2d')!;
      const main = this.ctx;
      for (const kd of kinds) {
        o.setTransform(1, 0, 0, 1, 0, 0);
        o.clearRect(0, 0, W, H);
        o.setTransform(k, 0, 0, k, ox, oy);
        this.ctx = o;
        this.drawKind(kd, t);
        this.ctx = main;
        main.save();
        main.setTransform(1, 0, 0, 1, 0, 0);
        main.globalAlpha = this.kindW[kd];
        main.drawImage(off, 0, 0);
        main.restore();
      }
    }

    // частицы и предметы вокруг — в той же системе координат, без поворота тела
    this.drawEffects(t, W, ox, k);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }

  /** Вес настроения 0..1 (для плавного появления предметов). */
  private wOf(m: Mood): number {
    let sum = 0;
    for (const s of this.weights.values()) sum += s.v;
    const w = this.weights.get(m)?.v ?? 0;
    return sum > 0 ? w / sum : 0;
  }

  /** Нарисовать предмет с прозрачностью по весу настроения. */
  private prop(m: Mood, fn: (a: number) => void) {
    const a = this.wOf(m);
    if (a < 0.01) return;
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha *= a;
    fn(a);
    ctx.restore();
  }

  private drawKind(kind: Kind, t: number) {
    const { ctx } = this;
    const P = this.P;
    const u = U;
    ctx.save();
    ctx.translate(P.x * u, (P.y + this.chan.hop) * u);
    // дыхание, реакции и полёт — вокруг ступней, чтобы ноги стояли на полу
    const breath = Math.sin(t * 1.8);
    const sleepy = kind === 'rest' ? 0 : 1;
    const fly = this.flyStretch.v;
    const sx = P.sx * this.chan.sx * (1 - breath * 0.01 * sleepy) * (1 - fly * 0.5);
    const sy = P.sy * this.chan.sy * (1 + breath * 0.018 * sleepy) * (1 + fly);
    const rot = P.rot + this.chan.tilt + this.flyRot.v + this.chan.roll;
    if (kind === 'stand' && this.chan.roll) {
      // головокружение: оборот вокруг центра фигуры
      ctx.translate(0, 10);
      ctx.rotate(this.chan.roll);
      ctx.translate(0, -10);
    }
    ctx.translate(0, u * 1.05);
    ctx.rotate(rot - this.chan.roll);
    ctx.scale(sx, sy);
    ctx.translate(0, -u * 1.05);

    if (kind === 'rest') this.drawRest(u, t);
    else if (kind === 'back') this.drawBack(u, t);
    else {
      this.prop('help', () => this.drawChecklist(u, t - (this.since.get('help') ?? t)));
      this.drawBackpack(u);
      this.drawBody(u, t);
      this.drawArms(u, false);
      this.prop('write', () => this.drawTablet(u, t));
      this.drawAntenna(u, t);
      this.drawHood(u);
      this.drawFace(u, t);
      const hp = this.wOf('listen');
      if (hp < 0.99) {
        ctx.save();
        ctx.globalAlpha *= 1 - hp;
        this.drawOutfit(u, t);
        ctx.restore();
      }
      this.prop('listen', () => this.drawHeadphones(u));
      this.drawArms(u, true);
      this.prop('work', () => this.drawLaptop(u, t));
      this.prop('ready', () => this.drawPad(u, t));
      this.prop('carry', () => this.drawBoxes(u, t));
      this.prop('search', () => this.drawLens(u, t));
      this.prop('near', () => this.drawMug(u, -u * 1.22, u * 0.18, u * 0.92, true));
    }
    ctx.restore();
  }

  // ---------- части тела ----------

  /** Вертикальный градиент ткани (кешируется: рисунок в постоянных единицах). */
  private fabric(y0: number, y1: number, light = 0.16): CanvasGradient {
    const key = `f${y0}:${y1}:${light}`;
    let g = this.grads.get(key);
    if (!g) {
      g = this.ctx.createLinearGradient(0, y0, 0, y1);
      g.addColorStop(0, rgb(mix(this.hood, [255, 255, 255], light * 0.9)));
      g.addColorStop(1, rgb(mix(this.hood, [0, 0, 0], 0.65)));
      this.grads.set(key, g);
    }
    return g;
  }

  private drawBackpack(u: number) {
    const { ctx } = this;
    ctx.fillStyle = '#121216';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.roundRect(s > 0 ? u * 0.42 : -u * 0.66, u * 0.28, u * 0.24, u * 0.52, u * 0.08);
      ctx.fill();
    }
  }

  private drawBody(u: number, t: number) {
    const { ctx } = this;
    // ботинки
    const walk = this.P.walk;
    for (const s of [-1, 1]) {
      ctx.fillStyle = '#0d0d10';
      ctx.beginPath();
      ctx.ellipse(s * u * 0.24 + s * walk * u * 0.1, u * 1.02 - Math.max(0, s * walk) * u * 0.08, u * 0.22, u * 0.13, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(s * u * 0.24 - u * 0.16, u * 1.04, u * 0.32, u * 0.025);
    }
    // куртка
    ctx.fillStyle = this.fabric(u * 0.2, u * 1.0, 0.17);
    ctx.beginPath();
    ctx.moveTo(-u * 0.5, u * 0.3);
    ctx.bezierCurveTo(-u * 0.6, u * 0.6, -u * 0.56, u * 0.95, -u * 0.3, u * 0.98);
    ctx.lineTo(u * 0.3, u * 0.98);
    ctx.bezierCurveTo(u * 0.56, u * 0.95, u * 0.6, u * 0.6, u * 0.5, u * 0.3);
    ctx.closePath();
    ctx.fill();
    // молния и швы
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = u * 0.02;
    ctx.beginPath();
    ctx.moveTo(0, u * 0.32);
    ctx.lineTo(0, u * 0.96);
    ctx.moveTo(-u * 0.45, u * 0.72);
    ctx.lineTo(u * 0.45, u * 0.72);
    ctx.stroke();
    // нашивка «Т» на груди
    this.patch(-u * 0.24, u * 0.48, u * 0.17, u * 0.13);
    // светоотражающая полоска
    const glow = 0.35 + 0.15 * Math.sin(t * 2);
    ctx.fillStyle = `rgba(230,235,255,${glow})`;
    ctx.fillRect(u * 0.16, u * 0.5, u * 0.18, u * 0.03);
  }

  private patch(x: number, y: number, w: number, h: number) {
    const { ctx } = this;
    ctx.fillStyle = '#2c2c33';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, w * 0.18);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = h * 0.16;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x + w * 0.28, y + h * 0.32);
    ctx.lineTo(x + w * 0.72, y + h * 0.32);
    ctx.moveTo(x + w * 0.5, y + h * 0.32);
    ctx.lineTo(x + w * 0.5, y + h * 0.75);
    ctx.stroke();
  }

  /** Руки: углы из смешанной позы; front — те, что поверх капюшона (машет, думает, показывает). */
  private drawArms(u: number, front: boolean) {
    const { ctx } = this;
    const P = this.P;
    const arm = (side: number, angle: number, out: number) => {
      ctx.save();
      ctx.translate(side * u * out, u * 0.42);
      ctx.rotate(angle);
      ctx.fillStyle = this.fabric(-u * 0.1, u * 0.4, 0.15);
      ctx.beginPath();
      ctx.roundRect(-u * 0.12, -u * 0.04, u * 0.24, u * 0.46, u * 0.12);
      ctx.fill();
      ctx.fillStyle = 'rgba(230,235,255,0.35)';
      ctx.fillRect(-u * 0.08, u * 0.22, u * 0.16, u * 0.025);
      ctx.fillStyle = '#0b0b0e';
      ctx.beginPath();
      ctx.arc(0, u * 0.44, u * 0.1, 0, TAU);
      ctx.fill();
      ctx.restore();
    };
    // с коробками руки рисуются у стопки
    if (this.wOf('carry') > 0.5 && !front) return;
    if (P.frontL === front) arm(-1, P.armL, P.outL);
    if (P.frontR === front) arm(1, P.armR, P.outR);
  }

  private drawTablet(u: number, t: number) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(0, u * 0.74);
    ctx.fillStyle = '#16161b';
    ctx.beginPath();
    ctx.roundRect(-u * 0.3, -u * 0.12, u * 0.6, u * 0.24, u * 0.04);
    ctx.fill();
    ctx.fillStyle = rgb(this.light, 0.55);
    ctx.fillRect(-u * 0.25, -u * 0.08, u * 0.5, u * 0.16);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    const k = (t * 1.5) % 1;
    for (let i = 0; i < 3; i++) ctx.fillRect(-u * 0.21, -u * 0.05 + i * u * 0.045, u * 0.42 * (i === 2 ? k : 1), u * 0.02);
    ctx.restore();
  }

  private drawAntenna(u: number, t: number, sway = this.P.sway + this.antLag.v) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(0, -u * 0.98);
    ctx.rotate(sway);
    ctx.strokeStyle = '#141418';
    ctx.lineWidth = u * 0.13;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, u * 0.05);
    ctx.bezierCurveTo(u * 0.02, -u * 0.25, u * 0.12, -u * 0.48, u * 0.32, -u * 0.46);
    ctx.stroke();
    // блик
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = u * 0.025;
    ctx.beginPath();
    ctx.moveTo(-u * 0.03, -u * 0.02);
    ctx.bezierCurveTo(-u * 0.01, -u * 0.25, u * 0.1, -u * 0.5, u * 0.3, -u * 0.52);
    ctx.stroke();
    // огонёк; при тревоге — пульсирующее кольцо
    const lvl = this.lightLvl;
    const tipX = u * 0.38, tipY = -u * 0.44;
    const pulse = this.wOf('alert');
    const R = u * (0.42 + 0.14 * lvl * pulse);
    const glow = ctx.createRadialGradient(tipX, tipY, 0, tipX, tipY, R);
    glow.addColorStop(0, rgb(this.light, 0.55 * lvl));
    glow.addColorStop(1, rgb(this.light, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(tipX, tipY, R, 0, TAU);
    ctx.fill();
    if (pulse > 0.01) {
      const ph = frac(t * 1.6);
      ctx.strokeStyle = rgb(this.light, (1 - ph) * 0.7 * pulse);
      ctx.lineWidth = u * 0.03;
      ctx.beginPath();
      ctx.arc(tipX, tipY, u * (0.1 + ph * 0.4), 0, TAU);
      ctx.stroke();
    }
    ctx.fillStyle = rgb(mix([40, 40, 46], [255, 255, 255], lvl * 0.6 + 0.2));
    ctx.beginPath();
    ctx.arc(tipX, tipY, u * 0.065, 0, TAU);
    ctx.fill();
    ctx.fillStyle = rgb(this.light, lvl);
    ctx.beginPath();
    ctx.arc(tipX, tipY, u * 0.045, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  private hoodPath(u: number) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(0, -u * 1.05);
    ctx.bezierCurveTo(u * 0.66, -u * 1.05, u * 1.0, -u * 0.6, u * 0.98, -u * 0.1);
    ctx.bezierCurveTo(u * 0.97, u * 0.25, u * 0.75, u * 0.45, u * 0.42, u * 0.42);
    ctx.lineTo(-u * 0.42, u * 0.42);
    ctx.bezierCurveTo(-u * 0.75, u * 0.45, -u * 0.97, u * 0.25, -u * 0.98, -u * 0.1);
    ctx.bezierCurveTo(-u * 1.0, -u * 0.6, -u * 0.66, -u * 1.05, 0, -u * 1.05);
  }

  private drawHood(u: number) {
    const { ctx } = this;
    // купол капюшона
    let g = this.grads.get('hood');
    if (!g) {
      g = ctx.createRadialGradient(-u * 0.35, -u * 0.75, u * 0.1, 0, -u * 0.2, u * 1.15);
      g.addColorStop(0, rgb(mix(this.hood, [255, 255, 255], 0.14)));
      g.addColorStop(0.55, rgb(this.hood));
      g.addColorStop(1, rgb(mix(this.hood, [0, 0, 0], 0.7)));
      this.grads.set('hood', g);
    }
    ctx.fillStyle = g;
    this.hoodPath(u);
    ctx.fill();
    // вязка: вертикальные рубчики
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.022)';
    ctx.lineWidth = u * 0.03;
    ctx.beginPath();
    for (let x = -u; x <= u; x += u * 0.09) {
      ctx.moveTo(x, -u * 1.1);
      ctx.quadraticCurveTo(x * 1.15, -u * 0.3, x * 1.05, u * 0.5);
    }
    ctx.stroke();
    ctx.restore();
    // контровой свет по краю — чтобы чёрный капюшон читался на чёрном фоне
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = u * 0.035;
    ctx.beginPath();
    ctx.moveTo(u * 0.1, -u * 1.03);
    ctx.bezierCurveTo(u * 0.66, -u * 1.0, u * 0.97, -u * 0.6, u * 0.96, -u * 0.12);
    ctx.stroke();
    // нашивка на капюшоне чуть сдвигается вслед за поворотом головы
    const yaw = this.yaw.v;
    this.patch(-u * 0.12 + Math.sin(yaw) * u * 0.1, -u * 0.86, u * 0.24, u * 0.17);
    // край капюшона вокруг лица
    ctx.fillStyle = rgb(mix(this.hood, [0, 0, 0], 0.55));
    ctx.beginPath();
    ctx.ellipse(Math.sin(yaw) * u * 0.05, -u * 0.06, u * 0.78, u * 0.6, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = u * 0.025;
    ctx.stroke();
  }

  /** Маска и глаза. Глаза «на сфере»: двигаются по дуге и сжимаются у края (по мотивам Coucou). */
  private drawFace(u: number, t: number, forced?: EyeShape) {
    const { ctx } = this;
    const yaw = this.yaw.v, pitch = this.pitch.v;
    const mx = Math.sin(yaw) * u * 0.07, my = -u * 0.04 + Math.sin(pitch) * u * 0.03;
    // белая маска
    let fg = this.grads.get('face');
    if (!fg) {
      fg = ctx.createRadialGradient(-u * 0.2, -u * 0.25, u * 0.05, 0, 0, u * 0.75);
      fg.addColorStop(0, '#ffffff');
      fg.addColorStop(0.7, '#ecebef');
      fg.addColorStop(1, '#c9c8cf');
      this.grads.set('face', fg);
    }
    ctx.save();
    ctx.translate(mx, my);
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.ellipse(0, 0, u * 0.66, u * 0.5, 0, 0, TAU);
    ctx.fill();
    ctx.clip();
    // румянец, когда добрый (и при наведении — чуть-чуть)
    const blush = Math.max(this.wOf('happy'), this.wOf('dance') * 0.6, this.wOf('meet') * 0.5);
    if (blush > 0.01) {
      ctx.fillStyle = `rgba(255,120,140,${0.28 * blush})`;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(s * u * 0.45, u * 0.18, u * 0.11, u * 0.055, 0, 0, TAU);
        ctx.fill();
      }
    }

    const shape = forced ?? this.shape;
    const es = this.es.v;
    const open = forced ? 1 : this.chan.open;
    const slot = forced ? 0 : this.chan.slot;
    const rx0 = u * 0.125 * es, ry0 = u * 0.21 * es;
    ctx.fillStyle = INK;
    ctx.strokeStyle = INK;
    ctx.lineCap = 'round';
    for (const s of [-1, 1]) {
      const a = s * 0.37 + yaw;
      const x = Math.sin(a) * u * 0.62 - mx * 0.4;
      const y = -u * 0.02 + Math.sin(pitch) * u * 0.32 - slot * u * 0.08;
      // у края сферы глаз сжимается по горизонтали
      const fx = Math.max(0.45, Math.cos(a) / Math.cos(0.37));
      const fy = Math.max(0.6, Math.cos(pitch));
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(fx, fy);
      this.eye(shape, s, rx0, ry0, open, u, t);
      ctx.restore();
    }
    // «рот-коробка», когда глотает файл
    if (slot > 0.01) {
      const w = u * 0.36, h = u * 0.2 * slot;
      ctx.fillStyle = '#121216';
      ctx.beginPath();
      ctx.roundRect(-w / 2, u * 0.2 - h / 2, w, Math.max(h, u * 0.02), u * 0.05);
      ctx.fill();
      ctx.fillStyle = rgb(this.light, 0.35 * slot);
      ctx.fillRect(-w / 2 + u * 0.04, u * 0.2 + h / 2 - u * 0.03, w - u * 0.08, u * 0.02);
    }
    ctx.restore();
  }

  private eye(shape: EyeShape, s: number, rx: number, ry: number, open: number, u: number, t: number) {
    const { ctx } = this;
    switch (shape) {
      case 'spiral': {
        ctx.lineWidth = u * 0.035;
        ctx.beginPath();
        for (let a = 0; a < Math.PI * 5; a += 0.25) {
          const rr = u * 0.012 * a;
          const px = Math.cos(a + t * 6 * s) * rr, py = Math.sin(a + t * 6 * s) * rr;
          if (a === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
        return;
      }
      case 'happy':
        ctx.lineWidth = u * 0.075;
        ctx.beginPath();
        ctx.arc(0, u * 0.08, u * 0.12, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
        return;
      case 'closed':
        ctx.lineWidth = u * 0.06;
        ctx.beginPath();
        ctx.arc(0, -u * 0.04, u * 0.1, Math.PI * 0.15, Math.PI * 0.85);
        ctx.stroke();
        return;
    }
    // открытый глаз; моргание — сжатие по вертикали до тонкой черты
    const ryy = Math.max(ry * open, u * 0.03);
    ctx.save();
    if (shape === 'squint') {
      // недовольный прищур: верх глаз срезан ровно
      ctx.beginPath();
      ctx.rect(-rx * 2, -ryy * 0.15, rx * 4, ryy * 3);
      ctx.clip();
    }
    if (shape === 'angry') {
      // злой прищур: верх глаза срезан наклонной линией
      ctx.beginPath();
      ctx.moveTo(-s * rx * 2, -ryy * 0.75);
      ctx.lineTo(s * rx * 2, -ryy * 0.05);
      ctx.lineTo(s * rx * 2, ryy * 2);
      ctx.lineTo(-s * rx * 2, ryy * 2);
      ctx.closePath();
      ctx.clip();
    }
    const think = this.dom === 'think' && s > 0 ? 0.85 : 1;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ryy * think, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
    // блик
    if (open > 0.4) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.beginPath();
      ctx.ellipse(-rx * 0.35, -ryy * 0.45, rx * 0.22, ryy * 0.16, -0.3, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath();
      ctx.arc(rx * 0.3, ryy * 0.4, rx * 0.1, 0, TAU);
      ctx.fill();
      ctx.fillStyle = INK;
    }
  }

  // ---------- Наряды ----------

  private drawOutfit(u: number, t: number) {
    const { ctx } = this;
    const o = this.outfit;
    if (o === 'none') return;
    ctx.save();
    if (o === 'scarf' || o === 'santa') {
      // вязаный шарф на шее; кончик запаздывает, как антенна
      const red = o === 'santa' ? '#c8242f' : '#b8432f';
      ctx.fillStyle = red;
      ctx.beginPath();
      ctx.roundRect(-u * 0.56, u * 0.3, u * 1.12, u * 0.2, u * 0.1);
      ctx.fill();
      ctx.save();
      ctx.translate(u * 0.28, u * 0.42);
      ctx.rotate(0.12 + Math.sin(t * 2) * 0.05 + this.antLag.v * 0.5);
      ctx.beginPath();
      ctx.roundRect(-u * 0.1, 0, u * 0.2, u * 0.42, u * 0.05);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      for (let i = 0; i < 2; i++) ctx.fillRect(-u * 0.1, u * (0.14 + i * 0.12), u * 0.2, u * 0.035);
      ctx.restore();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = u * 0.015;
      ctx.beginPath();
      for (let x = -0.48; x < 0.5; x += 0.08) {
        ctx.moveTo(u * x, u * 0.32);
        ctx.lineTo(u * (x + 0.03), u * 0.48);
      }
      ctx.stroke();
    }
    if (o === 'santa') {
      // красная шапка поверх капюшона; помпон качается
      const lag = this.antLag.v;
      ctx.fillStyle = '#d0262f';
      ctx.beginPath();
      ctx.moveTo(-u * 0.72, -u * 0.72);
      ctx.quadraticCurveTo(-u * 0.2, -u * 1.55, u * (0.62 + lag * 0.1), -u * (1.25 - lag * 0.05));
      ctx.quadraticCurveTo(u * 0.35, -u * 1.0, u * 0.72, -u * 0.72);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#f4f4f6';
      ctx.beginPath();
      ctx.roundRect(-u * 0.8, -u * 0.82, u * 1.6, u * 0.2, u * 0.1);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(u * (0.66 + lag * 0.1), -u * (1.24 - lag * 0.05), u * 0.13, 0, TAU);
      ctx.fill();
    }
    if (o === 'glasses') {
      const dx = Math.sin(this.yaw.v) * u * 0.08;
      ctx.fillStyle = '#050507';
      for (const sd of [-1, 1]) {
        ctx.beginPath();
        ctx.roundRect(sd * u * 0.24 - u * 0.2 + dx, -u * 0.2, u * 0.4, u * 0.26, u * 0.1);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath();
        ctx.ellipse(sd * u * 0.24 - u * 0.07 + dx, -u * 0.12, u * 0.06, u * 0.025, -0.4, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#050507';
      }
      ctx.fillRect(-u * 0.06 + dx, -u * 0.13, u * 0.12, u * 0.04);
    }
    if (o === 'headphones') this.drawHeadphones(u);
    if (o === 'pumpkin') {
      const y = u * 0.62;
      ctx.fillStyle = '#ef7d1a';
      for (const dx of [-0.13, 0, 0.13]) {
        ctx.beginPath();
        ctx.ellipse(u * dx, y, u * 0.16, u * 0.17, 0, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = '#3d7a2a';
      ctx.fillRect(-u * 0.025, y - u * 0.25, u * 0.05, u * 0.09);
      const glow = 0.6 + 0.4 * Math.sin(t * 4);
      ctx.fillStyle = `rgba(255,220,90,${glow})`;
      ctx.beginPath();
      ctx.moveTo(-u * 0.13, y - u * 0.04); ctx.lineTo(-u * 0.06, y - u * 0.04); ctx.lineTo(-u * 0.095, y - u * 0.1); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(u * 0.06, y - u * 0.04); ctx.lineTo(u * 0.13, y - u * 0.04); ctx.lineTo(u * 0.095, y - u * 0.1); ctx.fill();
      ctx.fillRect(-u * 0.1, y + u * 0.04, u * 0.2, u * 0.035);
    }
    if (o === 'flowers') {
      const cols = ['#ff8fb8', '#ffd84d', '#9be37a', '#8fc8ff', '#ff9f6b'];
      for (let i = 0; i < 7; i++) {
        const a = Math.PI * (1.15 + i * 0.7 / 6);
        const x = Math.cos(a) * u * 0.92, y = -u * 0.2 + Math.sin(a) * u * 0.86;
        ctx.fillStyle = cols[i % cols.length];
        ctx.beginPath();
        for (let k = 0; k < 5; k++) {
          const b = (k / 5) * TAU + t * 0.5;
          const px = x + Math.cos(b) * u * 0.055, py = y + Math.sin(b) * u * 0.055;
          ctx.moveTo(px + u * 0.045, py);
          ctx.arc(px, py, u * 0.045, 0, TAU);
        }
        ctx.fill();
        ctx.fillStyle = '#fff3b0';
        ctx.beginPath();
        ctx.arc(x, y, u * 0.035, 0, TAU);
        ctx.fill();
      }
    }
    if (o === 'bowtie') {
      ctx.fillStyle = '#c8242f';
      ctx.beginPath();
      ctx.moveTo(0, u * 0.38); ctx.lineTo(-u * 0.2, u * 0.28); ctx.lineTo(-u * 0.2, u * 0.48); ctx.closePath();
      ctx.moveTo(0, u * 0.38); ctx.lineTo(u * 0.2, u * 0.28); ctx.lineTo(u * 0.2, u * 0.48); ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, u * 0.38, u * 0.05, 0, TAU);
      ctx.fill();
    }
    if (o === 'crown') {
      ctx.fillStyle = '#f2c230';
      ctx.beginPath();
      ctx.moveTo(-u * 0.32, -u * 0.98);
      ctx.lineTo(-u * 0.32, -u * 1.22);
      ctx.lineTo(-u * 0.16, -u * 1.1);
      ctx.lineTo(0, -u * 1.3);
      ctx.lineTo(u * 0.16, -u * 1.1);
      ctx.lineTo(u * 0.32, -u * 1.22);
      ctx.lineTo(u * 0.32, -u * 0.98);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(-u * 0.3, -u * 1.03, u * 0.6, u * 0.03);
      ctx.fillStyle = '#e8394a';
      ctx.beginPath();
      ctx.arc(0, -u * 1.06, u * 0.04, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------- Эффекты вокруг ----------

  private drawEffects(t: number, W: number, ox: number, k: number) {
    const { ctx } = this;
    const u = U;
    const cx = this.P.x * u, cy = (this.P.y + this.chan.hop) * u;

    for (const p of this.particles) {
      const q = p.age / p.life;
      ctx.save();
      ctx.globalAlpha = q < 0.15 ? q / 0.15 : 1 - (q - 0.15) / 0.85;
      ctx.fillStyle = p.color;
      if (p.kind === 'z') {
        ctx.font = `700 ${u * (0.32 + q * 0.25)}px system-ui, sans-serif`;
        ctx.fillText('z', p.x, p.y);
      } else if (p.kind === 'heart') {
        const r = u * 0.12 * (1 + q * 0.4);
        ctx.translate(p.x, p.y);
        ctx.rotate(Math.sin(p.age * 5) * 0.2);
        ctx.beginPath();
        ctx.moveTo(0, r * 0.8);
        ctx.bezierCurveTo(-r * 1.6, -r * 0.3, -r * 0.6, -r * 1.4, 0, -r * 0.4);
        ctx.bezierCurveTo(r * 0.6, -r * 1.4, r * 1.6, -r * 0.3, 0, r * 0.8);
        ctx.fill();
      } else if (p.kind === 'note') {
        ctx.font = `700 ${u * 0.36}px system-ui, sans-serif`;
        ctx.translate(p.x, p.y);
        ctx.rotate(Math.sin(p.age * 6) * 0.25);
        ctx.fillText(p.life > 1.55 ? '♪' : '♫', 0, 0);
      } else if (p.kind === 'spark') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, u * 0.035, 0, TAU);
        ctx.fill();
      } else if (p.kind === 'dust') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, u * (0.05 + q * 0.07), 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    this.prop('dizzy', () => {
      ctx.fillStyle = '#ffe36b';
      ctx.font = `700 ${u * 0.28}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      for (let i = 0; i < 3; i++) {
        const a = t * 2.5 + (i * TAU) / 3;
        ctx.fillText('★', cx + Math.cos(a) * u * 0.7, cy - u * 1.15 + Math.sin(a) * u * 0.15);
      }
      ctx.textAlign = 'start';
    });
    this.prop('eat', () => {
      // файл влетает в «рот-коробку»
      const age = t - (this.since.get('eat') ?? t);
      const q = Ease.in(clamp(age / 0.5, 0, 1));
      if (q >= 1) return;
      ctx.save();
      ctx.translate(cx + u * 1.2 * (1 - q), cy + u * 0.16 - u * 1.3 * (1 - q));
      ctx.rotate((1 - q) * 0.8);
      ctx.scale(1 - q * 0.75, 1 - q * 0.75);
      ctx.fillStyle = '#f3f3f6';
      ctx.beginPath();
      ctx.roundRect(-u * 0.2, -u * 0.26, u * 0.4, u * 0.52, u * 0.04);
      ctx.fill();
      ctx.fillStyle = '#9aa0ad';
      for (let i = 0; i < 4; i++) ctx.fillRect(-u * 0.13, -u * 0.15 + i * u * 0.09, u * 0.26, u * 0.03);
      ctx.restore();
    });
    this.prop('think', () => this.bubble(cx + u * 1.02, cy - u * 0.95, u, (bx, by) => {
      for (let i = 0; i < 3; i++) {
        const ph = t * 5 - i * 0.7;
        ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.65 * Math.max(0, Math.sin(ph))})`;
        ctx.beginPath();
        ctx.arc(bx + (i - 1) * u * 0.15, by - Math.max(0, Math.sin(ph)) * u * 0.03, u * 0.05, 0, TAU);
        ctx.fill();
      }
    }));
    this.prop('search', () => this.floatingCards(cx, cy, u, t));
    this.prop('carry', () => {
      for (let i = 0; i < 3; i++) {
        const q = frac(t * 1.4 + i / 3);
        ctx.fillStyle = `rgba(200,200,215,${0.35 * (1 - q)})`;
        ctx.beginPath();
        ctx.arc(cx - u * (0.55 + q * 0.6), u * (1.05 - q * 0.15), u * (0.05 + q * 0.08), 0, TAU);
        ctx.fill();
      }
    });
    this.prop('alert', () => {
      ctx.fillStyle = rgb(LIGHT.alert);
      ctx.font = `900 ${u * 0.7}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      const s = 1 + 0.12 * Math.pow(Math.abs(Math.sin(t * 7)), 4);
      ctx.save();
      ctx.translate(cx - u * 0.98, cy - u * 0.6);
      ctx.scale(s, s);
      ctx.rotate(Math.sin(t * 14) * 0.08);
      ctx.fillText('!', 0, 0);
      ctx.restore();
      ctx.textAlign = 'start';
    });
    this.prop('listen', () => {
      this.bubble(cx - u * 1.12, cy - u * 0.35, u, (bx, by) => {
        for (let i = 0; i < 5; i++) {
          const hgt = u * (0.06 + 0.13 * Math.abs(Math.sin(t * 6.2 + i * 1.3)));
          ctx.fillStyle = rgb(LIGHT.listen, 0.95);
          ctx.beginPath();
          ctx.roundRect(bx + (i - 2) * u * 0.085 - u * 0.025, by - hgt / 2, u * 0.05, hgt, u * 0.025);
          ctx.fill();
        }
      }, true);
      for (let i = 0; i < 2; i++) {
        const q = frac(t * 0.9 + i * 0.5);
        ctx.strokeStyle = rgb(LIGHT.listen, (1 - q) * 0.5);
        ctx.lineWidth = u * 0.035;
        ctx.beginPath();
        ctx.arc(cx, cy - u * 0.2, u * (1.05 + q * 0.45), 0, TAU);
        ctx.stroke();
      }
    });
    this.prop('meet', () => this.drawFriend(t, -ox / k));
    void W;
  }

  /** Облачко-пузырь с хвостиком; содержимое рисует fill(bx, by) — центр облачка. */
  private bubble(x: number, y: number, u: number, fill: (bx: number, by: number) => void, tailRight = false) {
    const { ctx } = this;
    const w = u * 0.62, h = u * 0.36;
    ctx.save();
    ctx.fillStyle = 'rgba(40,44,60,0.92)';
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = u * 0.02;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    const tx = tailRight ? x + w * 0.3 : x - w * 0.3;
    ctx.moveTo(tx - u * 0.05, y + h / 2 - u * 0.01);
    ctx.lineTo(tx + (tailRight ? u * 0.1 : -u * 0.1), y + h / 2 + u * 0.12);
    ctx.lineTo(tx + u * 0.06, y + h / 2 - u * 0.01);
    ctx.fill();
    ctx.restore();
    fill(x, y);
  }

  private glassCard(x: number, y: number, w: number, h: number, u: number) {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(120,170,255,0.16)';
    ctx.strokeStyle = 'rgba(160,200,255,0.6)';
    ctx.lineWidth = u * 0.02;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, u * 0.05);
    ctx.fill();
    ctx.stroke();
  }

  /** Летающие карточки «папка, документ, глобус» — когда Тук ищет. */
  private floatingCards(cx: number, cy: number, u: number, t: number) {
    const { ctx } = this;
    const cards = [
      { x: -1.42, y: -0.95, k: 'folder' },
      { x: -1.6, y: -0.2, k: 'doc' },
      { x: -1.05, y: -0.45, k: 'globe' },
    ];
    cards.forEach((c, i) => {
      const x = cx + u * c.x, y = cy + u * c.y + Math.sin(t * 2 + i * 1.7) * u * 0.06;
      const w = u * 0.42, h = u * 0.42;
      this.glassCard(x, y, w, h, u);
      ctx.strokeStyle = 'rgba(200,225,255,0.9)';
      ctx.fillStyle = 'rgba(200,225,255,0.9)';
      ctx.lineWidth = u * 0.025;
      const mx = x + w / 2, my = y + h / 2;
      if (c.k === 'folder') {
        ctx.beginPath();
        ctx.roundRect(mx - u * 0.13, my - u * 0.07, u * 0.26, u * 0.17, u * 0.02);
        ctx.fill();
        ctx.fillRect(mx - u * 0.13, my - u * 0.11, u * 0.1, u * 0.05);
      } else if (c.k === 'doc') {
        for (let j = 0; j < 4; j++) ctx.fillRect(mx - u * 0.12, my - u * 0.11 + j * u * 0.07, u * (j === 3 ? 0.14 : 0.24), u * 0.025);
      } else {
        ctx.beginPath();
        ctx.arc(mx, my, u * 0.12, 0, TAU);
        ctx.moveTo(mx - u * 0.12, my);
        ctx.lineTo(mx + u * 0.12, my);
        ctx.moveTo(mx, my - u * 0.12);
        ctx.ellipse(mx, my, u * 0.05, u * 0.12, 0, -Math.PI / 2, Math.PI * 1.5);
        ctx.stroke();
      }
    });
  }

  /** Друг выезжает слева — «встреча». */
  private drawFriend(t: number, leftEdge: number) {
    const { ctx } = this;
    const u = U;
    const s = u * 0.55;
    const age = t - (this.since.get('meet') ?? t);
    const slide = Ease.back(clamp(age / 0.7, 0, 1));
    const x = lerp(leftEdge - s * 1.2, -u * 1.05, slide);
    const y = u * 0.62 + Math.sin(t * 3) * s * 0.04;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = '#3d4250';
    ctx.beginPath();
    ctx.ellipse(0, -s * 0.2, s * 0.95, s * 0.85, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#ecebef';
    ctx.beginPath();
    ctx.ellipse(s * 0.08, -s * 0.12, s * 0.62, s * 0.46, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = INK;
    for (const d of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(d * s * 0.22 + s * 0.16, -s * 0.12, s * 0.09, s * 0.16, 0, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = rgb(LIGHT.meet, 0.9);
    ctx.beginPath();
    ctx.arc(s * 0.3, -s * 1.15 + Math.sin(t * 10) * s * 0.03, s * 0.08, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // ---------- Предметы ----------

  /** Лупа в правой руке. */
  private drawLens(u: number, t: number) {
    const { ctx } = this;
    const hx = u * 0.78, hy = u * 0.72;
    const lx = u * 0.66 + Math.sin(t * 1.6) * u * 0.05, ly = u * 0.3;
    ctx.strokeStyle = '#2a2a31';
    ctx.lineWidth = u * 0.07;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(lx + u * 0.14, ly + u * 0.22);
    ctx.stroke();
    const g = ctx.createRadialGradient(lx - u * 0.06, ly - u * 0.06, u * 0.02, lx, ly, u * 0.22);
    g.addColorStop(0, 'rgba(220,240,255,0.55)');
    g.addColorStop(1, 'rgba(140,190,255,0.18)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(lx, ly, u * 0.27, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#3a3a44';
    ctx.lineWidth = u * 0.05;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = u * 0.02;
    ctx.beginPath();
    ctx.arc(lx, ly, u * 0.18, Math.PI * 1.1, Math.PI * 1.5);
    ctx.stroke();
  }

  /** Ноутбук перед Туком (крышка к зрителю, логотип «Т»). */
  private drawLaptop(u: number, t: number) {
    const { ctx } = this;
    // свет экрана на маске
    ctx.fillStyle = rgb(this.light, 0.1 + 0.04 * Math.sin(t * 6));
    ctx.beginPath();
    ctx.ellipse(0, u * 0.1, u * 0.6, u * 0.32, 0, 0, TAU);
    ctx.fill();
    // клавиатура
    ctx.fillStyle = '#2a2b31';
    ctx.beginPath();
    ctx.moveTo(-u * 0.82, u * 1.0);
    ctx.lineTo(u * 0.62, u * 1.0);
    ctx.lineTo(u * 0.52, u * 0.93);
    ctx.lineTo(-u * 0.72, u * 0.93);
    ctx.closePath();
    ctx.fill();
    // крышка
    let g = this.grads.get('laptop');
    if (!g) {
      g = ctx.createLinearGradient(-u * 0.7, u * 0.35, u * 0.5, u * 0.95);
      g.addColorStop(0, '#5a5c66');
      g.addColorStop(1, '#2c2d34');
      this.grads.set('laptop', g);
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(-u * 0.72, u * 0.4, u * 1.24, u * 0.56, u * 0.05);
    ctx.fill();
    ctx.strokeStyle = rgb(this.light, 0.55);
    ctx.lineWidth = u * 0.02;
    ctx.beginPath();
    ctx.moveTo(-u * 0.68, u * 0.405);
    ctx.lineTo(u * 0.48, u * 0.405);
    ctx.stroke();
    // логотип
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = u * 0.04;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-u * 0.19, u * 0.6);
    ctx.lineTo(-u * 0.01, u * 0.6);
    ctx.moveTo(-u * 0.1, u * 0.6);
    ctx.lineTo(-u * 0.1, u * 0.77);
    ctx.stroke();
  }

  /** Планшет у груди — «готов к следующей задаче». */
  private drawPad(u: number, t: number) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(u * 0.12, u * 0.72);
    ctx.rotate(-0.12);
    ctx.fillStyle = '#26272e';
    ctx.beginPath();
    ctx.roundRect(-u * 0.32, -u * 0.22, u * 0.64, u * 0.44, u * 0.05);
    ctx.fill();
    ctx.fillStyle = '#121318';
    ctx.fillRect(-u * 0.27, -u * 0.17, u * 0.54, u * 0.34);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = u * 0.035;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-u * 0.09, -u * 0.06);
    ctx.lineTo(u * 0.09, -u * 0.06);
    ctx.moveTo(0, -u * 0.06);
    ctx.lineTo(0, u * 0.09);
    ctx.stroke();
    // мигающий курсор — плавно, а не «вкл/выкл»
    ctx.fillStyle = rgb(this.light, 0.9 * (0.5 + 0.5 * Math.sin(t * 5)));
    ctx.fillRect(u * 0.14, u * 0.06, u * 0.06, u * 0.025);
    ctx.restore();
  }

  /** Стопка коробок в руках — «выполняет». */
  private drawBoxes(u: number, t: number) {
    const { ctx } = this;
    const bob = Math.sin(t * 7) * u * 0.015;
    const boxes = [
      { x: -0.5, y: 0.74, w: 0.98, h: 0.3 },
      { x: -0.44, y: 0.47, w: 0.88, h: 0.27 },
      { x: -0.38, y: 0.24, w: 0.78, h: 0.23 },
    ];
    for (const b of boxes) {
      const y = u * b.y + bob;
      const g = ctx.createLinearGradient(0, y, 0, y + u * b.h);
      g.addColorStop(0, '#f1ece2');
      g.addColorStop(1, '#c9c2b4');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(u * b.x + u * 0.05, y, u * b.w, u * b.h, u * 0.03);
      ctx.fill();
      ctx.fillStyle = 'rgba(120,105,80,0.35)';
      ctx.fillRect(u * b.x + u * 0.05, y + u * b.h * 0.45, u * b.w, u * 0.02);
    }
    // руки по бокам стопки
    ctx.fillStyle = '#0b0b0e';
    for (const sd of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(u * 0.04 + sd * u * 0.52, u * 0.66 + bob, u * 0.1, 0, TAU);
      ctx.fill();
    }
  }

  /** Прозрачная панель со списком; галочки появляются по очереди. */
  private drawChecklist(u: number, age: number) {
    const { ctx } = this;
    const x = -u * 1.62, y = -u * 0.62, w = u * 0.78, h = u * 0.98;
    this.glassCard(x, y, w, h, u);
    const step = (((age % 3.2) + 3.2) % 3.2) / 0.7;
    for (let i = 0; i < 3; i++) {
      const ry = y + u * 0.2 + i * u * 0.28;
      ctx.strokeStyle = 'rgba(200,225,255,0.85)';
      ctx.lineWidth = u * 0.025;
      ctx.beginPath();
      ctx.roundRect(x + u * 0.1, ry - u * 0.08, u * 0.16, u * 0.16, u * 0.03);
      ctx.stroke();
      ctx.fillStyle = 'rgba(200,225,255,0.7)';
      ctx.fillRect(x + u * 0.34, ry - u * 0.02, u * 0.34, u * 0.04);
      const q = clamp((step - i - 0.3) / 0.25, 0, 1);
      if (q > 0) {
        // галочка «прорисовывается»
        ctx.strokeStyle = '#7cf0b4';
        ctx.lineWidth = u * 0.04;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x + u * 0.13, ry);
        const a = clamp(q * 2, 0, 1), b = clamp(q * 2 - 1, 0, 1);
        ctx.lineTo(x + u * (0.13 + 0.04 * a), ry + u * 0.04 * a);
        if (b > 0) ctx.lineTo(x + u * (0.17 + 0.07 * b), ry + u * (0.04 - 0.09 * b));
        ctx.stroke();
      }
    }
  }

  /** Большая кружка с «Т»; hand — Тук выглядывает из-за неё (рука на краю). */
  private drawMug(u: number, x: number, y: number, size: number, hand = false) {
    const { ctx } = this;
    const w = size, h = size * 1.0;
    // ручка
    ctx.strokeStyle = '#1b1b20';
    ctx.lineWidth = size * 0.11;
    ctx.beginPath();
    ctx.arc(x - w * 0.02, y + h * 0.5, h * 0.24, Math.PI * 0.5, Math.PI * 1.5);
    ctx.stroke();
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, '#2a2a31');
    g.addColorStop(0.45, '#1a1a1f');
    g.addColorStop(1, '#0c0c0f');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, [size * 0.04, size * 0.04, size * 0.12, size * 0.12]);
    ctx.fill();
    ctx.fillStyle = '#0a0a0c';
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + size * 0.02, w / 2, size * 0.05, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = size * 0.07;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x + w * 0.34, y + h * 0.36);
    ctx.lineTo(x + w * 0.66, y + h * 0.36);
    ctx.moveTo(x + w * 0.5, y + h * 0.36);
    ctx.lineTo(x + w * 0.5, y + h * 0.66);
    ctx.stroke();
    if (hand) {
      ctx.fillStyle = '#0b0b0e';
      ctx.beginPath();
      ctx.arc(x + w * 0.98, y + size * 0.04, u * 0.1, 0, TAU);
      ctx.fill();
    }
  }

  private drawHeadphones(u: number) {
    const { ctx } = this;
    ctx.strokeStyle = '#2b2b33';
    ctx.lineWidth = u * 0.09;
    ctx.beginPath();
    ctx.arc(0, -u * 0.2, u * 0.95, Math.PI * 1.08, Math.PI * 1.92);
    ctx.stroke();
    for (const sd of [-1, 1]) {
      ctx.fillStyle = '#1f1f26';
      ctx.beginPath();
      ctx.roundRect(sd * u * 0.95 - u * 0.15, -u * 0.32, u * 0.3, u * 0.42, u * 0.12);
      ctx.fill();
      ctx.fillStyle = rgb(this.light, 0.8);
      ctx.beginPath();
      ctx.arc(sd * u * 0.95, -u * 0.11, u * 0.05, 0, TAU);
      ctx.fill();
    }
  }

  /** «Отдыхает»: лежит, голова на полу, тело позади, рядом кружка; дышит. */
  private drawRest(u: number, t: number) {
    const { ctx } = this;
    const breathe = Math.sin(t * 1.4) * u * 0.02;
    ctx.save();
    ctx.translate(u * 0.5, 0);
    // тень под лежащим
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(-u * 0.4, u * 1.1, u * 1.5, u * 0.12, 0, 0, TAU);
    ctx.fill();
    // тело лёжа позади головы
    ctx.fillStyle = this.fabric(u * 0.4, u * 1.1, 0.14);
    ctx.beginPath();
    ctx.ellipse(-u * 0.95, u * 0.82 + breathe * 0.5, u * 0.85, u * 0.3 + breathe, -0.05, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#121216';
    ctx.beginPath();
    ctx.roundRect(-u * 1.35, u * 0.42 + breathe, u * 0.62, u * 0.3, u * 0.1);
    ctx.fill();
    this.patch(-u * 1.12, u * 0.48 + breathe, u * 0.16, u * 0.12);
    ctx.fillStyle = '#0d0d10';
    ctx.beginPath();
    ctx.ellipse(-u * 1.78, u * 0.92, u * 0.16, u * 0.12, 0, 0, TAU);
    ctx.fill();
    // голова лежит на полу
    ctx.save();
    ctx.translate(u * 0.1, u * 0.5);
    ctx.rotate(0.12 + Math.sin(t * 1.4) * 0.01);
    ctx.scale(0.92, 0.92);
    this.drawAntenna(u, t, 0.45 + Math.sin(t * 1.4) * 0.03);
    this.drawHood(u);
    this.drawFace(u, t, 'closed');
    if (this.outfit === 'santa' || this.outfit === 'glasses' || this.outfit === 'crown' || this.outfit === 'flowers' || this.outfit === 'headphones') this.drawOutfit(u, t);
    ctx.restore();
    this.drawMug(u, u * 0.95, u * 0.6, u * 0.42);
    ctx.restore();
  }

  /** «Уходит в фон»: вид сзади — капюшон и рюкзак с «Т». */
  private drawBack(u: number, t: number) {
    const { ctx } = this;
    // огонёк-«двигатель» под ногами
    const g = ctx.createRadialGradient(0, u * 1.15, 0, 0, u * 1.15, u * 0.5);
    g.addColorStop(0, rgb(this.light, 0.55));
    g.addColorStop(1, rgb(this.light, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, u * 1.15, u * 0.5, 0, TAU);
    ctx.fill();
    this.drawBody(u, t);
    this.drawArms(u, false);
    this.drawArms(u, true);
    this.drawAntenna(u, t);
    // капюшон сзади без лица
    let hg = this.grads.get('back');
    if (!hg) {
      hg = ctx.createRadialGradient(-u * 0.3, -u * 0.7, u * 0.1, 0, -u * 0.2, u * 1.15);
      hg.addColorStop(0, rgb(mix(this.hood, [255, 255, 255], 0.12)));
      hg.addColorStop(0.6, rgb(this.hood));
      hg.addColorStop(1, rgb(mix(this.hood, [0, 0, 0], 0.7)));
      this.grads.set('back', hg);
    }
    ctx.fillStyle = hg;
    this.hoodPath(u);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = u * 0.03;
    ctx.beginPath();
    ctx.moveTo(0, -u * 1.0);
    ctx.quadraticCurveTo(u * 0.05, -u * 0.3, 0, u * 0.4);
    ctx.stroke();
    // рюкзак
    ctx.fillStyle = '#16161b';
    ctx.beginPath();
    ctx.roundRect(-u * 0.4, u * 0.28, u * 0.8, u * 0.66, u * 0.12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = u * 0.02;
    ctx.stroke();
    this.patch(-u * 0.15, u * 0.46, u * 0.3, u * 0.22);
  }
}
