// Питомец на рабочем столе: отдельное прозрачное окно «pet» с одним персонажем.
// Настроение и наряд присылает основное окно (событие pet-state).

import { Character, type Mood, type Outfit } from './character.js';
import * as P from './platform.js';

export interface PetState {
  mood: Mood;
  outfit: Outfit;
  hood: number[];
  light: number[] | null;
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
    ch.set(s.mood);
  });
  await P.emit('pet-hello', {});

  // глаза следят за курсором по всему экрану
  setInterval(async () => {
    const r = await P.cursorRel();
    if (r) ch.lookAtScreen(r[0], r[1]);
  }, 80);

  // перетаскивание и тычки
  let down = 0, sx = 0, sy = 0, dragging = false;
  c.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    down = Date.now();
    sx = e.clientX;
    sy = e.clientY;
    dragging = false;
  });
  c.addEventListener('mousemove', (e) => {
    if (down && !dragging && Math.hypot(e.clientX - sx, e.clientY - sy) > 3) {
      dragging = true;
      void P.petDrag();
    }
  });
  c.addEventListener('mouseup', () => {
    if (down && !dragging) void P.emit('pet-poke', {});
    down = 0;
  });
  c.addEventListener('dblclick', () => void P.petShow(false));
  c.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    void P.emit('pet-menu', {});
  });
}
