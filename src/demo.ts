// Демо-страница аниматора (demo.html): все настроения, наряды, реакции, размеры и звуки
// без настройки и без Tauri. Открывается в обычном браузере из dist/demo.html.

import { Character, HOOD_COLORS, LIGHT_COLORS, MOOD_LABEL, OUTFIT_LABEL, type Mood, type Outfit } from './character.js';
import { SOUND_LABEL, play, setVolume, type Sound } from './sounds.js';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;

const big = new Character($<HTMLCanvasElement>('#big'));
const peek = new Character($<HTMLCanvasElement>('#c-peek'));
peek.peek = 0.18;
const bar = new Character($<HTMLCanvasElement>('#c-bar'));
const pet = new Character($<HTMLCanvasElement>('#c-pet'));
const all = [big, peek, bar, pet];

let wardrobe: Character | null = null;
const drawWardrobe = () => {
  const c = $<HTMLCanvasElement>('#c-wardrobe');
  wardrobe ??= new Character(c, { still: true });
  wardrobe.outfit = big.outfit;
  wardrobe.hood = big.hood;
  wardrobe.idleLight = big.idleLight;
  wardrobe.set('idle');
  wardrobe.draw(performance.now());
};

// ---------- настроения ----------
const moods = Object.keys(MOOD_LABEL) as Mood[];
const moodBox = $('#moods');
const setMood = (m: Mood) => {
  for (const ch of all) ch.set(m);
  $('#moodname').textContent = MOOD_LABEL[m];
  for (const b of moodBox.querySelectorAll<HTMLElement>('button')) b.classList.toggle('on', b.dataset.m === m);
};
moodBox.innerHTML = moods.map((m) => `<button class="pill ghost small" data-m="${m}">${MOOD_LABEL[m]}</button>`).join('');
moodBox.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-m]');
  if (b) {
    stopCycle();
    setMood(b.dataset.m as Mood);
  }
});
setMood('idle');

// все по очереди — как демо-режим приложения (по 1,6 с)
let cycle = 0;
const stopCycle = () => {
  clearInterval(cycle);
  cycle = 0;
  $('#cycle').textContent = '▶ Все по очереди (1,6 с)';
};
$('#cycle').addEventListener('click', () => {
  if (cycle) return stopCycle();
  let i = moods.indexOf(big.mood);
  cycle = window.setInterval(() => setMood(moods[(i = (i + 1) % moods.length)]), 1600);
  $('#cycle').textContent = '■ Остановить';
});

// ---------- реакции ----------
let pokes: number[] = [];
const poke = () => {
  const now = Date.now();
  pokes = pokes.filter((t) => now - t < 1500);
  pokes.push(now);
  const back = big.mood === 'poke' || big.mood === 'dizzy' ? 'idle' : big.mood;
  if (pokes.length >= 3) {
    pokes = [];
    setMood('dizzy');
    play('dizzy');
    setTimeout(() => setMood(back), 2600);
  } else {
    setMood('poke');
    play('poke');
    setTimeout(() => big.mood === 'poke' && setMood(back), 900);
  }
};
const flash = (m: Mood, ms: number, s?: Sound) => {
  const back = big.mood === m ? 'idle' : big.mood;
  setMood(m);
  if (s) play(s);
  setTimeout(() => big.mood === m && setMood(back), ms);
};
document.querySelectorAll<HTMLElement>('[data-r]').forEach((b) =>
  b.addEventListener('click', () => {
    switch (b.dataset.r) {
      case 'poke': return poke();
      case 'poke3': poke(); setTimeout(poke, 180); setTimeout(poke, 360); return;
      case 'done': return flash('happy', 2200, 'done');
      case 'alert': return flash('alert', 3000, 'alert');
      case 'eat': return flash('eat', 1400, 'eat');
      case 'blink': return all.forEach((c) => c.blink());
      case 'land': return all.forEach((c) => c.land());
    }
  }),
);
for (const id of ['#big', '#c-bar', '#c-peek']) $(id).addEventListener('click', poke);

// глаза за курсором — во всех персонажах
document.addEventListener('pointermove', (e) => all.forEach((c) => c.lookAtScreen(e.clientX, e.clientY)), { passive: true });

const bpm = $<HTMLInputElement>('#bpm');
bpm.addEventListener('input', () => {
  for (const c of all) c.bpm = +bpm.value;
  $('#bpmv').textContent = bpm.value;
});
$<HTMLInputElement>('#low').addEventListener('change', (e) => {
  for (const c of all) c.lowPower = (e.target as HTMLInputElement).checked;
});

// ---------- наряды и цвета ----------
const outBox = $('#outfits');
outBox.innerHTML = (Object.keys(OUTFIT_LABEL) as Outfit[]).map((o) => `<button class="pill ghost small" data-o="${o}">${OUTFIT_LABEL[o]}</button>`).join('');
outBox.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-o]');
  if (!b) return;
  for (const c of all) c.outfit = b.dataset.o as Outfit;
  for (const x of outBox.querySelectorAll<HTMLElement>('button')) x.classList.toggle('on', x === b);
  drawWardrobe();
});
const swatches = (box: HTMLElement, colors: Record<string, number[]>, apply: (c: number[] | null) => void, auto = false) => {
  box.innerHTML = (auto ? '<button class="sw auto on" data-c="" title="Как задумано">✦</button>' : '') +
    Object.entries(colors).map(([n, c]) => `<button class="sw" data-c="${n}" title="${n}" style="background:rgb(${c.join(',')})"></button>`).join('');
  box.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-c]');
    if (!b) return;
    apply(b.dataset.c ? colors[b.dataset.c] : null);
    for (const x of box.querySelectorAll<HTMLElement>('button')) x.classList.toggle('on', x === b);
    drawWardrobe();
  });
};
swatches($('#hoods'), HOOD_COLORS, (c) => all.forEach((ch) => (ch.hood = c!)));
swatches($('#lights'), LIGHT_COLORS, (c) => all.forEach((ch) => (ch.idleLight = c)), true);
drawWardrobe();

// ---------- звуки ----------
const sBox = $('#sounds');
sBox.innerHTML = (Object.keys(SOUND_LABEL) as Sound[]).map((s) => `<button class="pill ghost small" data-s="${s}">${SOUND_LABEL[s]}</button>`).join('');
sBox.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-s]');
  if (b) play(b.dataset.s as Sound);
});
const vol = $<HTMLInputElement>('#vol');
setVolume(0.5);
vol.addEventListener('input', () => setVolume(+vol.value / 100));

// ---------- «рабочий стол»: перетаскивание питомца ----------
const petBox = $('#pet');
const desk = $('#desk');
let drag: { dx: number; dy: number; lx: number; ly: number; lt: number; vx: number; vy: number } | null = null;
let still = 0;
petBox.addEventListener('pointerdown', (e) => {
  const r = petBox.getBoundingClientRect();
  drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, lx: e.clientX, ly: e.clientY, lt: performance.now(), vx: 0, vy: 0 };
  petBox.setPointerCapture(e.pointerId);
  pet.setFlight(0, -400);
});
petBox.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const d = desk.getBoundingClientRect();
  const now = performance.now();
  const dt = Math.max(8, now - drag.lt) / 1000;
  drag.vx = drag.vx * 0.6 + ((e.clientX - drag.lx) / dt) * 0.4;
  drag.vy = drag.vy * 0.6 + ((e.clientY - drag.ly) / dt) * 0.4;
  drag.lx = e.clientX;
  drag.ly = e.clientY;
  drag.lt = now;
  petBox.style.left = `${Math.max(-20, Math.min(d.width - 100, e.clientX - d.left - drag.dx))}px`;
  petBox.style.top = `${Math.max(-20, Math.min(d.height - 120, e.clientY - d.top - drag.dy))}px`;
  pet.setFlight(drag.vx, drag.vy);
  // курсор замер, но кнопку держат — Тук «зависает» ровно
  clearTimeout(still);
  still = window.setTimeout(() => drag && pet.setFlight(0, 0), 120);
});
const drop = () => {
  if (!drag) return;
  drag = null;
  clearTimeout(still);
  pet.land();
  play('poke');
};
petBox.addEventListener('pointerup', drop);
petBox.addEventListener('pointercancel', drop);

// ---------- счётчик кадров ----------
let frames = 0, t0 = performance.now();
const hud = $('#hud');
const fps = () => {
  frames++;
  const now = performance.now();
  if (now - t0 > 500) {
    hud.textContent = `экран ${Math.round((frames * 1000) / (now - t0))} Гц · dpr ${window.devicePixelRatio}`;
    frames = 0;
    t0 = now;
  }
  requestAnimationFrame(fps);
};
requestAnimationFrame(fps);
