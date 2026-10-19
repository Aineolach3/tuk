// Остров Тука на ПК: машина состояний hidden → peek → home.
// По мотивам Coucou (MIT, Louis Raillé): src/island/fsm.ts.
//
// Чистая логика без DOM и Tauri: только сообщает о переходах. Применение —
// классы html.island-hidden / island-peek / island-home (под них рисует
// дизайнер) и команда Rust island_set_phase (размер окна, click-through, фокус).
//
//   hidden — у верхнего края только капсула; окно ровно по капсуле, фокус не берёт.
//   peek   — наведение: Тук выглянул (короткая строка с текстом). Ушла мышь — через
//            leaveDelay снова hidden. Фокус не берёт.
//   home   — клик: раскрытая панель с полем ввода, окно получает фокус.
//            Сворачивается по клику мимо, Esc, потере фокуса, хоткею.
//
// pinned (звонит напоминание, ждёт запрос агента) не даёт свернуться
// из peek/home сам по себе — только явным действием (Esc, клик мимо, хоткей).

export type IslandPhase = 'hidden' | 'peek' | 'home';

/** Старые названия режимов строки (app.ts) ↔ фазы острова. */
export type BarModeName = 'collapsed' | 'compact' | 'expanded';
export const PHASE_OF: Record<BarModeName, IslandPhase> = { collapsed: 'hidden', compact: 'peek', expanded: 'home' };
export const MODE_OF: Record<IslandPhase, BarModeName> = { hidden: 'collapsed', peek: 'compact', home: 'expanded' };

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export class IslandFsm {
  state: IslandPhase = 'hidden';
  /** Вызывается при каждом переходе (from !== to). */
  onChange: ((to: IslandPhase, from: IslandPhase) => void) | null = null;
  /** Через сколько после ухода мыши выглянувший Тук прячется, мс. */
  leaveDelay = 900;
  /** Сколько держать peek после reveal() без наведения, мс. */
  revealMs = 5000;
  /** Не сворачиваться самому (звонит напоминание, ждёт запрос агента). */
  pinned = false;

  private hovering = false;
  private timer: unknown = null;
  private timers: Timers;

  constructor(timers: Timers = realTimers) {
    this.timers = timers;
  }

  get hovered(): boolean {
    return this.hovering;
  }

  // ---------- Входы ----------

  /** Мышь над островом. */
  enter(): void {
    this.hovering = true;
    this.cancel();
    if (this.state === 'hidden') this.go('peek');
  }

  /** Мышь ушла с острова. */
  leave(): void {
    this.hovering = false;
    if (this.state === 'peek') this.later(this.leaveDelay);
  }

  /** Клик по острову (капсуле/строке, не по кнопкам внутри панели). */
  click(): void {
    this.cancel();
    if (this.state === 'home') this.go(this.hovering ? 'peek' : 'hidden');
    else this.go('home');
  }

  /** Клик мимо острова (по рабочему столу или другой программе). */
  outside(): void {
    if (this.state === 'hidden') return;
    this.cancel();
    this.go(this.pinned ? 'peek' : 'hidden');
  }

  escape(): void {
    if (this.state === 'hidden') return;
    this.cancel();
    this.go(this.pinned ? 'peek' : 'hidden');
  }

  /** Окно потеряло фокус: раскрытый остров сворачивается. */
  blur(): void {
    if (this.state !== 'home') return;
    this.cancel();
    this.go(this.pinned || this.hovering ? 'peek' : 'hidden');
  }

  /** Горячая клавиша: открыть или закрыть. */
  toggle(): void {
    this.cancel();
    this.go(this.state === 'home' ? 'hidden' : 'home');
  }

  /** Открыть панель (тревога, «Связь с телефоном» из трея, перетащили файл). */
  open(): void {
    this.cancel();
    this.go('home');
  }

  /** Показать короткую строку (ответ, событие агента), если остров спрятан. */
  reveal(ms = this.revealMs): void {
    if (this.state !== 'hidden') {
      if (this.state === 'peek' && !this.hovering && !this.pinned) this.later(ms);
      return;
    }
    this.go('peek');
    if (!this.hovering && !this.pinned) this.later(ms);
  }

  /** Свернуть явно. */
  hide(): void {
    this.cancel();
    this.go('hidden');
  }

  /** pinned сняли (напоминание выключено) — выглянувший остров может уйти. */
  unpin(): void {
    this.pinned = false;
    if (this.state === 'peek' && !this.hovering) this.later(this.leaveDelay);
  }

  /** Состояние поменяли в обход машины (старый код app.ts): принять без onChange. */
  sync(phase: IslandPhase): void {
    if (phase === this.state) return;
    this.cancel();
    this.state = phase;
    if (phase === 'peek' && !this.hovering && !this.pinned) this.later(this.revealMs);
  }

  // ---------- Таймеры ----------

  private later(ms: number): void {
    this.cancel();
    this.timer = this.timers.set(() => {
      this.timer = null;
      if (this.state === 'peek' && !this.hovering && !this.pinned) this.go('hidden');
    }, ms);
  }

  private cancel(): void {
    if (this.timer != null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private go(to: IslandPhase): void {
    if (to === this.state) return;
    const from = this.state;
    this.state = to;
    this.onChange?.(to, from);
  }
}

/** Классы фаз на <html>: дизайнер-аниматор рисует под них переходы. */
export function applyIslandClasses(phase: IslandPhase, root: { classList: { remove(...t: string[]): void; add(...t: string[]): void } }): void {
  root.classList.remove('island-hidden', 'island-peek', 'island-home');
  root.classList.add('island-' + phase);
}

/** Прямоугольник острова в координатах окна (для click-through в Rust). */
export interface IslandRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Объединение прямоугольников видимых частей острова (панель + всплывающие карточки). */
export function unionRect(rects: IslandRect[]): IslandRect {
  const ok = rects.filter((r) => r.width > 0 && r.height > 0);
  if (!ok.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x0 = Math.min(...ok.map((r) => r.x));
  const y0 = Math.min(...ok.map((r) => r.y));
  const x1 = Math.max(...ok.map((r) => r.x + r.width));
  const y1 = Math.max(...ok.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
