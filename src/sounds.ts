// Звуки Тука: синтезируются на лету через Web Audio — никаких файлов.
//
// Мягкость: синус и треугольник через общий фильтр нижних частот и лёгкий
// компрессор; огибающая с плавной атакой (без щелчков), небольшая «комната»
// из двух коротких задержек. Разнообразие: у звуков несколько вариантов и
// случайный сдвиг высоты в пределах полутона — один и тот же тычок не звучит
// одинаково дважды. Голос Тука — «мурлыкающий» тон с вибрато.

export type Sound =
  | 'hello' | 'poke' | 'dizzy' | 'write' | 'done' | 'alert' | 'angry' | 'sleep'
  | 'think' | 'message' | 'eat' | 'link' | 'error' | 'wake';

export const SOUND_LABEL: Record<Sound, string> = {
  hello: 'Привет', poke: 'Тычок', dizzy: 'Головокружение', write: 'Записал', done: 'Готово',
  alert: 'Напоминание', angry: 'Злится', sleep: 'Засыпает', think: 'Думает', message: 'Ответ',
  eat: 'Глотает файл', link: 'Связь', error: 'Ошибка', wake: 'Просыпается',
};

let ac: AudioContext | null = null;
let bus: GainNode | null = null;
let volume = 0.5;
const lastAt: Partial<Record<Sound, number>> = {};

export function setVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
}

function ctx(): AudioContext | null {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!ac) {
      ac = new AC();
      // общая цепочка: фильтр (убирает «цифровой» верх) → компрессор → выход, плюс «комната»
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 4200;
      lp.Q.value = 0.4;
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 3;
      comp.attack.value = 0.004;
      comp.release.value = 0.15;
      bus = ac.createGain();
      bus.connect(lp).connect(comp).connect(ac.destination);
      for (const [delay, g] of [[0.045, 0.16], [0.085, 0.09]] as const) {
        const d = ac.createDelay(0.2);
        d.delayTime.value = delay;
        const dg = ac.createGain();
        dg.gain.value = g;
        const dl = ac.createBiquadFilter();
        dl.type = 'lowpass';
        dl.frequency.value = 2200;
        lp.connect(d).connect(dl).connect(dg).connect(comp);
      }
    }
    if (ac.state === 'suspended') void ac.resume();
    return ac;
  } catch {
    return null;
  }
}

interface ToneOpts {
  type?: OscillatorType;
  gain?: number;
  /** Атака, с (по умолчанию мягкая — 12 мс). */
  attack?: number;
  /** Вибрато: частота Гц и глубина в центах. */
  vib?: [number, number];
  /** Второй голос на октаву выше, доля громкости (делает тембр «стеклянным»). */
  octave?: number;
  /** Панорама −1..1. */
  pan?: number;
}

/** Один тон: частота от f0 к f1, мягкая огибающая. */
function tone(a: AudioContext, at: number, f0: number, f1: number, dur: number, o: ToneOpts = {}) {
  const { type = 'sine', gain = 0.22, attack = 0.012, vib, octave = 0, pan = 0 } = o;
  const peak = gain * volume;
  const g = a.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(peak, at + Math.min(attack, dur / 3));
  // экспоненциальный спад к тишине — без щелчка в конце
  g.gain.setTargetAtTime(0, at + Math.min(attack, dur / 3), Math.max(0.02, dur / 3.5));
  let out: AudioNode = g;
  if (pan && a.createStereoPanner) {
    const p = a.createStereoPanner();
    p.pan.value = pan;
    g.connect(p);
    out = p;
  }
  out.connect(bus ?? a.destination);
  const voices: [number, number][] = [[1, 1]];
  if (octave > 0) voices.push([2, octave]);
  for (const [mul, vol] of voices) {
    const osc = a.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0 * mul, at);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * mul), at + dur);
    if (vib) {
      const lfo = a.createOscillator();
      const lg = a.createGain();
      lfo.frequency.value = vib[0];
      lg.gain.value = vib[1];
      lfo.connect(lg).connect(osc.detune);
      lfo.start(at);
      lfo.stop(at + dur + 0.3);
    }
    let src: AudioNode = osc;
    if (vol !== 1) {
      const vg = a.createGain();
      vg.gain.value = vol;
      osc.connect(vg);
      src = vg;
    }
    src.connect(g);
    osc.start(at);
    osc.stop(at + dur + 0.3);
  }
}

/** Короткий мягкий шорох (шум через полосовой фильтр) — для «записал», «глотает». */
function rustle(a: AudioContext, at: number, dur: number, freq: number, gain = 0.08) {
  const n = Math.ceil(a.sampleRate * dur);
  const buf = a.createBuffer(1, n, a.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * Math.sin((Math.PI * i) / n);
  const src = a.createBufferSource();
  src.buffer = buf;
  const bp = a.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = 1.2;
  const g = a.createGain();
  g.gain.value = gain * volume;
  src.connect(bp).connect(g).connect(bus ?? a.destination);
  src.start(at);
}

const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
/** Случайный сдвиг высоты до ±полутона. */
const jitter = () => Math.pow(2, (Math.random() - 0.5) / 12);

// ноты (Гц) — мажорная пентатоника от до второй октавы, звучит дружелюбно
const N = { C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880, C6: 1046.5, D6: 1174.66, E6: 1318.5, G4: 392, A4: 440, E4: 329.63, C4: 261.63 };

export function play(s: Sound): void {
  if (volume <= 0) return;
  const a = ctx();
  if (!a) return;
  // один и тот же звук не чаще раза в 70 мс — не «пулемётит» при частых событиях
  const nowMs = performance.now();
  if (nowMs - (lastAt[s] ?? -1e9) < 70) return;
  lastAt[s] = nowMs;
  const t = a.currentTime + 0.01;
  const j = jitter();
  switch (s) {
    case 'hello': {
      // «при-вет»: две ноты вверх, мурлыкающий тембр
      const [x, y] = pick([[N.E5, N.A5], [N.D5, N.G5], [N.C5, N.E5]]);
      tone(a, t, x * j, x * j * 1.02, 0.14, { type: 'triangle', vib: [6, 12], octave: 0.15, pan: -0.15 });
      tone(a, t + 0.12, y * j * 0.98, y * j, 0.24, { type: 'triangle', vib: [5.5, 15], octave: 0.2, pan: 0.15 });
      break;
    }
    case 'wake':
      tone(a, t, N.C5 * 0.75 * j, N.G5 * j, 0.32, { type: 'sine', gain: 0.16, attack: 0.06, vib: [4, 20] });
      tone(a, t + 0.22, N.C6 * j, N.C6 * j, 0.12, { gain: 0.06 });
      break;
    case 'poke': {
      // «ой»: короткий упругий «боинк», три варианта
      const f = pick([520, 470, 580]) * j;
      tone(a, t, f, f * 0.62, 0.13, { type: 'triangle', gain: 0.24, attack: 0.004 });
      tone(a, t + 0.02, f * 1.5, f * 1.1, 0.06, { gain: 0.05 });
      break;
    }
    case 'dizzy':
      // нисходящая «карусель» с вибрато
      for (let i = 0; i < 6; i++) {
        const f = (760 - i * 50) * j;
        tone(a, t + i * 0.075, f, f * 0.92, 0.1, { gain: 0.12, vib: [9, 30], pan: i % 2 ? 0.4 : -0.4 });
      }
      break;
    case 'write':
      rustle(a, t, 0.06, 3200, 0.06);
      rustle(a, t + 0.08, 0.05, 3600, 0.05);
      tone(a, t + 0.14, N.E5 * j, N.A5 * j, 0.14, { gain: 0.16, octave: 0.2 });
      break;
    case 'done': {
      // радостное арпеджио, варианты
      const seq = pick([[N.C5, N.E5, N.G5, N.C6], [N.D5, N.G5, N.A5, N.D6], [N.E5, N.G5, N.C6, N.E6]]);
      seq.forEach((f, i) => tone(a, t + i * 0.075, f * j, f * j, i === 3 ? 0.36 : 0.12, { type: i === 3 ? 'triangle' : 'sine', gain: i === 3 ? 0.18 : 0.15, octave: 0.18, pan: -0.3 + i * 0.2 }));
      break;
    }
    case 'alert':
      // мягкий колокольчик «динь-дон-динь» — заметно, но не режет
      [[N.A5, 0], [N.E5, 0.2], [N.A5, 0.4]].forEach(([f, d]) => tone(a, t + d, f, f, 0.36, { type: 'sine', gain: 0.2, attack: 0.004, octave: 0.35 }));
      break;
    case 'angry':
      // ворчание: низкий треугольник с быстрым вибрато (вместо резкой пилы)
      tone(a, t, 210 * j, 150 * j, 0.32, { type: 'triangle', gain: 0.2, vib: [22, 60] });
      tone(a, t + 0.05, 140 * j, 110 * j, 0.28, { type: 'sine', gain: 0.12 });
      break;
    case 'sleep':
      // зевок: медленно вниз с плавной атакой
      tone(a, t, 520 * j, 300 * j, 0.6, { type: 'sine', gain: 0.12, attack: 0.15, vib: [3, 25] });
      tone(a, t + 0.35, 330 * j, 260 * j, 0.5, { type: 'sine', gain: 0.06, attack: 0.1 });
      break;
    case 'think':
      tone(a, t, pick([N.E6, N.D6, N.C6]) * j, N.E6 * j * 1.04, 0.07, { gain: 0.08 });
      break;
    case 'message':
      tone(a, t, N.G5 * j, N.G5 * j, 0.08, { gain: 0.14, octave: 0.2 });
      tone(a, t + 0.07, N.C6 * j, N.C6 * j, 0.18, { gain: 0.14, octave: 0.2 });
      break;
    case 'eat':
      // «ам!»: вверх — пауза — «глоть» вниз и шорох бумаги
      rustle(a, t, 0.12, 1800, 0.07);
      tone(a, t + 0.02, 300 * j, 820 * j, 0.14, { type: 'triangle', gain: 0.2 });
      tone(a, t + 0.26, 700 * j, 180 * j, 0.2, { type: 'sine', gain: 0.22, attack: 0.004 });
      tone(a, t + 0.5, 260 * j, 200 * j, 0.08, { type: 'sine', gain: 0.1 });
      break;
    case 'link':
      [N.C5, N.E5, N.G5].forEach((f, i) => tone(a, t + i * 0.08, f, f, i === 2 ? 0.2 : 0.1, { gain: 0.15, octave: 0.25, pan: -0.3 + i * 0.3 }));
      break;
    case 'error':
      // «ой-ой» вниз, без резкого квадрата
      tone(a, t, N.E4 * 1.2, N.E4, 0.14, { type: 'triangle', gain: 0.18 });
      tone(a, t + 0.15, N.C4 * 1.15, N.C4 * 0.95, 0.24, { type: 'triangle', gain: 0.16 });
      break;
  }
}
