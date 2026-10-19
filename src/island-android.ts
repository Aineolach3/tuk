// Остров Тука поверх приложений на Android: живой Тук из character.ts в прозрачном WebView оверлея.
// Kotlin (IslandService) присылает состояние через evaluateJavascript → window.tukIsland.*,
// страница отвечает через addJavascriptInterface → window.TukBridge.
// Касания и перетаскивание ловит сам сервис (окно двигается нативно), сюда приходят только реакции.
import { Character, MOOD_LABEL, OUTFIT_LABEL, type Mood, type Outfit } from './character.js';

interface Bridge {
  /** Страница загрузилась — можно присылать состояние. */
  ready(): void;
  /** Нужная ширина окна в CSS-пикселях (= dp): персонаж + облачко. */
  bubble(cssWidth: number): void;
}

interface Look {
  outfit?: string;
  hood?: number[];
  light?: number[] | null;
}

interface IslandState {
  mood?: string;
  text?: string;
  badge?: number;
  look?: Look | null;
}

/** Размер персонажа и левый край облачка — как в разметке island-android.html. */
const CHAR_W = 80;
const BUBBLE_LEFT = CHAR_W - 6;

const bridge = (window as unknown as { TukBridge?: Bridge }).TukBridge;
const canvas = document.getElementById('tuk') as HTMLCanvasElement;
const bubble = document.getElementById('bubble') as HTMLDivElement;
const badge = document.getElementById('badge') as HTMLDivElement;
const ch = new Character(canvas);

let lastLook = '';
let lastText: string | null = null;
let lastWidth = -1;
let hideTimer = 0;

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isMood = (m: string): m is Mood => has(MOOD_LABEL, m);
const isColor = (c: unknown): c is number[] => Array.isArray(c) && c.length >= 3 && c.every((x) => typeof x === 'number');

function applyLook(l: Look): void {
  const key = JSON.stringify(l);
  if (key === lastLook) return;
  lastLook = key;
  if (typeof l.outfit === 'string' && has(OUTFIT_LABEL, l.outfit)) ch.outfit = l.outfit as Outfit;
  if (isColor(l.hood)) ch.hood = l.hood;
  ch.idleLight = isColor(l.light) ? l.light : null;
  ch.blink(); // разбудить цикл кадров, чтобы новый наряд появился сразу
}

/** Сообщить сервису ширину окна (только при изменении). */
function report(width: number): void {
  if (width === lastWidth) return;
  lastWidth = width;
  bridge?.bubble(width);
}

function applyText(t: string): void {
  if (t === lastText) return;
  lastText = t;
  clearTimeout(hideTimer);
  if (!t) {
    bubble.classList.remove('on');
    // сначала облачко гаснет, потом окно сужается до персонажа
    hideTimer = window.setTimeout(() => {
      bubble.classList.add('none');
      report(CHAR_W);
    }, 180);
    return;
  }
  bubble.textContent = t;
  bubble.classList.remove('none');
  // offsetWidth сразу пересчитывает разметку — ширина облачка известна до кадра
  report(Math.ceil(BUBBLE_LEFT + bubble.offsetWidth + 2));
  requestAnimationFrame(() => bubble.classList.add('on'));
}

function applyBadge(n: number): void {
  if (n > 0) {
    badge.textContent = String(Math.min(n, 9));
    badge.style.display = 'block';
  } else badge.style.display = 'none';
}

const api = {
  /** Полное состояние острова; приходит при любом изменении. */
  state(s: IslandState): void {
    if (s.look) applyLook(s.look);
    if (typeof s.mood === 'string') ch.set(isMood(s.mood) ? s.mood : 'idle');
    if (typeof s.text === 'string') applyText(s.text);
    if (typeof s.badge === 'number') applyBadge(s.badge);
  },
  /** Короткое нажатие — Тук сплющивается. */
  tap(): void {
    ch.squash(0.8);
  },
  /** Перетаскивание: скорость окна, dp/с. */
  fly(vx: number, vy: number): void {
    ch.setFlight(vx, vy);
  },
  /** Отпустили после перетаскивания. */
  land(): void {
    ch.land();
  },
  /** Экономия батареи: экран выключен или Тук спрятан. */
  pause(on: boolean): void {
    ch.pause(on);
  },
};

(window as unknown as { tukIsland: typeof api }).tukIsland = api;
bridge?.ready();
