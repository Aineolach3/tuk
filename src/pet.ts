// Питомец на рабочем столе: отдельное прозрачное окно «pet» с одним персонажем.
// Настроение и наряд присылает основное окно (событие pet-state).
//
// Анимация: холст на всё окно (Тук вписан без пустых полей), глаза следят за курсором
// по всему экрану, при перетаскивании Тук «летит» — наклоняется по скорости и
// вытягивается, а отпущенный приземляется со сплющиванием и облачком пыли.
// Приёмы — по мотивам Coucou (MIT, Louis Raillé), desktop/main.ts.

import { Character, type Mood, type Outfit } from './character.js';
import * as P from './platform.js';

export interface PetState {
  mood: Mood;
  outfit: Outfit;
  hood: number[];
  light: number[] | null;
  /** Темп музыки для танца (необязательно). */
  bpm?: number;
}

/** Порог «это перетаскивание, а не клик», px. */
const DRAG_THRESHOLD = 3;
/** Окно не двигалось столько мс — значит, отпустили. */
const LAND_AFTER_MS = 140;
/** Одиночный клик ждёт, не окажется ли он двойным. */
const DOUBLE_CLICK_MS = 260;

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Текущее окно Tauri (если есть) — чтобы узнать о его перемещении. */
function tauriWindow(): any | null {
  try {
    return (globalThis as any).__TAURI__?.window?.getCurrentWindow?.() ?? null;
  } catch {
    return null;
  }
}

export async function runPet(): Promise<void> {
  document.documentElement.classList.add('pet');
  const c = document.createElement('canvas');
  c.id = 'petc';
  c.title = 'Перетащите, чтобы переместить. Двойной клик — вернуть в строку';
  document.body.append(c);
  const ch = new Character(c);

  await P.listen('pet-state', (s: PetState) => {
    ch.outfit = s.outfit;
    ch.hood = s.hood;
    ch.idleLight = s.light;
    if (s.bpm) ch.bpm = s.bpm;
    ch.set(s.mood);
  });
  // окно питомца живёт всё время; пока оно спрятано — не рисуем зря
  await P.listen('pet-visible', (on: boolean) => ch.pause(!on));
  await P.emit('pet-hello', {});

  // ---------- глаза следят за курсором по всему экрану ----------
  // Опрос курсора — только пока окно видно; сглаживание делает пружина движка,
  // поэтому редкий опрос не даёт рывков.
  let polling = false;
  const poll = async () => {
    if (polling || document.hidden) return;
    polling = true;
    const r = await P.cursorRel();
    polling = false;
    if (r && !flying) ch.lookAtScreen(r[0], r[1]);
  };
  setInterval(() => void poll(), 66);

  // ---------- полёт при перетаскивании ----------
  let flying = false;
  let lastPos: { x: number; y: number; t: number } | null = null;
  let vx = 0, vy = 0;
  let landTimer = 0;
  const w = tauriWindow();
  const scale = () => window.devicePixelRatio || 1;
  const onMoved = (x: number, y: number) => {
    const now = performance.now();
    if (lastPos) {
      const dt = Math.max(8, now - lastPos.t) / 1000;
      // скорость в логических пикселях/с, сглаженная
      const nvx = (x - lastPos.x) / scale() / dt, nvy = (y - lastPos.y) / scale() / dt;
      vx = vx * 0.6 + nvx * 0.4;
      vy = vy * 0.6 + nvy * 0.4;
    }
    lastPos = { x, y, t: now };
    if (dragging) {
      flying = true;
      ch.setFlight(vx, vy);
    }
    clearTimeout(landTimer);
    landTimer = window.setTimeout(() => {
      // окно замерло: если летели — приземлиться
      vx = vy = 0;
      if (flying) {
        flying = false;
        dragging = false;
        ch.land();
      }
      lastPos = null;
    }, LAND_AFTER_MS);
  };
  if (w?.onMoved) {
    await w.onMoved((e: any) => onMoved(e.payload.x, e.payload.y)).catch(() => {});
  }

  // ---------- перетаскивание, тычки, двойной клик ----------
  let down = false, sx = 0, sy = 0, dragging = false, clickTimer = 0;
  c.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (!ch.contains(e.clientX, e.clientY)) return; // мимо фигуры — не реагировать
    down = true;
    sx = e.clientX;
    sy = e.clientY;
    dragging = false;
  });
  c.addEventListener('pointermove', (e) => {
    c.style.cursor = ch.contains(e.clientX, e.clientY) ? 'grab' : 'default';
    if (down && !dragging && Math.hypot(e.clientX - sx, e.clientY - sy) > DRAG_THRESHOLD) {
      dragging = true;
      down = false;
      // небольшой «подскок» при отрыве от стола
      ch.setFlight(0, -400);
      void P.petDrag();
      // если перемещения окна не придут (нет onMoved) — приземлиться по таймеру
      if (!w?.onMoved) setTimeout(() => {
        dragging = false;
        ch.land();
      }, 400);
    }
  });
  c.addEventListener('pointerup', () => {
    if (down && !dragging) {
      // одиночный клик — тычок; двойной — вернуть в строку
      clearTimeout(clickTimer);
      clickTimer = window.setTimeout(() => {
        ch.squash();
        void P.emit('pet-poke', {});
      }, DOUBLE_CLICK_MS);
    }
    down = false;
  });
  c.addEventListener('dblclick', () => {
    clearTimeout(clickTimer);
    void P.petShow(false);
  });
  c.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    void P.emit('pet-menu', {});
  });
}
