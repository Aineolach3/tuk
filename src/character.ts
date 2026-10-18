// Персонаж «Тук»: персиковый колобок с ростком на макушке. Рисуется в Canvas 2D,
// поэтому одинаково работает на Windows и Android.

export type Mood = 'sleep' | 'idle' | 'listen' | 'think' | 'write' | 'happy' | 'angry' | 'alert' | 'meet';

export const MOOD_LABEL: Record<Mood, string> = {
  sleep: 'Спит',
  idle: 'Бодрствует',
  listen: 'Слушает',
  think: 'Думает',
  write: 'Записывает',
  happy: 'Добрый',
  angry: 'Злой',
  alert: 'Напоминает',
  meet: 'Встреча',
};

const C = {
  body: [255, 178, 122] as [number, number, number],
  bodyDark: [236, 130, 88] as [number, number, number],
  angry: [255, 102, 84] as [number, number, number],
  belly: 'rgba(255,240,220,0.55)',
  ink: '#2a1f3d',
  cheek: 'rgba(255,105,120,0.45)',
  leaf: '#6cc46a',
  leafDark: '#3f9a4c',
  bulb: '#ffd84a',
  friend: [120, 205, 220] as [number, number, number],
};

const rgb = (c: number[], a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

interface Particle {
  kind: 'z' | 'heart' | 'puff' | 'spark';
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  born: number;
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
  private anger = 0; // плавный переход цвета
  private raf = 0;
  private visible = true;
  /** Сдвиг вниз в долях высоты: в свёрнутой строке видны только глаза. */
  peek = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.resize();
    document.addEventListener('visibilitychange', () => {
      this.visible = !document.hidden;
      if (this.visible) this.loop();
    });
    this.loop();
  }

  set(mood: Mood): void {
    if (mood === this.mood) return;
    this.mood = mood;
    this.since = performance.now();
    this.blinkUntil = this.since + 120;
    if (mood === 'write') this.particles = this.particles.filter((p) => p.kind !== 'z');
  }

  /** Куда смотреть: координаты в пикселях окна. */
  lookAtScreen(x: number, y: number): void {
    const r = this.canvas.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = x - cx, dy = y - cy;
    const d = Math.hypot(dx, dy) || 1;
    const k = clamp(d / 300, 0, 1);
    this.lookTarget = { x: (dx / d) * k, y: (dy / d) * k };
    this.nextWander = performance.now() + 2500;
  }

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
  }

  private loop = () => {
    cancelAnimationFrame(this.raf);
    if (!this.visible) return;
    this.draw(performance.now());
    this.raf = requestAnimationFrame(this.loop);
  };

  private spawn(kind: Particle['kind'], x: number, y: number, vx: number, vy: number, life: number) {
    this.particles.push({ kind, x, y, vx, vy, life, born: performance.now() });
  }

  draw(now: number): void {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const t = now / 1000;
    const age = (now - this.since) / 1000;
    const m = this.mood;

    // единица — радиус тела; персонаж занимает ~70% высоты холста
    const u = Math.min(W, H) * 0.32;
    let cx = W / 2, cy = H / 2 + u * 0.12 + this.peek * H;
    let sx = 1, sy = 1, rot = 0;
    const baseCy = cy;

    // --- движение тела по состояниям ---
    if (m === 'idle') cy += Math.sin(t * 2) * u * 0.03;
    if (m === 'sleep') { sy = 1 + Math.sin(t * 1.4) * 0.035; sx = 1 - Math.sin(t * 1.4) * 0.02; cy += u * 0.04; }
    if (m === 'listen') { sy = 1.04; cy -= u * 0.04; }
    if (m === 'think') { rot = Math.sin(t * 1.3) * 0.06; }
    if (m === 'write') { rot = 0.12 + Math.sin(t * 9) * 0.015; }
    if (m === 'happy') {
      const ph = (t * 2.6) % 1;
      const jump = Math.sin(ph * Math.PI);
      cy -= jump * u * 0.2;
      const squash = ph < 0.12 || ph > 0.92 ? 0.12 : 0;
      sy = 1 - squash + jump * 0.05;
      sx = 1 + squash - jump * 0.03;
    }
    if (m === 'angry') { cx += Math.sin(t * 45) * u * 0.035; sy = 0.97; }
    if (m === 'alert') { cy -= Math.abs(Math.sin(t * 7)) * u * 0.12; }
    if (m === 'meet') { cx += u * 0.25; rot = -0.08; }

    this.anger += ((m === 'angry' ? 1 : 0) - this.anger) * 0.08;

    // --- взгляд ---
    if (now > this.nextWander) {
      this.nextWander = now + 1500 + Math.random() * 2500;
      this.lookTarget = { x: (Math.random() - 0.5) * 1.4, y: (Math.random() - 0.5) * 0.8 };
    }
    let lt = this.lookTarget;
    if (m === 'think') lt = { x: Math.cos(t * 2.2) * 0.6, y: -0.6 + Math.sin(t * 2.2) * 0.25 };
    if (m === 'write') lt = { x: 0.5, y: 0.8 };
    if (m === 'listen' || m === 'alert') lt = { x: 0, y: 0 };
    if (m === 'meet') lt = { x: -1, y: 0.1 };
    this.look.x += (lt.x - this.look.x) * 0.12;
    this.look.y += (lt.y - this.look.y) * 0.12;

    // --- моргание ---
    if (now > this.nextBlink) {
      this.blinkUntil = now + 130;
      this.nextBlink = now + 2200 + Math.random() * 3200;
    }
    const blinking = now < this.blinkUntil;

    ctx.save();
    ctx.translate(cx, cy);

    // тень
    ctx.save();
    ctx.scale(1, 0.25);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    const shadowShrink = m === 'happy' ? 1 - Math.sin(((t * 2.6) % 1) * Math.PI) * 0.4 : 1;
    ctx.ellipse(0, (baseCy + u * 0.98 - cy) * 4, u * 0.8 * shadowShrink, u * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.rotate(rot);
    ctx.scale(sx, sy);

    // ножки
    ctx.fillStyle = rgb(mix(C.bodyDark, C.angry, this.anger * 0.6));
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * u * 0.38, u * 0.86, u * 0.2, u * 0.13, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // росток
    this.drawSprout(u, t, age);

    // ручки (за телом)
    const armColor = rgb(mix(C.bodyDark, C.angry, this.anger * 0.6));
    const wave = m === 'meet' ? Math.sin(t * 10) * 0.6 : m === 'happy' ? -0.9 : m === 'listen' ? -0.5 : 0;
    this.drawArm(-1, u, armColor, m === 'meet' ? -1.6 + wave : wave);
    this.drawArm(1, u, armColor, m === 'write' ? 0.5 + Math.sin(t * 9) * 0.15 : m === 'angry' ? 0.3 : wave * 0.6);

    // тело
    const bodyCol = mix(C.body, C.angry, this.anger);
    const g = ctx.createRadialGradient(-u * 0.35, -u * 0.45, u * 0.1, 0, 0, u * 1.15);
    g.addColorStop(0, rgb(mix(bodyCol, [255, 255, 255], 0.35)));
    g.addColorStop(0.6, rgb(bodyCol));
    g.addColorStop(1, rgb(mix(bodyCol, C.bodyDark, 0.7)));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -u * 0.9);
    ctx.bezierCurveTo(u * 0.62, -u * 0.92, u * 1.02, -u * 0.5, u * 1.0, u * 0.05);
    ctx.bezierCurveTo(u * 0.98, u * 0.62, u * 0.6, u * 0.92, 0, u * 0.9);
    ctx.bezierCurveTo(-u * 0.6, u * 0.92, -u * 0.98, u * 0.62, -u * 1.0, u * 0.05);
    ctx.bezierCurveTo(-u * 1.02, -u * 0.5, -u * 0.62, -u * 0.92, 0, -u * 0.9);
    ctx.fill();

    // светлое брюшко
    ctx.fillStyle = C.belly;
    ctx.beginPath();
    ctx.ellipse(0, u * 0.42, u * 0.5, u * 0.36, 0, 0, Math.PI * 2);
    ctx.fill();

    // щёчки
    ctx.fillStyle = C.cheek;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * u * 0.6, u * 0.16, u * 0.14, u * 0.08, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    this.drawFace(u, t, blinking);

    // карандаш при записи
    if (m === 'write') this.drawPencil(u, t);

    ctx.restore();

    // друг при встрече
    if (m === 'meet') this.drawFriend(W, H, u, t, age);

    // --- частицы ---
    this.updateParticles(now, cx, cy, u);
  }

  private drawSprout(u: number, t: number, age: number) {
    const { ctx } = this;
    const m = this.mood;
    let bend = Math.sin(t * 1.8) * 0.12;
    if (m === 'sleep') bend = 1.05 + Math.sin(t * 1.4) * 0.05;
    if (m === 'angry') bend = Math.sin(t * 40) * 0.05;
    if (m === 'listen' || m === 'alert') bend = Math.sin(t * 6) * 0.06;
    if (m === 'happy') bend = Math.sin(t * 8) * 0.3;
    ctx.save();
    ctx.translate(0, -u * 0.86);
    ctx.rotate(bend);
    ctx.strokeStyle = C.leafDark;
    ctx.lineWidth = u * 0.07;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(u * 0.06, -u * 0.18, 0, -u * 0.34);
    ctx.stroke();
    // листья
    const open = m === 'sleep' ? 0.35 : m === 'angry' ? 1.25 : 1;
    for (const s of [-1, 1]) {
      ctx.save();
      ctx.translate(0, -u * 0.32);
      ctx.rotate(s * (0.9 * open) - 0.1);
      ctx.fillStyle = s < 0 ? C.leaf : C.leafDark;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(s * u * 0.12, -u * 0.18, 0, -u * 0.32);
      ctx.quadraticCurveTo(-s * u * 0.05, -u * 0.16, 0, 0);
      ctx.fill();
      ctx.restore();
    }
    // «лампочка» — думает
    if (m === 'think') {
      const pulse = 0.6 + Math.sin(t * 6) * 0.4;
      const r = u * (0.11 + Math.min(age, 0.3) * 0.1);
      ctx.save();
      ctx.translate(0, -u * 0.5);
      ctx.shadowColor = C.bulb;
      ctx.shadowBlur = u * 0.6 * pulse;
      ctx.fillStyle = C.bulb;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  private drawArm(side: number, u: number, color: string, lift: number) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(side * u * 0.9, u * 0.2);
    ctx.rotate(side * (0.5 + lift * -1) * 0.7);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(side * u * 0.12, 0, u * 0.2, u * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawFace(u: number, t: number, blinking: boolean) {
    const { ctx } = this;
    const m = this.mood;
    const ex = u * 0.36, ey = -u * 0.12;
    let er = m === 'listen' || m === 'alert' ? 1.15 : 1;
    if (m === 'think') er = 0.95;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const closed = m === 'sleep' || blinking;
    const happyEyes = m === 'happy';

    for (const s of [-1, 1]) {
      const x = s * ex;
      if (happyEyes) {
        ctx.strokeStyle = C.ink;
        ctx.lineWidth = u * 0.09;
        ctx.beginPath();
        ctx.arc(x, ey + u * 0.06, u * 0.15, Math.PI * 1.1, Math.PI * 1.9);
        ctx.stroke();
        continue;
      }
      if (closed) {
        ctx.strokeStyle = C.ink;
        ctx.lineWidth = u * 0.07;
        ctx.beginPath();
        if (m === 'sleep') ctx.arc(x, ey - u * 0.02, u * 0.15, Math.PI * 0.15, Math.PI * 0.85);
        else {
          ctx.moveTo(x - u * 0.16, ey);
          ctx.lineTo(x + u * 0.16, ey);
        }
        ctx.stroke();
        continue;
      }
      // белок
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(x, ey, u * 0.2 * er, u * 0.25 * er, 0, 0, Math.PI * 2);
      ctx.fill();
      // зрачок
      const px = x + this.look.x * u * 0.08;
      const py = ey + this.look.y * u * 0.1;
      ctx.fillStyle = C.ink;
      ctx.beginPath();
      ctx.ellipse(px, py, u * 0.125 * er, u * 0.15 * er, 0, 0, Math.PI * 2);
      ctx.fill();
      // блик
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(px - u * 0.045, py - u * 0.06, u * 0.045, 0, Math.PI * 2);
      ctx.fill();
    }

    // брови
    if (m === 'angry') {
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = u * 0.08;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * u * 0.18, ey - u * 0.24);
        ctx.lineTo(s * u * 0.52, ey - u * 0.36);
        ctx.stroke();
      }
    } else if (m === 'think') {
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = u * 0.05;
      ctx.beginPath();
      ctx.moveTo(u * 0.22, ey - u * 0.4);
      ctx.quadraticCurveTo(u * 0.36, ey - u * 0.48, u * 0.5, ey - u * 0.4);
      ctx.stroke();
    }

    // рот
    ctx.strokeStyle = C.ink;
    ctx.fillStyle = C.ink;
    ctx.lineWidth = u * 0.06;
    const my = u * 0.24;
    ctx.beginPath();
    switch (m) {
      case 'happy':
        ctx.moveTo(-u * 0.16, my - u * 0.02);
        ctx.quadraticCurveTo(0, my + u * 0.28, u * 0.16, my - u * 0.02);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#ff7b8a';
        ctx.beginPath();
        ctx.ellipse(0, my + u * 0.1, u * 0.07, u * 0.04, 0, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'angry':
        ctx.moveTo(-u * 0.13, my + u * 0.07);
        ctx.quadraticCurveTo(0, my - u * 0.07, u * 0.13, my + u * 0.07);
        ctx.stroke();
        break;
      case 'sleep':
        ctx.ellipse(0, my + u * 0.02, u * 0.05, u * 0.035 + Math.sin(t * 1.4) * u * 0.01, 0, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'think':
        ctx.moveTo(-u * 0.04, my + u * 0.02);
        ctx.lineTo(u * 0.1, my);
        ctx.stroke();
        break;
      case 'listen':
      case 'alert':
        ctx.ellipse(0, my + u * 0.02, u * 0.06, u * 0.08, 0, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'write':
        ctx.moveTo(-u * 0.1, my);
        ctx.quadraticCurveTo(0, my + u * 0.08, u * 0.1, my);
        ctx.stroke();
        ctx.fillStyle = '#ff7b8a';
        ctx.beginPath();
        ctx.ellipse(u * 0.06, my + u * 0.05, u * 0.04, u * 0.03, 0.3, 0, Math.PI * 2);
        ctx.fill();
        break;
      default:
        ctx.moveTo(-u * 0.12, my);
        ctx.quadraticCurveTo(0, my + u * 0.12, u * 0.12, my);
        ctx.stroke();
    }
  }

  private drawPencil(u: number, t: number) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(u * 0.95 + Math.sin(t * 9) * u * 0.06, u * 0.42 + Math.cos(t * 18) * u * 0.03);
    ctx.rotate(0.7);
    ctx.fillStyle = '#ffcf3f';
    ctx.fillRect(-u * 0.05, -u * 0.32, u * 0.1, u * 0.3);
    ctx.fillStyle = '#f19aa5';
    ctx.fillRect(-u * 0.05, -u * 0.38, u * 0.1, u * 0.07);
    ctx.fillStyle = '#f2d2a9';
    ctx.beginPath();
    ctx.moveTo(-u * 0.05, -u * 0.02);
    ctx.lineTo(u * 0.05, -u * 0.02);
    ctx.lineTo(0, u * 0.08);
    ctx.fill();
    ctx.restore();
  }

  private drawFriend(W: number, H: number, u: number, t: number, age: number) {
    const { ctx } = this;
    const s = u * 0.55;
    const slide = clamp(age / 0.6, 0, 1);
    const x = -s * 1.2 + slide * (W * 0.5 - u * 0.9 - (-s * 1.2)) * 0.62;
    const y = H / 2 + u * 0.45 + Math.sin(t * 3) * s * 0.05;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = rgb(C.friend);
    ctx.beginPath();
    ctx.ellipse(0, 0, s, s * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
    // рука машет
    ctx.save();
    ctx.translate(s * 0.85, -s * 0.2);
    ctx.rotate(-1.4 + Math.sin(t * 10) * 0.5);
    ctx.beginPath();
    ctx.ellipse(s * 0.2, 0, s * 0.25, s * 0.14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    for (const sd of [-1, 1]) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(sd * s * 0.32 + s * 0.08, -s * 0.12, s * 0.17, s * 0.21, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.ink;
      ctx.beginPath();
      ctx.arc(sd * s * 0.32 + s * 0.14, -s * 0.1, s * 0.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private updateParticles(now: number, cx: number, cy: number, u: number) {
    const { ctx } = this;
    const m = this.mood;
    const every = m === 'sleep' ? 1400 : m === 'happy' ? 550 : m === 'angry' ? 300 : m === 'think' ? 0 : 0;
    if (every && now - this.lastSpawn > every) {
      this.lastSpawn = now;
      if (m === 'sleep') this.spawn('z', cx + u * 0.6, cy - u * 0.8, u * 0.15, -u * 0.35, 2.6);
      if (m === 'happy') this.spawn('heart', cx + (Math.random() - 0.5) * u * 1.4, cy - u * 0.9, (Math.random() - 0.5) * u * 0.3, -u * 0.6, 1.4);
      if (m === 'angry')
        for (const s of [-1, 1]) this.spawn('puff', cx + s * u * 0.75, cy - u * 0.75, s * u * 0.35, -u * 0.5, 0.9);
    }
    
    this.particles = this.particles.filter((p) => (now - p.born) / 1000 < p.life);
    for (const p of this.particles) {
      const a = (now - p.born) / 1000;
      const k = a / p.life;
      const x = p.x + p.vx * a, y = p.y + p.vy * a;
      ctx.save();
      ctx.globalAlpha = 1 - k;
      if (p.kind === 'z') {
        ctx.fillStyle = '#9db3ff';
        ctx.font = `700 ${u * (0.35 + k * 0.3)}px system-ui, sans-serif`;
        ctx.fillText('z', x, y);
      } else if (p.kind === 'heart') {
        ctx.fillStyle = '#ff5d7a';
        const r = u * 0.13 * (1 + k * 0.4);
        ctx.translate(x, y);
        ctx.beginPath();
        ctx.moveTo(0, r * 0.8);
        ctx.bezierCurveTo(-r * 1.6, -r * 0.3, -r * 0.6, -r * 1.4, 0, -r * 0.4);
        ctx.bezierCurveTo(r * 0.6, -r * 1.4, r * 1.6, -r * 0.3, 0, r * 0.8);
        ctx.fill();
      } else if (p.kind === 'puff') {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        ctx.arc(x, y, u * (0.08 + k * 0.14), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // точки «думаю…»
    if (m === 'think') {
      for (let i = 0; i < 3; i++) {
        const ph = (now / 1000) * 4 - i * 0.6;
        ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.65 * Math.max(0, Math.sin(ph))})`;
        ctx.beginPath();
        ctx.arc(cx + u * (0.75 + i * 0.28), cy - u * (1.0 + i * 0.12), u * (0.07 + i * 0.02), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // восклицательный знак — напоминание
    if (m === 'alert') {
      ctx.fillStyle = '#ffd84a';
      ctx.font = `900 ${u * 0.8}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('!', cx + u * 1.05, cy - u * 0.55 + Math.sin(now / 90) * u * 0.05);
      ctx.textAlign = 'start';
    }
    // кольца «слушаю»
    if (m === 'listen') {
      for (let i = 0; i < 2; i++) {
        const k = ((now / 1000) * 0.9 + i * 0.5) % 1;
        ctx.strokeStyle = `rgba(140,200,255,${(1 - k) * 0.7})`;
        ctx.lineWidth = u * 0.05;
        ctx.beginPath();
        ctx.arc(cx, cy, u * (1.05 + k * 0.5), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}
