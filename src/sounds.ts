// Звуки Тука: синтезируются на лету через Web Audio — никаких файлов.

export type Sound =
  | 'hello' | 'poke' | 'dizzy' | 'write' | 'done' | 'alert' | 'angry' | 'sleep'
  | 'think' | 'message' | 'eat' | 'link' | 'error' | 'wake';

export const SOUND_LABEL: Record<Sound, string> = {
  hello: 'Привет', poke: 'Тычок', dizzy: 'Головокружение', write: 'Записал', done: 'Готово',
  alert: 'Напоминание', angry: 'Злится', sleep: 'Засыпает', think: 'Думает', message: 'Ответ',
  eat: 'Глотает файл', link: 'Связь', error: 'Ошибка', wake: 'Просыпается',
};

let ac: AudioContext | null = null;
let volume = 0.5;

export function setVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
}

function ctx(): AudioContext | null {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ac ??= new AC();
    if (ac.state === 'suspended') void ac.resume();
    return ac;
  } catch {
    return null;
  }
}

/** Один тон: частота от f0 к f1, огибающая attack/decay. */
function tone(a: AudioContext, at: number, f0: number, f1: number, dur: number, type: OscillatorType = 'sine', gain = 0.25) {
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, at);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + dur);
  const peak = gain * volume;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + Math.min(0.02, dur / 4));
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(a.destination);
  o.start(at);
  o.stop(at + dur + 0.02);
}

export function play(s: Sound): void {
  if (volume <= 0) return;
  const a = ctx();
  if (!a) return;
  const t = a.currentTime + 0.01;
  switch (s) {
    case 'hello':
      tone(a, t, 520, 780, 0.12);
      tone(a, t + 0.12, 780, 1040, 0.16);
      break;
    case 'wake':
      tone(a, t, 400, 700, 0.18, 'triangle');
      break;
    case 'poke':
      tone(a, t, 420, 260, 0.14, 'triangle', 0.3);
      break;
    case 'dizzy':
      for (let i = 0; i < 6; i++) tone(a, t + i * 0.07, 600 + (i % 2) * 180, 500 + (i % 2) * 160, 0.07, 'sine', 0.18);
      break;
    case 'write':
      tone(a, t, 1800, 1700, 0.03, 'square', 0.06);
      tone(a, t + 0.07, 1900, 1800, 0.03, 'square', 0.06);
      tone(a, t + 0.14, 660, 990, 0.12);
      break;
    case 'done':
      tone(a, t, 660, 660, 0.1);
      tone(a, t + 0.1, 880, 880, 0.1);
      tone(a, t + 0.2, 1320, 1320, 0.18);
      break;
    case 'alert':
      tone(a, t, 880, 880, 0.14, 'triangle', 0.3);
      tone(a, t + 0.18, 660, 660, 0.14, 'triangle', 0.3);
      tone(a, t + 0.36, 880, 880, 0.2, 'triangle', 0.3);
      break;
    case 'angry':
      tone(a, t, 180, 120, 0.3, 'sawtooth', 0.12);
      break;
    case 'sleep':
      tone(a, t, 500, 300, 0.4, 'sine', 0.12);
      break;
    case 'think':
      tone(a, t, 900, 1100, 0.06, 'sine', 0.1);
      break;
    case 'message':
      tone(a, t, 740, 990, 0.09, 'sine', 0.18);
      break;
    case 'eat':
      tone(a, t, 300, 900, 0.12, 'triangle');
      tone(a, t + 0.12, 900, 200, 0.18, 'sine', 0.2);
      break;
    case 'link':
      tone(a, t, 523, 523, 0.08);
      tone(a, t + 0.08, 659, 659, 0.08);
      tone(a, t + 0.16, 784, 784, 0.12);
      break;
    case 'error':
      tone(a, t, 300, 200, 0.2, 'square', 0.08);
      break;
  }
}
