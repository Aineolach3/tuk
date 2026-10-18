// Персонаж «Тук»: малыш в чёрном капюшоне с антенной, белая маска с большими глазами,
// тактическая куртка с нашивкой «Т» и рюкзак. Рта нет — настроение показывают глаза
// и огонёк на кончике антенны. Рисуется в Canvas 2D, одинаково на Windows и Android.

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
const rgb = (c: number[], a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const frac = (v: number) => ((v % 1) + 1) % 1;

interface Particle {
  kind: 'z' | 'heart' | 'spark' | 'note' | 'doc';
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  born: number;
  color?: string;
}

export class Character {
  mood: Mood = 'idle';
  private since = performance.now();
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private look = { x: 0, y: 0 };
  private lookTarget = { x: 0, y: 0 };
  private nextWander = 0;
  private nextBlink = performance.now() + 2500;
  private blinkUntil = 0;
  private particles: Particle[] = [];
  private lastSpawn = 0;
  private light: number[] = LIGHT.idle;
  private raf = 0;
  private clock = 0;
  private visible = true;
  /** Сдвиг вниз в долях высоты: в свёрнутой строке видна голова. */
  peek = 0;
  /** Наряд, цвет капюшона и цвет огонька в покое. */
  outfit: Outfit = 'none';
  hood: number[] = HOOD_COLORS['Чёрный'];
  idleLight: number[] | null = null;

  constructor(canvas: HTMLCanvasElement, opts: { still?: boolean; fixed?: boolean } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    if (opts.still) {
      // картинка без анимации — для превью в гардеробе; fixed — размер холста задан заранее
      if (!opts.fixed) this.resize();
      this.nextWander = Infinity;
      this.nextBlink = Infinity;
      return;
    }
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.resize();
    document.addEventListener('visibilitychange', () => {
      this.visible = !document.hidden;
      if (this.visible) this.loop();
    });
    this.loop();
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
    ch.mood = mood;
    ch.since = mood === 'away' ? 0 : -4000;
    // разогрев: частицы (Zzz, ноты, сердечки) успевают появиться
    if (mood !== 'away') for (let t = -3000; t < 0; t += 1000 / fps) ch.draw(t);
    const out = document.createElement('canvas');
    out.width = w * frames;
    out.height = h;
    const o = out.getContext('2d')!;
    for (let i = 0; i < frames; i++) {
      const now = (i * 1000) / fps;
      if (mood !== 'sleep' && i === 3) ch.blinkUntil = now + 130;
      ch.draw(now);
      o.drawImage(one, i * w, 0);
    }
    return out.toDataURL('image/png').split(',')[1];
  }

  set(mood: Mood): void {
    if (mood === this.mood) return;
    this.mood = mood;
    this.since = performance.now();
    this.blinkUntil = this.since + 120;
    if (mood !== 'sleep') this.particles = this.particles.filter((p) => p.kind !== 'z');
  }

  /** Куда смотреть: координаты в пикселях окна. */
  lookAtScreen(x: number, y: number): void {
    const r = this.canvas.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy) || 1;
    const k = clamp(d / 300, 0, 1);
    this.lookTarget = { x: (dx / d) * k, y: (dy / d) * k };
    this.nextWander = performance.now() + 2500;
  }

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    // clientWidth/Height не зависят от transform (анимации появления окна)
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
  }

  private loop = () => {
    cancelAnimationFrame(this.raf);
    if (!this.visible) return;
    this.draw(performance.now());
    this.raf = requestAnimationFrame(this.loop);
  };

  private spawn(p: Omit<Particle, 'born'>) {
    this.particles.push({ ...p, born: this.clock });
  }

  /** Яркость огонька 0..1 с учётом мигания. */
  private lightLevel(t: number): number {
    switch (this.mood) {
      case 'sleep': return 0.18 + 0.12 * Math.sin(t * 1.3);
      case 'think': return Math.sin(t * 9) > 0 ? 1 : 0.35;
      case 'alert': return Math.sin(t * 12) > -0.2 ? 1 : 0.2;
      case 'angry': return 0.75 + 0.25 * Math.sin(t * 20);
      case 'listen': return 0.75 + 0.25 * Math.sin(t * 5);
      default: return 0.85 + 0.15 * Math.sin(t * 2);
    }
  }

  draw(now: number): void {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    this.clock = now;
    const t = now / 1000;
    const age = (now - this.since) / 1000;
    const m = this.mood;

    // единица — полуширина капюшона; фигура с антенной занимает ~95% высоты
    const u = Math.min(W * 0.34, H * 0.31);
    let cx = W / 2, cy = H * 0.5 + u * 0.2 + this.peek * H;
    const baseCy = cy;
    let sx = 1, sy = 1, rot = 0;

    if (m === 'idle') cy += Math.sin(t * 2) * u * 0.025;
    if (m === 'sleep') cy += u * 0.03;
    if (m === 'listen') { sy = 1.03; cy -= u * 0.03; }
    if (m === 'think') rot = Math.sin(t * 1.3) * 0.05;
    if (m === 'write') rot = 0.06;
    if (m === 'happy') {
      const ph = frac(t * 2.4);
      const jump = Math.sin(ph * Math.PI);
      cy -= jump * u * 0.18;
      const squash = ph < 0.1 || ph > 0.93 ? 0.08 : 0;
      sy = 1 - squash;
      sx = 1 + squash;
    }
    if (m === 'angry') { cx += Math.sin(t * 45) * u * 0.03; }
    if (m === 'alert') cy -= Math.abs(Math.sin(t * 7)) * u * 0.08;
    if (m === 'meet') { cx += u * 0.35; rot = -0.06; }
    if (m === 'wave') rot = Math.sin(t * 6) * 0.04;
    if (m === 'poke') {
      const k = Math.exp(-age * 5) * Math.abs(Math.cos(age * 18));
      sy = 1 - 0.16 * k;
      sx = 1 + 0.12 * k;
    }
    if (m === 'dizzy') { rot = Math.sin(t * 5) * 0.18; cx += Math.sin(t * 2.5) * u * 0.06; }
    if (m === 'dance') {
      const beat = Math.abs(Math.sin(t * Math.PI * 2.1));
      cy -= beat * u * 0.12;
      rot = Math.sin(t * Math.PI * 1.05) * 0.14;
      sy = 1 - (1 - beat) * 0.05;
    }
    if (m === 'eat') sy = 1 + 0.1 * Math.sin(age * 14) * Math.exp(-age * 2);
    if (m === 'work') { cy += Math.abs(Math.sin(t * 9)) * u * 0.012; rot = 0.03; }
    if (m === 'search') { rot = 0.07 + Math.sin(t * 1.6) * 0.03; cx += Math.sin(t * 1.6) * u * 0.04; }
    if (m === 'ready') cy += Math.sin(t * 2) * u * 0.02;
    if (m === 'help') rot = -0.04;
    if (m === 'carry') { cy -= Math.abs(Math.sin(t * 7)) * u * 0.06; rot = 0.05 + Math.sin(t * 7) * 0.025; }
    if (m === 'near') { cx += u * 0.55; cy += u * 0.1; }
    if (m === 'away') {
      const k = clamp(age / 1.4, 0, 1);
      const sc = 1 - 0.3 * k;
      sx = sc; sy = sc;
      cy += -u * 0.25 * k + Math.sin(t * 2.2) * u * 0.035;
    }

    const target = m === 'idle' && this.idleLight ? this.idleLight : m === 'dance' ? [127 + 127 * Math.sin(t * 3), 127 + 127 * Math.sin(t * 3 + 2), 127 + 127 * Math.sin(t * 3 + 4)] : LIGHT[m];
    this.light = mix(this.light, target, 0.12);

    // взгляд
    if (now > this.nextWander) {
      this.nextWander = now + 1500 + Math.random() * 2500;
      this.lookTarget = { x: (Math.random() - 0.5) * 1.4, y: (Math.random() - 0.5) * 0.8 };
    }
    let lt = this.lookTarget;
    if (m === 'think') lt = { x: 0.5 + Math.cos(t * 2) * 0.3, y: -0.8 };
    if (m === 'write') lt = { x: 0.2, y: 0.9 };
    if (m === 'listen' || m === 'alert') lt = { x: 0, y: 0 };
    if (m === 'meet') lt = { x: -1, y: 0.2 };
    if (m === 'eat') lt = { x: 0, y: -0.9 };
    if (m === 'poke') lt = { x: 0, y: 0 };
    if (m === 'work') lt = { x: -0.35, y: 0.75 };
    if (m === 'search') lt = { x: 0.85, y: 0.35 };
    if (m === 'help') lt = { x: -0.9, y: -0.1 };
    if (m === 'carry') lt = { x: 0.6, y: 0 };
    if (m === 'near') lt = { x: -0.5, y: 0.1 };
    if (m === 'ready') lt = { x: 0, y: 0.1 };
    this.look.x += (lt.x - this.look.x) * 0.12;
    this.look.y += (lt.y - this.look.y) * 0.12;

    if (now > this.nextBlink) {
      this.blinkUntil = now + 130;
      this.nextBlink = now + 2400 + Math.random() * 3400;
    }
    const blinking = now < this.blinkUntil;

    ctx.save();
    ctx.translate(cx, cy);

    // тень на полу
    ctx.save();
    ctx.scale(1, 0.22);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(0, (baseCy + u * 1.12 - cy) * (1 / 0.22), u * 0.75, u * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.rotate(rot);
    ctx.scale(sx, sy);

    if (m === 'sleep') this.drawRest(u, t);
    else if (m === 'away') this.drawBack(u, t);
    else {
      if (m === 'help') this.drawChecklist(u, age);
      this.drawBackpack(u);
      this.drawBody(u, t);
      this.drawArms(u, t);
      if (m === 'write') this.drawTablet(u, t);
      this.drawAntenna(u, t);
      this.drawHood(u);
      this.drawFace(u, t, blinking);
      if (m === 'listen') this.drawHeadphones(u);
      else this.drawOutfit(u, t);
      if (m === 'wave' || m === 'think' || m === 'help' || m === 'search') this.drawArms(u, t, true);
      if (m === 'work') this.drawLaptop(u, t);
      if (m === 'ready') this.drawPad(u, t);
      if (m === 'carry') this.drawBoxes(u, t);
      if (m === 'search') this.drawLens(u, t);
      if (m === 'near') this.drawMug(u, -u * 1.22, u * 0.18, u * 0.92, true);
    }

    ctx.restore();

    if (m === 'meet') this.drawFriend(W, H, u, t, age);
    this.updateParticles(now, cx, cy, u);
  }

  // ---------- части тела ----------

  private fabric(y0: number, y1: number, light = 0.16): CanvasGradient {
    const g = this.ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, rgb(mix(this.hood, [255, 255, 255], light * 0.9)));
    g.addColorStop(1, rgb(mix(this.hood, [0, 0, 0], 0.65)));
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
    ctx.fillStyle = '#0d0d10';
    const walk = this.mood === 'carry' ? Math.sin(t * 7) : 0;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * u * 0.24 + s * walk * u * 0.1, u * 1.02 - Math.max(0, s * walk) * u * 0.08, u * 0.22, u * 0.13, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(s * u * 0.24 - u * 0.16, u * 1.04, u * 0.32, u * 0.025);
      ctx.fillStyle = '#0d0d10';
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

  private drawArms(u: number, t: number, front = false) {
    const { ctx } = this;
    const m = this.mood;
    const arm = (side: number, angle: number, out = 0.5) => {
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
      ctx.arc(0, u * 0.44, u * 0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };
    let l = 0.25, r = -0.25;
    if (m === 'happy') { l = 2.5; r = -2.5; }
    if (m === 'meet') l = 2.4 + Math.sin(t * 10) * 0.4;
    if (m === 'listen') { l = 0.6; r = -0.6; }
    if (m === 'write') { l = -0.5; r = 0.5; }
    if (m === 'angry') { l = -0.3; r = 0.3; }
    if (m === 'alert') r = -2.2 + Math.sin(t * 9) * 0.3;
    if (m === 'wave') {
      // машущая рука рисуется поверх капюшона
      if (front) arm(1, -2.6 + Math.sin(t * 12) * 0.35, 0.6);
      else arm(-1, l);
      return;
    }
    if (m === 'think') {
      // рука у подбородка — поверх маски
      if (front) arm(1, 1.95 + Math.sin(t * 1.3) * 0.04, 0.48);
      else arm(-1, 0.3);
      return;
    }
    if (m === 'help') {
      // показывает на список слева
      if (front) arm(-1, 2.05 + Math.sin(t * 3) * 0.08, 0.5);
      else arm(1, -0.25);
      return;
    }
    if (m === 'search') {
      // правая рука держит лупу
      if (front) arm(1, -0.55, 0.5);
      else arm(-1, 0.35);
      return;
    }
    if (front) return;
    if (m === 'work') { const k = Math.sin(t * 18) * 0.06; l = -0.75 + k; r = 0.75 + k; }
    if (m === 'ready') { l = -0.55; r = 0.55; }
    if (m === 'carry') { l = -0.95; r = 0.95; }
    if (m === 'near') { l = 0.3; r = -1.9; }
    if (m === 'dance') {
      const ph = Math.sin(t * Math.PI * 1.05);
      l = 1.2 + ph * 1.2;
      r = -1.2 + ph * 1.2;
    }
    if (m === 'dizzy') { l = 0.9 + Math.sin(t * 4) * 0.3; r = -0.9 + Math.cos(t * 4) * 0.3; }
    if (m === 'poke') { l = 0.7; r = -0.7; }
    arm(-1, l);
    arm(1, r);
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

  private drawAntenna(u: number, t: number) {
    const { ctx } = this;
    const m = this.mood;
    let sway = Math.sin(t * 1.8) * 0.08;
    if (m === 'sleep') sway = 0.45;
    if (m === 'happy') sway = Math.sin(t * 8) * 0.25;
    if (m === 'angry') sway = Math.sin(t * 40) * 0.05;
    if (m === 'listen' || m === 'alert') sway = -0.1 + Math.sin(t * 6) * 0.05;
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
    // огонёк
    const lvl = this.lightLevel(t);
    const tipX = u * 0.38, tipY = -u * 0.44;
    const glow = ctx.createRadialGradient(tipX, tipY, 0, tipX, tipY, u * 0.45);
    glow.addColorStop(0, rgb(this.light, 0.55 * lvl));
    glow.addColorStop(1, rgb(this.light, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(tipX, tipY, u * 0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = rgb(mix([40, 40, 46], [255, 255, 255], lvl * 0.6 + 0.2));
    ctx.beginPath();
    ctx.arc(tipX, tipY, u * 0.065, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = rgb(this.light, lvl);
    ctx.beginPath();
    ctx.arc(tipX, tipY, u * 0.045, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawHood(u: number) {
    const { ctx } = this;
    // купол капюшона
    const g = ctx.createRadialGradient(-u * 0.35, -u * 0.75, u * 0.1, 0, -u * 0.2, u * 1.15);
    g.addColorStop(0, rgb(mix(this.hood, [255, 255, 255], 0.14)));
    g.addColorStop(0.55, rgb(this.hood));
    g.addColorStop(1, rgb(mix(this.hood, [0, 0, 0], 0.7)));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -u * 1.05);
    ctx.bezierCurveTo(u * 0.66, -u * 1.05, u * 1.0, -u * 0.6, u * 0.98, -u * 0.1);
    ctx.bezierCurveTo(u * 0.97, u * 0.25, u * 0.75, u * 0.45, u * 0.42, u * 0.42);
    ctx.lineTo(-u * 0.42, u * 0.42);
    ctx.bezierCurveTo(-u * 0.75, u * 0.45, -u * 0.97, u * 0.25, -u * 0.98, -u * 0.1);
    ctx.bezierCurveTo(-u * 1.0, -u * 0.6, -u * 0.66, -u * 1.05, 0, -u * 1.05);
    ctx.fill();
    // вязка: вертикальные рубчики
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.022)';
    ctx.lineWidth = u * 0.03;
    for (let x = -u; x <= u; x += u * 0.09) {
      ctx.beginPath();
      ctx.moveTo(x, -u * 1.1);
      ctx.quadraticCurveTo(x * 1.15, -u * 0.3, x * 1.05, u * 0.5);
      ctx.stroke();
    }
    ctx.restore();
    // контровой свет по краю — чтобы чёрный капюшон читался на чёрном фоне
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = u * 0.035;
    ctx.beginPath();
    ctx.moveTo(u * 0.1, -u * 1.03);
    ctx.bezierCurveTo(u * 0.66, -u * 1.0, u * 0.97, -u * 0.6, u * 0.96, -u * 0.12);
    ctx.stroke();
    // нашивка на капюшоне
    this.patch(-u * 0.12, -u * 0.86, u * 0.24, u * 0.17);
    // край капюшона вокруг лица
    ctx.fillStyle = rgb(mix(this.hood, [0, 0, 0], 0.55));
    ctx.beginPath();
    ctx.ellipse(0, -u * 0.06, u * 0.78, u * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = u * 0.025;
    ctx.stroke();
  }

  private drawFace(u: number, t: number, blinking: boolean) {
    const { ctx } = this;
    const m = this.mood;
    // белая маска
    const fg = ctx.createRadialGradient(-u * 0.2, -u * 0.25, u * 0.05, 0, 0, u * 0.75);
    fg.addColorStop(0, '#ffffff');
    fg.addColorStop(0.7, '#ecebef');
    fg.addColorStop(1, '#c9c8cf');
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.ellipse(0, -u * 0.04, u * 0.66, u * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    // румянец, когда добрый
    if (m === 'happy') {
      ctx.fillStyle = 'rgba(255,120,140,0.25)';
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(s * u * 0.45, u * 0.14, u * 0.1, u * 0.05, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const lx = this.look.x * u * 0.08, ly = this.look.y * u * 0.06;
    const ex = u * 0.24, ey = -u * 0.06;
    let rx = u * 0.125, ry = u * 0.21;
    if (m === 'listen' || m === 'alert') { rx *= 1.12; ry *= 1.12; }

    ctx.fillStyle = INK;
    ctx.strokeStyle = INK;
    ctx.lineCap = 'round';

    for (const s of [-1, 1]) {
      const x = s * ex + lx, y = ey + ly;
      if (m === 'dizzy') {
        // спирали вместо глаз
        ctx.lineWidth = u * 0.035;
        ctx.beginPath();
        for (let a = 0; a < Math.PI * 5; a += 0.25) {
          const rr = u * 0.012 * a;
          const px = x + Math.cos(a + t * 6 * s) * rr, py = y + Math.sin(a + t * 6 * s) * rr;
          if (a === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
        continue;
      }
      if (m === 'happy' || m === 'dance' || (m === 'eat' && (this.clock - this.since) > 450)) {
        ctx.lineWidth = u * 0.075;
        ctx.beginPath();
        ctx.arc(x, y + u * 0.08, u * 0.12, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
        continue;
      }
      if (m === 'sleep' || blinking) {
        ctx.lineWidth = u * 0.06;
        ctx.beginPath();
        if (m === 'sleep') ctx.arc(x, y - u * 0.04, u * 0.1, Math.PI * 0.15, Math.PI * 0.85);
        else {
          ctx.moveTo(x - u * 0.09, y);
          ctx.lineTo(x + u * 0.09, y);
        }
        ctx.stroke();
        continue;
      }
      let ryy = ry;
      if (m === 'think' && s > 0) ryy *= 0.85;
      ctx.save();
      if (m === 'poke') {
        // недовольный прищур: верх глаз срезан ровно
        ctx.beginPath();
        ctx.rect(x - rx * 2, y - ryy * 0.15, rx * 4, ryy * 3);
        ctx.clip();
      }
      if (m === 'angry') {
        // злой прищур: верх глаза срезан наклонной линией
        ctx.beginPath();
        ctx.moveTo(x - s * rx * 2, y - ryy * 0.75);
        ctx.lineTo(x + s * rx * 2, y - ryy * 0.05);
        ctx.lineTo(x + s * rx * 2, y + ryy * 2);
        ctx.lineTo(x - s * rx * 2, y + ryy * 2);
        ctx.closePath();
        ctx.clip();
      }
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ryy, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // блик
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.ellipse(x - rx * 0.35, y - ryy * 0.45, rx * 0.22, ryy * 0.16, -0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = INK;
    }
    void t;
  }

  // ---------- Наряды ----------

  private drawOutfit(u: number, t: number) {
    const { ctx } = this;
    const o = this.outfit;
    if (o === 'none') return;
    ctx.save();
    if (o === 'scarf' || o === 'santa') {
      // вязаный шарф на шее
      const red = o === 'santa' ? '#c8242f' : '#b8432f';
      ctx.fillStyle = red;
      ctx.beginPath();
      ctx.roundRect(-u * 0.56, u * 0.3, u * 1.12, u * 0.2, u * 0.1);
      ctx.fill();
      ctx.save();
      ctx.translate(u * 0.28, u * 0.42);
      ctx.rotate(0.12 + Math.sin(t * 2) * 0.05);
      ctx.beginPath();
      ctx.roundRect(-u * 0.1, 0, u * 0.2, u * 0.42, u * 0.05);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      for (let i = 0; i < 2; i++) ctx.fillRect(-u * 0.1, u * (0.14 + i * 0.12), u * 0.2, u * 0.035);
      ctx.restore();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = u * 0.015;
      for (let x = -0.48; x < 0.5; x += 0.08) {
        ctx.beginPath();
        ctx.moveTo(u * x, u * 0.32);
        ctx.lineTo(u * (x + 0.03), u * 0.48);
        ctx.stroke();
      }
    }
    if (o === 'santa') {
      // красная шапка поверх капюшона
      ctx.fillStyle = '#d0262f';
      ctx.beginPath();
      ctx.moveTo(-u * 0.72, -u * 0.72);
      ctx.quadraticCurveTo(-u * 0.2, -u * 1.55, u * 0.62, -u * 1.25);
      ctx.quadraticCurveTo(u * 0.35, -u * 1.0, u * 0.72, -u * 0.72);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#f4f4f6';
      ctx.beginPath();
      ctx.roundRect(-u * 0.8, -u * 0.82, u * 1.6, u * 0.2, u * 0.1);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(u * 0.66, -u * 1.24, u * 0.13, 0, Math.PI * 2);
      ctx.fill();
    }
    if (o === 'glasses') {
      ctx.fillStyle = '#050507';
      for (const sd of [-1, 1]) {
        ctx.beginPath();
        ctx.roundRect(sd * u * 0.24 - u * 0.2, -u * 0.2, u * 0.4, u * 0.26, u * 0.1);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath();
        ctx.ellipse(sd * u * 0.24 - u * 0.07, -u * 0.12, u * 0.06, u * 0.025, -0.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#050507';
      }
      ctx.fillRect(-u * 0.06, -u * 0.13, u * 0.12, u * 0.04);
    }
    if (o === 'headphones') {
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
        ctx.arc(sd * u * 0.95, -u * 0.11, u * 0.05, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (o === 'pumpkin') {
      const y = u * 0.62;
      ctx.fillStyle = '#ef7d1a';
      for (const dx of [-0.13, 0, 0.13]) {
        ctx.beginPath();
        ctx.ellipse(u * dx, y, u * 0.16, u * 0.17, 0, 0, Math.PI * 2);
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
        for (let k = 0; k < 5; k++) {
          const b = (k / 5) * Math.PI * 2 + t * 0.5;
          ctx.beginPath();
          ctx.arc(x + Math.cos(b) * u * 0.055, y + Math.sin(b) * u * 0.055, u * 0.045, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = '#fff3b0';
        ctx.beginPath();
        ctx.arc(x, y, u * 0.035, 0, Math.PI * 2);
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
      ctx.arc(0, u * 0.38, u * 0.05, 0, Math.PI * 2);
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
      ctx.fillStyle = '#e8394a';
      ctx.beginPath();
      ctx.arc(0, -u * 1.06, u * 0.04, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawFriend(W: number, H: number, u: number, t: number, age: number) {
    const { ctx } = this;
    const s = u * 0.55;
    const slide = clamp(age / 0.6, 0, 1);
    const x = -s * 1.4 + slide * (W * 0.5 - u * 0.75 + s * 1.4) * 0.7;
    const y = H * 0.5 + u * 0.55 + Math.sin(t * 3) * s * 0.04;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = '#3d4250';
    ctx.beginPath();
    ctx.ellipse(0, -s * 0.2, s * 0.95, s * 0.85, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ecebef';
    ctx.beginPath();
    ctx.ellipse(s * 0.08, -s * 0.12, s * 0.62, s * 0.46, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = INK;
    for (const d of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(d * s * 0.22 + s * 0.16, -s * 0.12, s * 0.09, s * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = rgb(LIGHT.meet, 0.9);
    ctx.beginPath();
    ctx.arc(s * 0.3, -s * 1.15 + Math.sin(t * 10) * s * 0.03, s * 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private updateParticles(now: number, cx: number, cy: number, u: number) {
    const { ctx } = this;
    const m = this.mood;
    const every = m === 'sleep' ? 1400 : m === 'happy' ? 500 : m === 'angry' ? 260 : m === 'dance' ? 420 : 0;
    if (every && now - this.lastSpawn > every) {
      this.lastSpawn = now;
      if (m === 'sleep') this.spawn({ kind: 'z', x: cx + u * 0.75, y: cy - u * 0.55, vx: u * 0.15, vy: -u * 0.35, life: 2.6 });
      if (m === 'happy') this.spawn({ kind: 'heart', x: cx + (Math.random() - 0.5) * u * 1.4, y: cy - u * 1.0, vx: (Math.random() - 0.5) * u * 0.3, vy: -u * 0.55, life: 1.4 });
      if (m === 'dance') this.spawn({ kind: 'note', x: cx + (Math.random() - 0.5) * u * 1.6, y: cy - u * 0.9, vx: (Math.random() - 0.5) * u * 0.3, vy: -u * 0.5, life: 1.6, color: rgb(this.light) });
      if (m === 'angry')
        this.spawn({ kind: 'spark', x: cx + u * 0.4, y: cy - u * 1.42, vx: (Math.random() - 0.5) * u * 1.2, vy: -u * (0.4 + Math.random() * 0.6), life: 0.6, color: rgb(LIGHT.angry) });
    }

    this.particles = this.particles.filter((p) => (now - p.born) / 1000 < p.life);
    for (const p of this.particles) {
      const a = (now - p.born) / 1000;
      const k = a / p.life;
      const x = p.x + p.vx * a, y = p.y + p.vy * a;
      ctx.save();
      ctx.globalAlpha = 1 - k;
      if (p.kind === 'z') {
        ctx.fillStyle = '#aebcff';
        ctx.font = `700 ${u * (0.32 + k * 0.25)}px system-ui, sans-serif`;
        ctx.fillText('z', x, y);
      } else if (p.kind === 'heart') {
        ctx.fillStyle = '#ff5d7a';
        const r = u * 0.12 * (1 + k * 0.4);
        ctx.translate(x, y);
        ctx.beginPath();
        ctx.moveTo(0, r * 0.8);
        ctx.bezierCurveTo(-r * 1.6, -r * 0.3, -r * 0.6, -r * 1.4, 0, -r * 0.4);
        ctx.bezierCurveTo(r * 0.6, -r * 1.4, r * 1.6, -r * 0.3, 0, r * 0.8);
        ctx.fill();
      } else if (p.kind === 'note') {
        ctx.fillStyle = p.color ?? '#fff';
        ctx.font = `700 ${u * 0.36}px system-ui, sans-serif`;
        ctx.fillText(Math.floor(p.born) % 2 ? '♪' : '♫', x, y);
      } else if (p.kind === 'spark') {
        ctx.fillStyle = p.color ?? '#fff';
        ctx.beginPath();
        ctx.arc(x, y + u * 0.8 * a * a, u * 0.035, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    if (m === 'dizzy') {
      for (let i = 0; i < 3; i++) {
        const a = now / 400 + (i * Math.PI * 2) / 3;
        ctx.fillStyle = '#ffe36b';
        ctx.font = `700 ${u * 0.28}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('★', cx + Math.cos(a) * u * 0.7, cy - u * 1.15 + Math.sin(a) * u * 0.15);
        ctx.textAlign = 'start';
      }
    }
    if (m === 'eat') {
      // файл влетает в капюшон
      const k = clamp((now - this.since) / 600, 0, 1);
      if (k < 1) {
        ctx.save();
        ctx.translate(cx + u * 1.2 * (1 - k), cy - u * 1.3 * (1 - k) - u * 0.1);
        ctx.rotate((1 - k) * 0.8);
        ctx.scale(1 - k * 0.7, 1 - k * 0.7);
        ctx.fillStyle = '#f3f3f6';
        ctx.fillRect(-u * 0.2, -u * 0.26, u * 0.4, u * 0.52);
        ctx.fillStyle = '#9aa0ad';
        for (let i = 0; i < 4; i++) ctx.fillRect(-u * 0.13, -u * 0.15 + i * u * 0.09, u * 0.26, u * 0.03);
        ctx.restore();
      }
    }
    if (m === 'think') this.bubble(cx + u * 1.02, cy - u * 0.95, u, (bx, by) => {
      for (let i = 0; i < 3; i++) {
        const ph = (now / 1000) * 5 - i * 0.7;
        ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.65 * Math.max(0, Math.sin(ph))})`;
        ctx.beginPath();
        ctx.arc(bx + (i - 1) * u * 0.15, by, u * 0.05, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    if (m === 'search') this.floatingCards(cx, cy, u, now / 1000);
    if (m === 'carry') {
      for (let i = 0; i < 3; i++) {
        const k = frac((now / 1000) * 1.4 + i / 3);
        ctx.fillStyle = `rgba(200,200,215,${0.35 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(cx - u * (0.55 + k * 0.6), cy + u * (1.05 - k * 0.15), u * (0.05 + k * 0.08), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (m === 'alert') {
      ctx.fillStyle = rgb(LIGHT.alert);
      ctx.font = `900 ${u * 0.7}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('!', cx - u * 0.95, cy - u * 0.6 + Math.sin(now / 90) * u * 0.04);
      ctx.textAlign = 'start';
    }
    if (m === 'listen') {
      this.bubble(cx - u * 1.12, cy - u * 0.35, u, (bx, by) => {
        for (let i = 0; i < 5; i++) {
          const hgt = u * (0.06 + 0.13 * Math.abs(Math.sin(now / 160 + i * 1.3)));
          ctx.fillStyle = rgb(LIGHT.listen, 0.95);
          ctx.beginPath();
          ctx.roundRect(bx + (i - 2) * u * 0.085 - u * 0.025, by - hgt / 2, u * 0.05, hgt, u * 0.025);
          ctx.fill();
        }
      }, true);
      for (let i = 0; i < 2; i++) {
        const k = frac((now / 1000) * 0.9 + i * 0.5);
        ctx.strokeStyle = rgb(LIGHT.listen, (1 - k) * 0.6);
        ctx.lineWidth = u * 0.04;
        ctx.beginPath();
        ctx.arc(cx, cy - u * 0.2, u * (1.05 + k * 0.45), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // ---------- Позы и предметы ----------

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
        ctx.arc(mx, my, u * 0.12, 0, Math.PI * 2);
        ctx.moveTo(mx - u * 0.12, my);
        ctx.lineTo(mx + u * 0.12, my);
        ctx.moveTo(mx, my - u * 0.12);
        ctx.ellipse(mx, my, u * 0.05, u * 0.12, 0, -Math.PI / 2, Math.PI * 1.5);
        ctx.stroke();
      }
    });
  }

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
    ctx.arc(lx, ly, u * 0.27, 0, Math.PI * 2);
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
    ctx.ellipse(0, u * 0.1, u * 0.6, u * 0.32, 0, 0, Math.PI * 2);
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
    const g = ctx.createLinearGradient(-u * 0.7, u * 0.35, u * 0.5, u * 0.95);
    g.addColorStop(0, '#5a5c66');
    g.addColorStop(1, '#2c2d34');
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
    if (Math.sin(t * 5) > 0) {
      ctx.fillStyle = rgb(this.light, 0.9);
      ctx.fillRect(u * 0.14, u * 0.06, u * 0.06, u * 0.025);
    }
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
      ctx.arc(u * 0.04 + sd * u * 0.52, u * 0.66 + bob, u * 0.1, 0, Math.PI * 2);
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
      if (step > i + 0.3) {
        ctx.strokeStyle = '#7cf0b4';
        ctx.lineWidth = u * 0.04;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x + u * 0.13, ry);
        ctx.lineTo(x + u * 0.17, ry + u * 0.04);
        ctx.lineTo(x + u * 0.24, ry - u * 0.05);
        ctx.stroke();
      }
    }
  }

  /** Большая кружка с «Т»; front — Тук выглядывает из-за неё (рука на краю). */
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
    ctx.ellipse(x + w / 2, y + size * 0.02, w / 2, size * 0.05, 0, 0, Math.PI * 2);
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
      ctx.arc(x + w * 0.98, y + size * 0.04, u * 0.1, 0, Math.PI * 2);
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
      ctx.arc(sd * u * 0.95, -u * 0.11, u * 0.05, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** «Отдыхает»: лежит, голова на полу, тело позади, рядом кружка. */
  private drawRest(u: number, t: number) {
    const { ctx } = this;
    const breathe = Math.sin(t * 1.4) * u * 0.015;
    ctx.save();
    ctx.translate(u * 0.5, 0);
    // тело лёжа позади головы
    ctx.fillStyle = this.fabric(u * 0.4, u * 1.1, 0.14);
    ctx.beginPath();
    ctx.ellipse(-u * 0.95, u * 0.82 + breathe, u * 0.85, u * 0.3, -0.05, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#121216';
    ctx.beginPath();
    ctx.roundRect(-u * 1.35, u * 0.42 + breathe, u * 0.62, u * 0.3, u * 0.1);
    ctx.fill();
    this.patch(-u * 1.12, u * 0.48 + breathe, u * 0.16, u * 0.12);
    ctx.fillStyle = '#0d0d10';
    ctx.beginPath();
    ctx.ellipse(-u * 1.78, u * 0.92, u * 0.16, u * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
    // голова лежит на полу
    ctx.save();
    ctx.translate(u * 0.1, u * 0.5);
    ctx.rotate(0.12);
    ctx.scale(0.92, 0.92);
    this.drawAntenna(u, t);
    this.drawHood(u);
    this.drawFace(u, t, false);
    this.drawOutfitHead(u, t);
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
    ctx.arc(0, u * 1.15, u * 0.5, 0, Math.PI * 2);
    ctx.fill();
    this.drawBody(u, t);
    this.drawArms(u, t);
    this.drawAntenna(u, t);
    // капюшон сзади без лица
    const hg = ctx.createRadialGradient(-u * 0.3, -u * 0.7, u * 0.1, 0, -u * 0.2, u * 1.15);
    hg.addColorStop(0, rgb(mix(this.hood, [255, 255, 255], 0.12)));
    hg.addColorStop(0.6, rgb(this.hood));
    hg.addColorStop(1, rgb(mix(this.hood, [0, 0, 0], 0.7)));
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.moveTo(0, -u * 1.05);
    ctx.bezierCurveTo(u * 0.66, -u * 1.05, u * 1.0, -u * 0.6, u * 0.98, -u * 0.1);
    ctx.bezierCurveTo(u * 0.97, u * 0.25, u * 0.75, u * 0.45, u * 0.42, u * 0.42);
    ctx.lineTo(-u * 0.42, u * 0.42);
    ctx.bezierCurveTo(-u * 0.75, u * 0.45, -u * 0.97, u * 0.25, -u * 0.98, -u * 0.1);
    ctx.bezierCurveTo(-u * 1.0, -u * 0.6, -u * 0.66, -u * 1.05, 0, -u * 1.05);
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

  /** Наряды на голове (для позы лёжа). */
  private drawOutfitHead(u: number, t: number) {
    if (this.outfit === 'santa' || this.outfit === 'glasses' || this.outfit === 'crown' || this.outfit === 'flowers' || this.outfit === 'headphones') this.drawOutfit(u, t);
  }

}
