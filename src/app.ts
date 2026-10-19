// Главный модуль: строка с персонажем, панель, вкладки, команды.

import { Character, HOOD_COLORS, LIGHT_COLORS, MOOD_LABEL, OUTFIT_LABEL, seasonalOutfit, type Mood, type Outfit } from './character.js';
import { play, setVolume, type Sound } from './sounds.js';
import { KIND_ICON, MAX_CHARS, describe, extractTasks, filesContext, fitBudget, fmtSize, noteFromFile, readFile, truncationNote, type FileCard } from './files.js';
import { LOCAL_PRESETS, isLocalUrl, listModels, localChat } from './localai.js';
import { computeRecap, renderRecap } from './recap.js';
import { AgentHub, KIND_LABEL, STATUS_LABEL, demoScript, duration, hooksInstalled, installHooks, uninstallHooks, type HubEvent, type Pending, type Session } from './agents.js';
import { runPet, type PetState } from './pet.js';
import { METRIC_LABEL, healthText, type Item, type Metric } from './model.js';
import { REPEAT_LABEL, fmtDay, fmtTime, fmtWhen, normalize, parse } from './parser.js';
import * as P from './platform.js';
import { IslandFsm, MODE_OF, PHASE_OF, applyIslandClasses, unionRect } from './island.js';
import { Store, emptyData, type Data, type StoredItem } from './store.js';
import { Link, ago } from './link.js';
import { qrSvg } from './qr.js';
import * as R from './reminders.js';
import { randomKey } from './crypto.js';
import { matchApp, matchContacts, parseAction, pcTarget, wordsToDigits, type Action, type Contact } from './actions.js';

const VOICE_SAMPLE = 'Привет! Я Тук. Теперь я говорю вот так. Нравится?';

/** Похоже ли на команду действию (а не на разговор/вопрос). */
function looksLikeCommand(text: string): boolean {
  const t = text.toLowerCase().replaceAll('ё', 'е').trim();
  if (t.length > 90 || /\?$/.test(t)) return false;
  // без \b — он не работает перед кириллицей
  return /(будильник|таймер|позвон|набери|напиши|открой|запусти|включи|выключи|отключи|фонар|громкост|громче|тише|звук|яркост|поворот|беспокоить|вибрац|беззвучн|маршрут|навигатор|музык|трек|песн|камер|заряд|настройк|останови|поставь|сними|сделай|убавь|прибавь|погаси|зажги|позвони)/.test(t);
}

/** Кадры острова: настроение, число кадров, кадров в секунду. */
const ISLAND_MOODS: [Mood, number, number][] = [
  ['idle', 24, 8], ['near', 20, 8], ['sleep', 20, 6], ['think', 20, 10], ['work', 16, 12], ['write', 16, 10],
  ['search', 24, 10], ['ready', 20, 8], ['help', 24, 8], ['carry', 16, 12], ['listen', 20, 10], ['happy', 20, 14],
  ['angry', 16, 14], ['alert', 16, 14], ['dance', 24, 12], ['wave', 20, 12], ['poke', 12, 12], ['away', 18, 12],
];
/** Кадр острова: Тук в полный рост с предметами (ширина × высота, px). */
const ISLAND_FRAME: [number, number] = [170, 136];
const ISLAND_SPRITE_VERSION = ':3';
import { Brain, MODELS, systemPrompt, type BrainState, type ChatMsg, type ModelId } from './brain.js';

/** Файл из Проводника: путь, имя и содержимое base64 (если не больше 50 МБ). */
interface DroppedFile {
  name?: string;
  path?: string;
  data?: string;
  size?: number;
}

type Tab = 'today' | 'chat' | 'tasks' | 'reminders' | 'health' | 'notes' | 'agents' | 'settings';
/** Разделы ⚙ — всё, что умеет Тук, разложено по понятным группам. */
type SetSec = 'main' | 'look' | 'brain' | 'link' | 'agents' | 'device' | 'help';
const SET_SECTIONS: [SetSec, string][] = [
  ['main', 'Основное'], ['look', 'Внешний вид'], ['brain', 'Мозг'], ['link', 'Связь'], ['agents', 'Агенты'], ['device', P.kind === 'android' ? 'Телефон' : 'Компьютер'], ['help', 'Справка и демо'],
];
const TAB_ORDER: Tab[] = ['today', 'chat', 'tasks', 'reminders', 'health', 'notes', 'agents', 'settings'];

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const DAY = 86_400_000;
const startOfDay = (t = Date.now()) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

class App {
  store: Store;
  link: Link;
  char: Character;
  tab: Tab = 'today';
  mode: P.BarMode = P.kind === 'desktop' ? 'collapsed' : 'expanded';
  reply = '';
  replyUntil = 0;
  tempMood: Mood | null = null;
  tempUntil = 0;
  lastActivity = Date.now();
  pinTimer: ReturnType<typeof setInterval> | null = null;
  found: P.Found[] = [];
  lastHtml = '';
  brain: Brain;
  generating = false;
  streamText = '';
  chatAbort: AbortController | null = null;
  lastBrainRender = 0;
  pokes: number[] = [];
  files: FileCard[] = []; // прикреплённые файлы для разговора, заметок и задач
  setSec: SetSec = 'main';
  /** Выбранные варианты в вопросах агентов: reqId → вопрос → варианты. */
  qSel = new Map<number, Record<string, string[]>>();
  demo: { timers: ReturnType<typeof setTimeout>[]; hub: AgentHub } | null = null;
  onboardStep = 0;
  localModels: string[] = [];
  lastBase: Mood = 'idle';
  hub: AgentHub;
  remote: { sessions: Session[]; pending: Pending[] } | null = null;
  claudeHooks: boolean | null = null;
  media: P.Media | null = null;
  mediaTitle = '';
  mediaCover = '';
  petOpen = false;
  islandOn = false;
  islandKey = '';
  spritesBusy = false;
  awaitGrant = false;
  islandState: { granted?: boolean; running?: boolean; mic?: boolean; model?: string; progress?: number; error?: string } | null = null;
  modelTimer: ReturnType<typeof setInterval> | null = null;
  drop = false;
  voice: 'off' | 'listening' | 'speaking' = 'off';
  voiceAsked = false;
  voiceContinue = false;
  lastPet = '';

  constructor(data: Data) {
    this.store = new Store(data, P.saveData);
    this.link = new Link(this.store);
    const st = data.settings;
    st.model ??= P.kind === 'desktop' ? 'smart' : 'lite';
    st.usePcBrain ??= true;
    this.brain = new Brain(st.model, undefined, P.kind === 'android' ? P.llm : undefined);
    this.brain.onState = (b) => this.onBrainState(b);
    st.volume ??= 0.5;
    st.dance ??= true;
    this.hub = new AgentHub(
      (id, body) => void P.serverReply(id, 200, body),
      () => this.store.data.agentRules ?? [],
      (r) => {
        (this.store.data.agentRules ??= []).push(r);
        this.store.changed('rules');
      },
    );
    this.hub.onChange = () => this.renderAgents();
    this.hub.onEvent = (e) => {
      // настоящий запрос важнее демо: выходим, чтобы его не спрятать
      if (this.demo && e.type === 'permission') this.stopDemo(true);
      this.onAgentEvent(e);
    };
    this.link.hookHandler = (id, body) => this.hub.handle(id, body);
    this.link.agentsHandler = () => this.hub.snapshot();
    this.link.decideHandler = (reqId, d) => this.hub.decide(reqId, d);
    this.link.answerHandler = (reqId, a) => this.hub.answer(reqId, a);
    this.link.closeHandler = (id) => this.hub.close(id);
    st.outfit ??= 'auto';
    st.hoodColor ??= 'Чёрный';
    this.char = new Character($<HTMLCanvasElement>('#char'));
    this.applyLook();
    document.documentElement.classList.add(P.kind);
    if (P.kind === 'web') document.documentElement.classList.add('android-like');
    // остров: машина состояний выбирает фазу, applyMode применяет её
    this.island.onChange = (to) => this.applyMode(MODE_OF[to], true);
    this.applyMode(this.mode);

    this.store.onChange((reason) => {
      this.render();
      if (reason !== 'link') void R.syncAndroidSchedule(this.store);
    });
    this.link.onStatus = () => this.renderStatus();
    this.link.onRemoteChange = (n) => this.say(n === 1 ? 'Пришла 1 запись с другого устройства' : `Пришли записи с другого устройства: ${n}`, 'happy', 2500);

    this.bind();
    this.render();
    setInterval(() => this.tick(), 1000);
    this.tick();
  }

  async start(): Promise<void> {
    // ПК отвечает телефону своим мозгом
    this.link.chatHandler = (messages) => (this.brain.ready ? this.brain.chat(messages, () => {}) : Promise.reject(new Error('Мозг на ПК не загружен')));
    void this.brain.init();
    if (P.kind === 'desktop') {
      await this.link.startServer();
      setInterval(() => void this.pollMedia(), 2000);
      setInterval(() => this.syncPet(), 300);
      await P.listen('pet-hello', () => this.syncPet(true));
      await P.listen('pet-poke', () => this.poke());
      await P.listen('pet-menu', () => {
        this.applyMode('expanded');
        this.setSec = 'look';
        this.setTab('settings');
      });
      // файлы из Проводника (нативный drag & drop Tauri): [{ name, path, data? (base64), size? }]
      await P.listen('files-drop', (payload: { files?: DroppedFile[] } | DroppedFile[]) => void this.takeDropped(Array.isArray(payload) ? payload : payload?.files ?? []));
      void this.checkClaude();
    } else if (P.kind === 'android') {
      this.link.startClient();
      setInterval(() => void this.pollAgents(), 3000);
      void this.checkDrop();
      document.addEventListener('visibilitychange', async () => {
        if (document.hidden) {
          if (this.voice === 'listening') void P.listenStop(true);
          this.flash('away', 1600); // «свернулся, но остался рядом» — это видно на острове
          this.pushIsland();
          if (this.drop) {
            this.drop = false;
            document.documentElement.classList.remove('drop');
          }
          return;
        }
        await this.checkDrop();
        if (this.tab === 'settings') {
          await this.refreshAccess();
          this.lastHtml = '';
          this.render();
        }
        if (this.awaitGrant) {
          this.awaitGrant = false;
          const c = await P.island('check').catch(() => null);
          if (c?.granted) {
            if (this.store.data.settings.wake) return void this.toggleWake(true);
            await this.startIsland();
            this.say('Готово — я наверху экрана. Нажмите на меня в любом приложении.', 'wave', 5000);
          } else this.say('Без разрешения «Поверх других приложений» я не смогу быть наверху экрана.', 'think', 5000);
          this.lastHtml = '';
          this.render();
        }
      });
      void this.startIsland();
      void this.refreshVoice();
      void this.refreshAccess();
      if (!this.store.data.webCacheCleared) {
        // старый мозг лежал внутри WebView и съедал место — теперь он нативный
        void P.clearWebModelCache().then(() => {
          this.store.data.webCacheCleared = true;
          this.store.changed('settings');
        });
      }
    }
    await R.syncAndroidSchedule(this.store);
    await P.askNotifyPermission().catch(() => {});
    await P.listen('toggle', (how: unknown) => this.toggleFromShortcut(how === 'open' ? 'open' : 'toggle'));
    await P.listen('open-link', () => {
      this.applyMode('expanded');
      this.setSec = 'link';
      this.setTab('settings');
    });
    await P.setAutostart(this.store.data.settings.autostart);
    this.flash('wave', 2400);
    this.sfx('hello');
    if (!this.store.data.settings.onboarded) setTimeout(() => this.renderOnboarding(), 900);
    else if (!this.store.items.length) this.say('Привет! Я Тук. Напишите, что записать или о чём напомнить.', null, 4000);
    this.renderAgents();
  }

  // ---------------- Настроение ----------------

  baseMood(): Mood {
    const now = Date.now();
    if (R.isAngry(this.store, now)) return 'angry';
    if (R.ringing(this.store, now).length || this.agentPending().length) return 'alert';
    const agent = this.agentMood(now);
    if (agent) return agent;
    if (this.voice === 'speaking') return 'ready';
    if (this.media?.playing && this.store.data.settings.dance) return 'dance';
    const quiet = now - this.lastActivity;
    if (quiet > this.store.data.settings.sleepAfterSec * 1000) return 'sleep';
    if (this.reply && now < this.replyUntil) return 'ready'; // ответил — ждёт следующую задачу
    if (quiet > 45_000) return 'near';
    return 'idle';
  }

  /** Что делает агент (Claude Code) — то и показывает Тук: ищет, работает, выполняет, думает. */
  agentMood(now: number): Mood | null {
    for (const s of this.agentSessions()) {
      if (s.status !== 'working') continue;
      const st = s.steps[s.steps.length - 1];
      if (!st || now - st.t > 20_000) return 'think';
      const MAP: Record<string, Mood> = { read: 'search', search: 'search', web: 'search', edit: 'work', run: 'carry', task: 'help', other: 'work' };
      return MAP[st.kind] ?? 'work';
    }
    return null;
  }

  flash(m: Mood, ms: number): void {
    this.tempMood = m;
    this.tempUntil = Date.now() + ms;
    this.char.set(m);
  }

  say(text: string, mood: Mood | null = null, ms = 5000): void {
    this.reply = text;
    this.replyUntil = Date.now() + ms + 1500;
    if (mood) this.flash(mood, ms);
    if (P.kind === 'desktop') this.island.reveal(ms + 1500);
    this.renderBar();
    this.renderReply();
    if (this.voiceAsked && text) {
      this.voiceAsked = false;
      void this.speakOut(text);
    }
  }

  activity(): void {
    const wasAsleep = this.char.mood === 'sleep';
    this.lastActivity = Date.now();
    if (wasAsleep && !this.tempMood) {
      this.flash('wave', 1200);
      this.sfx('wake');
    }
  }

  tick(): void {
    const now = Date.now();
    // напоминания
    for (const it of R.dueToFire(this.store, now)) {
      R.markFired(this.store, it);
      this.store.changed('fired');
      if (P.kind !== 'android') void P.notify(this.store.data.settings.name, it.text);
      this.sfx('alert');
      this.flash('alert', 3000);
      if (P.kind === 'desktop') this.applyMode(this.mode === 'expanded' ? 'expanded' : 'compact');
    }
    if (this.tempMood && now > this.tempUntil) this.tempMood = null;
    if (!this.tempMood) {
      const base = this.baseMood();
      if (base !== this.lastBase) {
        if (base === 'angry') this.sfx('angry');
        if (base === 'sleep') this.sfx('sleep');
        this.lastBase = base;
      }
      this.char.set(base);
    }
    if (this.reply && now > this.replyUntil) {
      this.reply = '';
      this.renderReply();
      if (P.kind === 'desktop' && this.mode === 'compact' && !R.ringing(this.store).length && !this.hovering) this.applyMode('collapsed');
    }
    if (now % 15000 < 1000) this.renderBar();
    if (P.kind === 'desktop') {
      // звонит напоминание или ждёт запрос агента — остров сам не прячется
      const pin = R.ringing(this.store, now).length > 0 || this.agentPending().length > 0;
      if (pin !== this.island.pinned) {
        if (pin) this.island.pinned = true;
        else this.island.unpin();
      }
      // раз в секунду — фазу и форму острова ещё раз (вдруг вызов IPC потерялся
      // или открылось/закрылось окно поверх; Rust одинаковые повторы игнорирует)
      void P.islandPhase(PHASE_OF[this.mode]);
      this.reportIslandRect(false);
    }
    this.hub.autoClean = this.store.data.settings.agentAutoClean !== false;
    if (P.kind === 'desktop') this.hub.sweep(now);
    this.demo?.hub.sweep(now);
    this.pushIsland();
  }

  // ---------------- Режимы строки (ПК) ----------------

  hovering = false;
  /** ПК: машина состояний острова hidden → peek → home (src/island.ts). */
  island = new IslandFsm();
  private rectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Режим строки. На ПК это фаза острова: классы html.island-* (рисует CSS),
   * Rust меняет размер окна, click-through и фокус. fromFsm — вызов из машины
   * состояний; иначе (старый код: say, напоминания) машина просто узнаёт новое состояние.
   */
  applyMode(m: P.BarMode, fromFsm = false): void {
    if (P.kind === 'desktop' && m === 'collapsed' && this.mode === 'expanded' && !this.tempMood) this.flash('away', 1300);
    this.mode = m;
    const root = document.documentElement;
    root.classList.remove('mode-collapsed', 'mode-compact', 'mode-expanded');
    root.classList.add('mode-' + m);
    this.char.peek = m === 'collapsed' && P.kind === 'desktop' ? 0.18 : 0;
    this.char.lowPower = m === 'collapsed';
    if (P.kind === 'desktop') {
      if (!fromFsm) this.island.sync(PHASE_OF[m]);
      applyIslandClasses(PHASE_OF[m], root);
      this.reportIslandRect();
    }
    void P.setMode(m);
    if (m === 'expanded') setTimeout(() => P.kind === 'desktop' && $<HTMLInputElement>('#input').focus(), 60);
    this.renderBar();
  }

  /** Сообщить Rust, где видимый остров: вне него клики проходят на рабочий стол. */
  reportIslandRect(again = true): void {
    if (P.kind !== 'desktop') return;
    const send = () => {
      const ov = $('#overlay');
      // поверх открыто знакомство или сводка — окно принимает мышь целиком
      if (ov && !ov.hidden) return void P.islandRect({ x: 0, y: 0, width: innerWidth, height: innerHeight });
      const r = $('#shell').getBoundingClientRect();
      void P.islandRect(unionRect([{ x: r.left, y: r.top, width: r.width, height: r.height }]));
    };
    send();
    if (!again) return;
    // и ещё раз, когда пружинная анимация фазы закончится
    if (this.rectTimer) clearTimeout(this.rectTimer);
    this.rectTimer = setTimeout(send, 650);
  }

  /**
   * ПК: входы машины состояний острова. Наведение и «клик мимо» сообщает Rust
   * (опрос курсора видит мышь и там, где окно прозрачно для кликов), DOM — запасной путь.
   */
  bindIsland(): void {
    const enter = () => {
      this.hovering = true;
      this.island.enter();
    };
    const leave = () => {
      this.hovering = false;
      this.island.leave();
    };
    void P.listen('island-cursor', (c: { inside: boolean }) => (c.inside ? !this.hovering && enter() : this.hovering && leave()));
    void P.listen('island-outside', () => this.island.outside());
    void P.listen('island-screen', () => {
      void P.islandFitZoom();
      this.reportIslandRect();
    });
    $('#shell').addEventListener('mouseenter', () => !this.hovering && enter());
    $('#shell').addEventListener('mouseleave', () => this.hovering && leave());
    window.addEventListener('blur', () => {
      setTimeout(() => {
        if (!document.hasFocus()) this.island.blur();
      }, 250);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('#overlay').hidden) this.island.escape();
    });
    new ResizeObserver(() => this.reportIslandRect()).observe($('#shell'));
    window.addEventListener('resize', () => this.reportIslandRect());
    // файл тащат над островом или питомцем — Тук насторожился
    void P.listen('files-hover', (h: { state: string }) => {
      if (h.state === 'enter') this.flash('listen', 1500);
    });
    // питомца закрыли из его окна (двойной клик) или из трея
    void P.listen('pet-visible', (on: boolean) => {
      if (this.petOpen === on) return;
      this.petOpen = on;
      this.lastHtml = '';
      this.render();
    });
    void P.islandFitZoom();
    void P.islandScreen(this.store.data.settings.islandScreen === 'cursor' ? 'cursor' : 'primary');
  }

  toggleFromShortcut(how: 'toggle' | 'open' = 'toggle'): void {
    this.activity();
    if (P.kind === 'desktop') {
      if (how === 'open') this.island.open();
      else this.island.toggle();
      if (this.mode === 'expanded') this.flash('listen', 1500);
      return;
    }
    if (this.mode === 'expanded') this.applyMode('collapsed');
    else {
      this.applyMode('expanded');
      this.flash('listen', 1500);
    }
  }

  // ---------------- Команды ----------------

  async handleInput(text: string): Promise<void> {
    this.activity();
    // ответ на «Кому именно?»
    if (this.pendingPick && (await this.resolvePick(text))) return;
    // команда-действие: будильник, звонок, открыть приложение…
    const action = parseAction(text);
    if (action) return this.runAction(action);
    // голосом числа приходят словами: «через пять минут» → «через 5 минут»
    if (this.voiceAsked) text = wordsToDigits(text).replace(/^./, (c) => c.toUpperCase());
    // не узнали команду по правилам — пусть мозг поймёт свободную фразу («погаси свет на телефоне» → «выключи фонарик»)
    if (this.voiceAsked && looksLikeCommand(text) && this.canTalk()) {
      const canon = await this.brainToCommand(text).catch(() => null);
      if (canon) {
        const a2 = parseAction(canon);
        if (a2) return this.runAction(a2);
      }
    }
    const p = parse(text);
    if (p.type === 'empty') return;
    const question = /\?\s*$/.test(text.trim());
    // «купить хлеб», «позвонить маме» — дело; остальное без явной команды — разговор
    const todo = !question && /^[а-яё-]+(ть|ти|чь|ться|тись)(\s|$)/i.test(text.trim());
    const chatty = !todo && ((p.type === 'task' && !p.explicit && p.dueAt == null) || p.type === 'greet');
    if (chatty) {
      if (this.canTalk()) return this.converse(text);
      if (p.type !== 'greet') {
        this.setTab('chat');
        return this.say('Чтобы разговаривать, мне нужен мозг — его можно скачать во вкладке «Чат». А задачи записываю и так: «запиши …».', 'think', 6000);
      }
    }
    this.flash(p.type === 'done' || p.type === 'delete' || p.type === 'query' ? 'search' : 'think', 700);
    await new Promise((r) => setTimeout(r, 650));
    const s = this.store;

    switch (p.type) {
      case 'reminder': {
        s.add({ kind: 'reminder', text: p.text, dueAt: p.dueAt, repeat: p.repeat, tag: p.tag });
        const rep = p.repeat ? `, ${REPEAT_LABEL[p.repeat]}` : '';
        this.say(`Напомню ${fmtWhen(p.dueAt)}${rep}: «${p.text}»`, 'write', 1600);
        this.sfx('write');
        break;
      }
      case 'task': {
        s.add({ kind: 'task', text: p.text, dueAt: p.dueAt, allDay: p.allDay });
        const when = p.dueAt ? ` на ${fmtDay(p.dueAt)}` : '';
        const extra = p.reason === 'no-time' ? ' Чтобы напомнить, добавьте время: «завтра в 9».' : '';
        this.say(`Записал задачу${when}: «${p.text}».${extra}`, 'write', 1600);
        this.sfx('write');
        break;
      }
      case 'note':
        s.add({ kind: 'note', text: p.text });
        this.say('Записал заметку.', 'write', 1400);
        break;
      case 'health': {
        for (const r of p.records) s.add({ kind: 'health', text: p.text, health: r });
        this.say(this.healthReply(p.records), this.healthMood(p.records), 2500);
        break;
      }
      case 'done': {
        const it = this.find(p.query);
        if (!it) return this.say(`Не нашёл «${p.query}» среди открытых дел.`, 'think', 2500);
        const res = R.complete(s, it.id);
        if (it.tag === 'здоровье') s.add({ kind: 'health', text: it.text, health: { metric: 'meds', value: 1, unit: '' } });
        this.say(res?.done ? `Готово: «${it.text}». Молодец!` : `Отметил. Следующий раз — ${fmtWhen(res!.dueAt!)}.`, 'happy', 2200);
        break;
      }
      case 'delete': {
        const it = this.find(p.query, true);
        if (!it) return this.say(`Не нашёл «${p.query}».`, 'think', 2500);
        s.remove(it.id);
        this.say(`Удалил: «${it.text}».`, 'carry', 1500);
        break;
      }
      case 'query':
        this.setTab(p.what);
        this.say(this.summary(), 'help', 4000);
        break;
      case 'greet':
        this.say(`Привет! ${this.summary()}`, 'happy', 3000);
        break;
      case 'help':
        this.say('Например: «напомни завтра в 9 позвонить», «запиши купить кабель», «давление 125 на 80», «готово кабель». Файлы — 📎 или перетащите. Всё, что я умею, — в ⚙ → «Справка и демо».', 'help', 9000);
        this.setSec = 'help';
        this.setTab('settings');
        break;
    }
  }

  // ---------------- Разговор ----------------

  /** Есть ли чем думать: свой мозг или мозг ПК (для телефона). */
  canTalk(): boolean {
    return this.brain.ready || this.localOn() || (P.kind === 'android' && this.link.linked && !!this.store.data.settings.usePcBrain);
  }

  /** Включён ли мозг из Ollama / LM Studio. */
  localOn(): boolean {
    const l = this.store.data.settings.localAi;
    return !!l?.on && !!l.model && isLocalUrl(l.url);
  }

  contextText(): string {
    const now = Date.now();
    const s = this.store;
    const d = new Date(now);
    const lines: string[] = [];
    lines.push(`Сейчас: ${d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${fmtTime(now)}.`);
    const tasks = s.items.filter((i) => i.kind === 'task' && !i.done).slice(0, 12);
    lines.push(tasks.length ? 'Открытые дела:\n' + tasks.map((t) => `- ${t.text}${t.dueAt ? ` (на ${fmtDay(t.dueAt)})` : ''}`).join('\n') : 'Открытых дел нет.');
    const rem = R.activeReminders(s).sort((a, b) => a.dueAt! - b.dueAt!).slice(0, 10);
    lines.push(rem.length ? 'Напоминания:\n' + rem.map((r) => `- ${fmtWhen(r.dueAt!)} — ${r.text}${r.repeat ? ` (${REPEAT_LABEL[r.repeat]})` : ''}`).join('\n') : 'Напоминаний нет.');
    const done = s.items.filter((i) => i.done && (i.doneAt ?? 0) >= startOfDay()).map((i) => i.text);
    if (done.length) lines.push('Сделано сегодня: ' + done.join('; ') + '.');
    const latest = this.latestHealth();
    const h = (Object.keys(latest) as Metric[]).map((m) => `${METRIC_LABEL[m].toLowerCase()} ${healthText(latest[m]!.health!)} (${fmtDay(latest[m]!.createdAt)})`);
    if (h.length) lines.push('Последние записи здоровья: ' + h.join(', ') + '.');
    const notes = s.items.filter((i) => i.kind === 'note').sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
    if (notes.length) lines.push('Заметки:\n' + notes.map((n) => `- ${n.text}`).join('\n'));
    return lines.join('\n');
  }

  async converse(text: string): Promise<void> {
    if (this.generating) return this.say('Секунду, ещё думаю над прошлым ответом…', 'think', 2000);
    const d = this.store.data;
    const chat = (d.chat ??= []);
    chat.push({ role: 'user', content: text.trim(), ts: Date.now() });
    if (chat.length > 60) chat.splice(0, chat.length - 60);
    this.store.changed('chat');
    this.setTab('chat');

    let ctxText = this.contextText();
    if (this.files.length) ctxText += '\n\n' + filesContext(this.files);
    const history = chat.slice(this.files.length ? -6 : -12).map((m) => ({ role: m.role, content: m.content }));
    const messages: ChatMsg[] = [{ role: 'system', content: systemPrompt(d.settings.name, ctxText) }, ...history];
    this.generating = true;
    this.streamText = '';
    this.chatAbort = new AbortController();
    const look: Mood = this.files.length ? 'search' : 'think'; // с файлом — «ищет» в нём
    this.tempMood = look;
    this.tempUntil = Date.now() + 600_000;
    this.char.set(look);
    this.renderChatLive();
    let answer = '';
    try {
      const pcFirst = P.kind === 'android' && this.link.linked && d.settings.usePcBrain;
      if (pcFirst) {
        try {
          answer = await this.link.askPc(messages);
        } catch (e) {
          if (!this.brain.ready && !this.localOn()) throw new Error('ПК не ответил, а своего мозга на телефоне пока нет. Скачайте его во вкладке «Чат».');
        }
      }
      const onText = (full: string) => {
        if (!this.streamText) this.flash('work', 600_000);
        this.streamText = full;
        this.renderChatLive();
      };
      if (!answer && this.localOn() && (!pcFirst || !this.brain.ready)) {
        try {
          answer = await localChat(d.settings.localAi!, messages, onText, this.chatAbort.signal);
        } catch (e) {
          if (!this.brain.ready || this.chatAbort.signal.aborted) throw e;
        }
      }
      if (!answer) {
        if (!this.brain.ready) throw new Error('Мозг ещё не загружен — скачайте его в ⚙ → «Мозг» или подключите Ollama / LM Studio.');
        answer = await this.brain.chat(messages, onText, this.chatAbort.signal);
      }
      answer = answer.trim() || '…';
      chat.push({ role: 'assistant', content: answer, ts: Date.now() });
      this.store.changed('chat');
      this.flash('happy', 1500);
      this.sfx('message');
      if (this.voiceAsked) this.voiceContinue = true;
      this.say(answer, null, Math.min(30_000, 4000 + answer.length * 60));
    } catch (e) {
      const msg = this.chatAbort?.signal.aborted ? 'Хорошо, остановился.' : String((e as Error).message ?? e);
      if (this.streamText) chat.push({ role: 'assistant', content: this.streamText.trim() });
      this.say(msg, this.chatAbort?.signal.aborted ? 'idle' : 'think', 4000);
    } finally {
      this.generating = false;
      this.streamText = '';
      this.chatAbort = null;
      if (['think', 'listen', 'work', 'search'].includes(this.tempMood as string)) this.tempMood = null;
      this.lastHtml = '';
      this.render();
    }
  }

  /** Обновить только «печатающийся» пузырь, без перерисовки всей вкладки. */
  renderChatLive(): void {
    const el = document.querySelector('#stream-bubble');
    if (el) {
      el.textContent = this.streamText || '…';
      const v = $('#view');
      v.scrollTop = v.scrollHeight;
    } else if (this.tab === 'chat') {
      this.lastHtml = '';
      this.render();
    }
    if (this.streamText) {
      this.reply = this.streamText;
      this.replyUntil = Date.now() + 60_000;
      this.renderReply();
      this.renderBar();
    }
  }

  onBrainState(b: BrainState): void {
    const now = Date.now();
    if (b.s === 'downloading' && now - this.lastBrainRender < 400) return;
    this.lastBrainRender = now;
    if (b.s === 'ready' && this.tab === 'chat') this.say('Мозг загружен — давайте поговорим!', 'happy', 3000);
    if (this.tab === 'chat' || this.tab === 'settings') {
      this.lastHtml = '';
      this.render();
    }
  }

  brainHtml(full = false): string {
    const b = this.brain.state;
    const m = this.brain.model;
    const gb = (n: number) => (n / 1e9).toFixed(1).replace('.', ',') + ' ГБ';
    let body = '';
    switch (b.s) {
      case 'ready':
        body = `<div><b>Мозг: ${esc(m.name)}</b> <span class="muted">· ${esc(m.about)}</span></div>`;
        break;
      case 'absent':
        body = `<p>Чтобы разговаривать, мне нужен мозг — нейросеть <b>${esc(m.name)}</b> (${gb(m.bytes)}). Она скачается один раз по Wi-Fi, дальше я думаю без интернета.</p>
          <button class="pill big" data-act="brain-download">Скачать мозг · ${gb(m.bytes)}</button>`;
        break;
      case 'downloading': {
        const pct = Math.min(100, Math.round((b.done / (b.total || m.bytes)) * 100));
        body = `<div>Скачиваю мозг: <b>${pct}%</b> <span class="muted">${gb(b.done)} из ${gb(b.total || m.bytes)}</span></div><div class="bar-progress"><i style="width:${pct}%"></i></div><p class="muted">Можно пользоваться Туком как обычно. Если связь прервётся — нажмите «Скачать» ещё раз.</p>`;
        break;
      }
      case 'loading':
        body = '<div>Загружаю мозг в память… <span class="muted">это до минуты</span></div><div class="bar-progress busy"><i></i></div>';
        break;
      case 'error':
        body = `<div class="err">${esc(b.why)}</div><button class="pill" data-act="brain-download">Попробовать ещё раз</button>`;
        break;
      case 'unavailable':
        body = `<div class="err">Нейросеть не запускается на этом устройстве: ${esc(b.why)}</div>`;
        break;
    }
    if (full) {
      const choice = (Object.keys(MODELS) as ModelId[])
        .map((id) => `<button class="pill ${id === m.id ? '' : 'ghost'} small" data-act="set-model" data-id="${id}">${esc(MODELS[id].name)} · ${gb(MODELS[id].bytes)}</button>`)
        .join('');
      body += `<div class="row">${choice}</div><p class="muted small">«Лёгкий» быстрее, «Умный» лучше понимает. Нужно около ${P.kind === 'android' ? '2–3' : '3–4'} ГБ свободной памяти.</p>`;
      if (b.s === 'ready') body += '<button class="pill ghost small" data-act="brain-forget">Удалить мозг с устройства</button>';
      if (P.kind === 'android') body += `<label class="toggle"><input type="checkbox" id="set-usepc" ${this.store.data.settings.usePcBrain ? 'checked' : ''}> Думать головой ПК, когда он в той же сети (умнее)</label>`;
    }
    return `<div class="card brain">${body}</div>`;
  }

  chatHtml(): string {
    const chat = this.store.data.chat ?? [];
    const head = (this.brain.ready ? '' : this.localOn() ? `<p class="muted small">Отвечает локальный сервер: ${esc(this.store.data.settings.localAi!.model)}.</p>` : this.canTalk() ? '<p class="muted small">Отвечает мозг ПК. Свой мозг на телефоне можно скачать в ⚙.</p>' : this.brainHtml()) + this.filesHtml();
    const bubbles = chat
      .slice(-40)
      .map((m) => `<div class="msg ${m.role === 'user' ? 'me' : 'tuk'}">${esc(m.content)}</div>`)
      .join('');
    const live = this.generating ? `<div class="msg tuk live" id="stream-bubble">${esc(this.streamText || '…')}</div>` : '';
    const empty = !chat.length && !this.generating && !this.files.length
      ? `<p class="muted">Перетащите сюда файлы (txt, PDF, Word, Excel, картинки) или нажмите 📎 — и спросите о них. Или просто напишите что-нибудь: «как дела?», «что у меня завтра?», «посоветуй, с чего начать день». Команды вроде «напомни…» и «запиши…» работают как раньше.</p>`
      : '';
    const tools = this.generating
      ? '<button class="pill ghost small" data-act="chat-stop">Остановить</button>'
      : chat.length ? '<button class="pill ghost small" data-act="chat-clear">Новый разговор</button>' : '';
    return `${head}<div class="chat">${bubbles}${live}</div>${empty}<div class="row">${tools}</div>`;
  }

  find(query: string, includeAll = false): StoredItem | undefined {
    const pool = this.store.items.filter((i) => (includeAll ? i.kind !== 'health' : (i.kind === 'task' || i.kind === 'reminder') && !i.done));
    if (!query) return R.ringing(this.store)[0] ?? undefined;
    const words = normalize(query).split(/[\s,.]+/).filter((w) => w.length > 1).map((w) => w.slice(0, Math.max(3, Math.min(5, w.length - 1))));
    let best: StoredItem | undefined, bestScore = 0;
    for (const it of pool) {
      const t = normalize(it.text);
      const score = words.filter((w) => t.includes(w)).length / words.length;
      const bonus = it.kind === 'reminder' && R.ringing(this.store).includes(it) ? 0.01 : 0;
      if (score + bonus > bestScore) {
        bestScore = score + bonus;
        best = it;
      }
    }
    return bestScore >= 0.5 ? best : undefined;
  }

  healthReply(recs: { metric: Metric; value: number; value2?: number }[]): string {
    const parts = recs.map((r) => `${METRIC_LABEL[r.metric].toLowerCase()} ${healthText({ ...r, unit: '' })}`);
    let tail = '';
    const pr = recs.find((r) => r.metric === 'pressure');
    if (pr && (pr.value >= 140 || (pr.value2 ?? 0) >= 90)) tail = ' Давление выше 140/90 — если так часто, стоит показать записи врачу.';
    const water = recs.find((r) => r.metric === 'water');
    if (water) tail += ` Сегодня воды: ${this.todaySum('water')} мл.`;
    return `Записал: ${parts.join(', ')}.${tail}`;
  }

  healthMood(recs: { metric: Metric; value: number; value2?: number }[]): Mood {
    const pr = recs.find((r) => r.metric === 'pressure');
    if (pr && (pr.value >= 140 || (pr.value2 ?? 0) >= 90)) return 'alert';
    const mood = recs.find((r) => r.metric === 'mood');
    if (mood && mood.value <= 2) return 'listen';
    return 'happy';
  }

  todaySum(metric: Metric): number {
    const from = startOfDay();
    return this.store.items.filter((i) => i.kind === 'health' && i.health?.metric === metric && i.createdAt >= from).reduce((a, i) => a + (i.health?.value ?? 0), 0);
  }

  summary(): string {
    const now = Date.now();
    const end = startOfDay() + DAY;
    const ring = R.ringing(this.store, now).length;
    const rem = R.activeReminders(this.store).filter((i) => (i.dueAt ?? 0) > now && (i.dueAt ?? 0) < end).length;
    const tasks = this.store.items.filter((i) => i.kind === 'task' && !i.done).length;
    const parts: string[] = [];
    if (ring) parts.push(`просрочено: ${ring}`);
    parts.push(`напоминаний сегодня: ${rem}`);
    parts.push(`открытых задач: ${tasks}`);
    return parts.join(', ').replace(/^./, (c) => c.toUpperCase()) + '.';
  }

  sfx(name: Sound): void {
    if (this.store.data.settings.sound) play(name);
  }

  /** Наряд, цвет капюшона и огонька, громкость — из настроек. */
  applyLook(): void {
    setTimeout(() => this.islandOn && void this.sendSprites(), 300);
    const st = this.store.data.settings;
    this.char.outfit = !st.outfit || st.outfit === 'auto' ? seasonalOutfit() : st.outfit;
    this.char.hood = HOOD_COLORS[st.hoodColor ?? 'Чёрный'] ?? HOOD_COLORS['Чёрный'];
    this.char.idleLight = st.lightColor ? LIGHT_COLORS[st.lightColor] ?? null : null;
    setVolume(st.volume ?? 0.5);
  }

  /** Тычок в персонажа: злится, а после трёх быстрых — кружится голова. */
  poke(): void {
    const now = Date.now();
    this.pokes = this.pokes.filter((t) => now - t < 1500);
    this.pokes.push(now);
    if (this.pokes.length >= 3) {
      this.pokes = [];
      this.flash('dizzy', 2600);
      this.sfx('dizzy');
      this.say(['Ой-ой, всё кружится…', 'Хватит, голова кругом!', 'Мир вращается…'][Math.floor(Math.random() * 3)], null, 2400);
    } else {
      this.flash('poke', 900);
      this.sfx('poke');
    }
  }

  // ---------------- Файлы ----------------

  /** Принять файлы (скрепка, перетаскивание, Проводник). Сразу несколько. */
  async takeFiles(list: File[], paths: (string | undefined)[] = []): Promise<void> {
    if (!list.length) return;
    this.activity();
    if (P.kind === 'desktop' && this.mode !== 'expanded') this.applyMode('expanded');
    this.flash('eat', 1400);
    this.sfx('eat');
    setTimeout(() => this.tempMood === 'eat' && this.flash('search', 2500), 1300);
    const room = 8 - this.files.length;
    if (room <= 0) return this.say('Уже держу 8 файлов — уберите лишние, чтобы добавить новые.', 'think', 5000);
    if (list.length > room) this.say(`Возьму только ${room} из ${list.length} — больше 8 файлов сразу не удержу.`, 'think', 4000);
    const fresh: FileCard[] = [];
    for (let i = 0; i < Math.min(room, list.length); i++) fresh.push(await readFile(list[i], paths[i]));
    this.files.push(...fresh);
    fitBudget(this.files, MAX_CHARS);
    this.renderFileChip();
    this.setTab('chat');
    const names = fresh.length === 1 ? `«${fresh[0].name}»` : `${fresh.length} файла(ов)`;
    const cut = this.files.filter((c) => c.truncated);
    const bad = fresh.filter((c) => c.note && !c.full && c.kind !== 'image');
    let msg = `Проглотил ${names}.`;
    if (cut.length) msg += ` Текста много — мозгу уйдёт только начало ${cut.length === 1 ? `«${cut[0].name}»` : `${cut.length} файлов`}.`;
    if (bad.length === fresh.length) msg = `${names}: ${bad[0].note}`;
    else msg += this.canTalk() ? ' Спросите о содержимом или сделайте из файла заметку или задачи — кнопки во вкладке «Чат».' : ' Сделать заметку или задачи можно сразу, а чтобы спрашивать — нужен мозг (⚙ → «Мозг»).';
    this.say(msg, bad.length === fresh.length ? 'think' : null, 7000);
    if (bad.length === fresh.length) this.sfx('error');
  }

  /** Файлы, брошенные из Проводника на остров или питомца: содержимое приходит base64 от Rust. */
  async takeDropped(list: DroppedFile[]): Promise<void> {
    const files: File[] = [];
    const paths: (string | undefined)[] = [];
    for (const d of list) {
      const name = d.name || d.path?.split(/[\\/]/).pop() || 'файл';
      let bytes = new Uint8Array(0);
      if (d.data) {
        const bin = atob(d.data);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      }
      const f = new File([bytes as BlobPart], name);
      // без содержимого (слишком большой) — карточка с настоящим размером
      if (!d.data && d.size) Object.defineProperty(f, 'size', { value: d.size });
      files.push(f);
      paths.push(d.path);
    }
    return this.takeFiles(files, paths);
  }

  /** Совместимость: один файл. */
  takeFile(f: File): Promise<void> {
    return this.takeFiles([f]);
  }

  dropFile(id: string): void {
    const c = this.files.find((x) => x.id === id);
    if (c?.preview?.startsWith('blob:')) URL.revokeObjectURL(c.preview);
    this.files = id ? this.files.filter((x) => x.id !== id) : [];
    fitBudget(this.files, MAX_CHARS);
    this.renderFileChip();
    this.lastHtml = '';
    this.render();
  }

  renderFileChip(): void {
    const el = $('#file-chip');
    el.hidden = !this.files.length;
    if (!this.files.length) return void (el.innerHTML = '');
    const one = this.files.length === 1 ? this.files[0] : null;
    const label = one ? `${KIND_ICON[one.kind]} ${esc(one.name)}` : `📎 ${this.files.length} файла(ов): ${esc(this.files.map((c) => c.name).join(', '))}`;
    el.innerHTML = `<span title="Файлы для разговора">${label}${this.files.some((c) => c.truncated) ? ' <i class="muted">· обрезано</i>' : ''}</span><button data-act="tab" data-id="chat" aria-label="Показать файлы">⋯</button><button data-act="file-drop" data-id="" aria-label="Убрать все файлы">×</button>`;
  }

  /** Карточки файлов во вкладке «Чат»: превью, размер, обрезка, действия. */
  filesHtml(): string {
    if (!this.files.length) return '';
    const cards = this.files
      .map((c) => {
        const thumb = c.preview ? `<img class="fthumb" src="${esc(c.preview)}" alt="">` : `<div class="fthumb ficon">${KIND_ICON[c.kind]}</div>`;
        const cut = truncationNote(c);
        const tasks = c.full ? extractTasks(c.full).length : 0;
        const desk = P.kind === 'desktop' && c.path;
        return `<li class="item fcard">${thumb}<div class="body"><div class="t">${esc(c.name)}</div><div class="m">${esc(describe(c))}</div>
          ${c.note ? `<div class="m">${esc(c.note)}</div>` : ''}${cut ? `<div class="m warn-t">✂ ${esc(cut)}</div>` : ''}
          <div class="row">${c.full ? `<button class="pill ghost small" data-act="file-ask" data-id="${c.id}">Перескажи</button><button class="pill ghost small" data-act="file-note" data-id="${c.id}">В заметки</button><button class="pill ghost small" data-act="file-tasks" data-id="${c.id}">${tasks ? `Задачи (${tasks})` : 'Сделать задачей'}</button>` : `<button class="pill ghost small" data-act="file-note" data-id="${c.id}">Запомнить файл</button>`}
          ${desk ? `<button class="pill ghost small" data-act="file-open" data-id="${c.id}">Открыть</button><button class="pill ghost small" data-act="file-folder" data-id="${c.id}">Показать в папке</button>` : ''}</div></div>
          <button class="x" data-act="file-drop" data-id="${c.id}" aria-label="Убрать файл">×</button></li>`;
      })
      .join('');
    const total = this.files.reduce((a, c) => a + c.size, 0);
    return `<h3>Файлы · ${this.files.length} · ${fmtSize(total)}</h3><ul>${cards}</ul><p class="muted small">Спросите в строке ввода: «что в этих файлах?», «сравни таблицы», «найди сроки». Мозгу уходит до ${MAX_CHARS.toLocaleString('ru-RU')} символов на все файлы вместе.</p>`;
  }

  async fileAction(act: string, id: string): Promise<void> {
    const c = this.files.find((x) => x.id === id);
    if (!c) return;
    const s = this.store;
    switch (act) {
      case 'file-ask':
        if (!this.canTalk()) return this.say('Чтобы пересказать, нужен мозг: ⚙ → «Мозг» (или Ollama / LM Studio).', 'think', 5000);
        return this.converse(`Перескажи коротко, о чём файл «${c.name}», и выдели главное.`);
      case 'file-note':
        s.add({ kind: 'note', text: noteFromFile(c) });
        this.sfx('write');
        return this.say(`Сохранил «${c.name}» в заметки.`, 'write', 2500);
      case 'file-tasks': {
        const list = c.full ? extractTasks(c.full) : [];
        if (!list.length) {
          s.add({ kind: 'task', text: `Разобрать файл «${c.name}»`, dueAt: null, allDay: false });
          this.sfx('write');
          return this.say(`Пунктов-дел в файле не нашёл — записал задачу «Разобрать файл «${c.name}»».`, 'write', 4000);
        }
        for (const t of list) s.add({ kind: 'task', text: t, dueAt: null, allDay: false });
        this.sfx('write');
        return this.say(`Записал ${list.length} задач(и) из «${c.name}» — они во вкладке «Дела».`, 'write', 4000);
      }
      case 'file-open':
      case 'file-folder':
        if (!c.path) return;
        try {
          if (act === 'file-open') await P.openPath(c.path).catch(() => P.openTarget(c.path!));
          else await P.revealPath(c.path).catch(() => P.openTarget(c.path!.replace(/[\\/][^\\/]*$/, '')));
        } catch (e) {
          this.say('Не получилось открыть: ' + String((e as Error).message ?? e), 'think', 4000);
        }
    }
  }

  // ---------------- Недельная сводка ----------------

  showRecap(): void {
    this.flash('help', 3500);
    const st = this.store.data.settings;
    const chatTimes = (this.store.data.chat ?? []).filter((m) => m.role === 'user' && m.ts).map((m) => m.ts!);
    const r = computeRecap(Object.values(this.store.data.items), chatTimes);
    const canvas = renderRecap(r, { name: st.name, hood: this.char.hood, outfit: this.char.outfit });
    const url = canvas.toDataURL('image/png');
    const ov = $('#overlay') as HTMLElement & { _png?: string };
    ov.innerHTML = `<div class="sheet"><img src="${url}" alt="Недельная сводка"><div class="row">
      ${P.kind !== 'web' ? '<button class="pill" data-act="recap-save">Сохранить картинку</button>' : ''}
      <button class="pill ghost" data-act="overlay-close">Закрыть</button></div><p class="muted small" id="recap-note"></p></div>`;
    ov.hidden = false;
    ov._png = url;
    this.store.data.recapSeen = weekKey();
    this.store.changed('recap');
    this.flash('happy', 2000);
    this.sfx('done');
  }

  /** Превью нарядов в настройках — неподвижные картинки. */
  drawWardrobe(): void {
    for (const c of document.querySelectorAll<HTMLCanvasElement>('canvas[data-outfit]')) {
      if (c.dataset.done === '1') continue;
      c.dataset.done = '1';
      const ch = new Character(c, { still: true });
      ch.outfit = c.dataset.outfit as Outfit;
      ch.hood = this.char.hood;
      ch.idleLight = this.char.idleLight;
      ch.set('idle');
      ch.draw(performance.now());
    }
  }

  // ---------------- Агенты (Claude Code) ----------------

  /** Хаб, с которым работаем: демо-сценарий или настоящий. */
  get agentHub(): AgentHub {
    return this.demo?.hub ?? this.hub;
  }

  agentSessions(): Session[] {
    if (this.demo) return this.demo.hub.active;
    return P.kind === 'desktop' ? this.hub.active : this.remote?.sessions ?? [];
  }

  agentPending(): Pending[] {
    if (this.demo) return this.demo.hub.pending;
    return P.kind === 'desktop' ? this.hub.pending : this.remote?.pending ?? [];
  }

  /** Решения принимает этот компьютер (или демо), а не телефон через ПК. */
  get agentsLocal(): boolean {
    return !!this.demo || P.kind === 'desktop';
  }

  onAgentEvent(e: HubEvent): void {
    const name = this.store.data.settings.name;
    const quiet = !!this.demo; // в демо — без системных уведомлений
    if (e.type === 'permission') {
      this.sfx('alert');
      this.flash('alert', 4000);
      if (P.kind === 'desktop' && this.mode === 'collapsed') this.applyMode('compact');
      const what = e.p.questions ? `${e.p.agent ?? 'Claude'} спрашивает` : `${e.p.agent ?? 'Claude Code'} просит разрешения`;
      if (!quiet) void P.notify(`${name}: ${what} · ${e.p.project}`, e.p.questions ? e.p.questions[0].question : `${e.p.tool}: ${e.p.summary}`);
    } else if (e.type === 'done') {
      this.flash('happy', 2500);
      this.sfx('done');
      if (!quiet) void P.notify(`${name}: ${e.s.agent} закончил`, `Проект «${e.s.project}»${e.s.plus || e.s.minus ? ` · +${e.s.plus} −${e.s.minus}` : ''}`);
    } else if (e.type === 'error') {
      this.sfx('error');
      if (!quiet) void P.notify(`${name}: ${e.s.agent} — ошибка`, `Проект «${e.s.project}»`);
    } else if (e.type === 'waiting') {
      if (!quiet) void P.notify(`${name}: ${e.s.agent} ждёт вас`, e.message);
    }
    this.renderAgents();
  }

  renderAgents(): void {
    // вкладка «Агенты» видна всегда — раньше она пряталась, пока не подключён Claude Code
    const n = this.agentPending().length;
    const tab = $('#tab-agents');
    tab.hidden = false;
    tab.textContent = n ? `Агенты · ${n}` : this.agentSessions().length ? `Агенты · ${this.agentSessions().length}` : 'Агенты';
    tab.classList.toggle('attn', n > 0);
    this.renderBar();
    if (this.tab === 'agents') {
      this.lastHtml = '';
      this.render();
    }
  }

  async decideAgent(reqId: number, d: 'allow' | 'deny' | 'always'): Promise<void> {
    if (this.agentsLocal) {
      if (!this.agentHub.decide(reqId, d)) return this.say('Этот запрос уже неактуален — его забрал терминал.', 'think', 3000);
    } else {
      if (d !== 'deny' && !(await P.biometric('Разрешить действие агента'))) return;
      try {
        await this.link.sendDecision(reqId, d);
        if (this.remote) this.remote.pending = this.remote.pending.filter((p) => p.reqId !== reqId);
      } catch (e) {
        return this.say('ПК не ответил: ' + String((e as Error).message ?? e), 'think', 4000);
      }
    }
    this.sfx(d === 'deny' ? 'poke' : 'done');
    this.renderAgents();
  }

  /** Выбрать вариант в вопросе агента. Один вариант — отвечаем сразу, несколько — по кнопке «Ответить». */
  async pickOption(reqId: number, qi: number, label: string): Promise<void> {
    const p = this.agentPending().find((x) => x.reqId === reqId);
    const q = p?.questions?.[qi];
    if (!p || !q) return;
    const sel = this.qSel.get(reqId) ?? {};
    const cur = new Set(sel[q.question] ?? []);
    if (q.multiSelect) cur.has(label) ? cur.delete(label) : cur.add(label);
    else {
      cur.clear();
      cur.add(label);
    }
    sel[q.question] = [...cur];
    this.qSel.set(reqId, sel);
    const complete = p.questions!.every((x) => (sel[x.question] ?? []).length > 0);
    if (complete && !p.questions!.some((x) => x.multiSelect)) return this.answerAgent(reqId);
    this.lastHtml = '';
    this.render();
  }

  async answerAgent(reqId: number): Promise<void> {
    const p = this.agentPending().find((x) => x.reqId === reqId);
    const sel = this.qSel.get(reqId) ?? {};
    if (!p?.questions) return;
    if (p.questions.some((q) => !(sel[q.question] ?? []).length)) return this.say('Выберите ответ на каждый вопрос.', 'think', 3000);
    const answers: Record<string, string | string[]> = {};
    for (const q of p.questions) answers[q.question] = q.multiSelect ? sel[q.question] : sel[q.question][0];
    let ok = false;
    try {
      if (this.agentsLocal) ok = this.agentHub.answer(reqId, answers);
      else {
        ok = await this.link.sendAnswer(reqId, answers);
        if (ok && this.remote) this.remote.pending = this.remote.pending.filter((x) => x.reqId !== reqId);
      }
    } catch (e) {
      return this.say('ПК не ответил: ' + String((e as Error).message ?? e), 'think', 4000);
    }
    this.qSel.delete(reqId);
    if (!ok) return this.say('Ответ не подошёл или вопрос уже закрыт — ответьте в терминале.', 'think', 4000);
    this.sfx('done');
    this.say(`Ответил ${p.agent ?? 'Claude'}: ${Object.values(answers).flat().join(', ')}`, 'happy', 3000);
    this.renderAgents();
  }

  async closeSession(id: string): Promise<void> {
    if (this.agentsLocal) this.agentHub.close(id);
    else {
      try {
        await this.link.sendClose(id);
        if (this.remote) this.remote.sessions = this.remote.sessions.filter((s) => s.id !== id);
      } catch (e) {
        return this.say('ПК не ответил: ' + String((e as Error).message ?? e), 'think', 4000);
      }
    }
    this.renderAgents();
  }

  /** Телефон: раз в 3 секунды спрашиваем ПК, что делают агенты. */
  async pollAgents(): Promise<void> {
    if (P.kind !== 'android' || !this.link.linked || document.hidden) return;
    try {
      const snap = await this.link.askAgents<{ sessions: Session[]; pending: Pending[] }>();
      const known = new Set((this.remote?.pending ?? []).map((p) => p.reqId));
      const fresh = snap.pending.filter((p) => !known.has(p.reqId));
      this.remote = snap;
      if (fresh.length) {
        this.sfx('alert');
        this.flash('alert', 4000);
        navigator.vibrate?.([120, 80, 120]);
      }
      this.renderAgents();
    } catch {
      /* ПК недоступен — попробуем позже */
    }
  }

  async checkClaude(): Promise<void> {
    if (P.kind !== 'desktop') return;
    try {
      this.claudeHooks = hooksInstalled(await P.claudeRead());
    } catch {
      this.claudeHooks = false;
    }
    this.renderAgents();
  }

  async setClaudeHooks(on: boolean): Promise<void> {
    try {
      const info = await P.claudeInfo();
      if (!info) return;
      const cur = await P.claudeRead();
      const next = on ? installHooks(cur, info.exe) : uninstallHooks(cur);
      await P.claudeWrite(next);
      this.claudeHooks = on;
      this.say(on ? 'Подключил Claude Code. Перезапустите его — и я начну следить за работой.' : 'Отключил Claude Code. Остальные настройки не тронуты.', on ? 'happy' : 'idle', 6000);
      this.sfx(on ? 'link' : 'poke');
    } catch (e) {
      this.sfx('error');
      this.say('Не получилось изменить настройки Claude Code: ' + String((e as Error).message ?? e), 'think', 6000);
    }
    this.lastHtml = '';
    this.render();
    this.renderAgents();
  }

  /** Карточка одного запроса: разрешение или вопрос с вариантами. */
  pendingHtml(p: Pending, pos: number, total: number): string {
    const head = `<div class="who"><i class="dotc" style="background:${esc(p.color ?? '#f4c470')}"></i><b>${esc(p.agent ?? 'Claude Code')}</b> · ${esc(p.project)} · ${ago(p.created)}${total > 1 ? ` <span class="muted">· ${pos + 1} из ${total}</span>` : ''}</div>`;
    if (p.questions) {
      const sel = this.qSel.get(p.reqId) ?? {};
      const qs = p.questions
        .map((q, qi) => {
          const opts = q.options
            .map((o) => {
              const on = (sel[q.question] ?? []).includes(o.label);
              return `<button class="opt ${on ? 'on' : ''}" data-act="agent-pick" data-id="${p.reqId}" data-q="${qi}" data-label="${esc(o.label)}" title="${esc(o.description ?? '')}"><b>${q.multiSelect ? (on ? '☑ ' : '☐ ') : ''}${esc(o.label)}</b>${o.description ? `<span>${esc(o.description)}</span>` : ''}</button>`;
            })
            .join('');
          return `<div class="q">${q.header ? `<span class="muted small">${esc(q.header)}</span> ` : ''}<div class="t">${esc(q.question)}</div><div class="opts">${opts}</div>${q.multiSelect ? '<span class="muted small">Можно выбрать несколько.</span>' : ''}</div>`;
        })
        .join('');
      const needBtn = p.questions.length > 1 || p.questions.some((q) => q.multiSelect);
      return `<li class="item perm ask" style="--sc:${esc(p.color ?? '#7cc4ff')}"><div class="body">${head}${qs}
        <div class="row">${needBtn ? `<button class="pill small" data-act="agent-answer" data-id="${p.reqId}">Ответить</button>` : ''}<button class="pill ghost small" data-act="agent-deny" data-id="${p.reqId}">Отвечу в терминале</button></div></div></li>`;
    }
    return `<li class="item perm" style="--sc:${esc(p.color ?? '#f4c470')}"><div class="body">${head}<div class="t"><b>${esc(p.tool)}</b> · <code>${esc(p.summary)}</code></div>
      <div class="row"><button class="pill small" data-act="agent-allow" data-id="${p.reqId}">Разрешить</button><button class="pill ghost small" data-act="agent-always" data-id="${p.reqId}">Всегда в «${esc(p.project)}»</button><button class="pill ghost small" data-act="agent-deny" data-id="${p.reqId}">Запретить</button></div></div></li>`;
  }

  agentsHtml(): string {
    const pend = this.agentPending();
    const sess = this.agentSessions();
    const now = Date.now();
    let h = '';
    if (this.demo) h += `<div class="card demo-banner"><b>Демо-режим</b> <span class="muted">— две выдуманные сессии, разрешение и вопрос. Ничего не записывается и никуда не отправляется.</span><div class="row"><button class="pill ghost small" data-act="demo-stop">Выйти из демо</button></div></div>`;
    if (pend.length) {
      h += `<h3 class="warn">Ждут вашего ответа · ${pend.length}</h3><ul>${pend.map((p, i) => this.pendingHtml(p, i, pend.length)).join('')}</ul>`;
      if (pend.length > 1) h += '<p class="muted small">Каждый запрос привязан к своей сессии — отвечайте в любом порядке. Без ответа за 2 минуты вопрос вернётся в терминал.</p>';
    }
    if (sess.length) {
      // пилюли сессий — коротко, все сразу
      h += `<h3>Сессии · ${sess.length}</h3><div class="spills">${sess
        .map((s) => {
          const last = s.steps[s.steps.length - 1];
          const step = s.status === 'working' && last ? `${KIND_LABEL[last.kind]} ${last.text}` : STATUS_LABEL[s.status];
          return `<a class="spill st-${s.status}" href="#s-${esc(s.id)}" style="--sc:${esc(s.color ?? '#f4c470')}"><i></i><b>${esc(s.project)}</b><span>${esc(step)}</span>${s.plus || s.minus ? `<em><span class="plus">+${s.plus}</span> <span class="minus">−${s.minus}</span></em>` : ''}</a>`;
        })
        .join('')}</div>`;
      for (const s of sess) {
        h += `<div class="session" id="s-${esc(s.id)}" style="--sc:${esc(s.color ?? '#f4c470')}"><h3><i class="dotc"></i>${esc(s.project)} <span class="pill-status st-${s.status}">${STATUS_LABEL[s.status]}</span>
          <span class="muted small">${esc(s.agent)}${s.started ? ` · ${duration(now - s.started)}` : ''}${s.plus || s.minus ? ` · <span class="plus">+${s.plus}</span> <span class="minus">−${s.minus}</span>` : ''}</span>
          <button class="x" data-act="agent-close" data-id="${esc(s.id)}" title="Закрыть сессию: убрать пилюлю, её вопросы уйдут в терминал" aria-label="Закрыть сессию">×</button></h3>`;
        if (s.prompt) h += `<p class="muted small">«${esc(s.prompt)}»</p>`;
        const steps = s.steps.slice(-10).reverse();
        if (steps.length)
          h += `<ul class="steps">${steps
            .map((st) => `<li><span class="k k-${st.kind}">${KIND_LABEL[st.kind]}</span> <span class="tx">${esc(st.text)}</span>${st.plus != null ? ` <span class="plus">+${st.plus}</span> <span class="minus">−${st.minus}</span>` : ''}</li>`)
            .join('')}</ul>`;
        if (s.final) h += `<p class="small final">💬 ${esc(s.final)}</p>`;
        h += '</div>';
      }
      if (sess.some((s) => ['done', 'ended', 'stale', 'error'].includes(s.status))) h += '<div class="row"><button class="pill ghost small" data-act="agents-clear">Убрать закончившие</button></div>';
    }
    if (!sess.length && !pend.length) {
      if (P.kind === 'desktop' && !this.claudeHooks)
        h += `<div class="card"><p><b>Тук может следить за Claude Code</b> — показывать шаги каждой сессии своим цветом, правки +N/−M, просить разрешения и отвечать на вопросы прямо отсюда (и с телефона).</p>
          <div class="row"><button class="pill small" data-act="claude-on">Подключить Claude Code</button><button class="pill ghost small" data-act="demo-start">Посмотреть демо</button></div>
          <p class="muted small">Тук добавит свои хуки в ~/.claude/settings.json, сохранив ваши настройки. Отключить — ⚙ → «Агенты».</p></div>`;
      else
        h += `<p class="muted">${P.kind === 'desktop' ? 'Запустите Claude Code — здесь появятся его сессии, шаги, правки и запросы разрешений. Несколько сессий сразу — каждая своим цветом.' : this.link.linked ? 'Когда на ПК работает Claude Code, здесь видно каждую сессию, и можно разрешать действия и отвечать на вопросы.' : 'Свяжите телефон с ПК (⚙ → «Связь»), чтобы видеть здесь сессии Claude Code и отвечать на запросы.'}</p>
          <div class="row"><button class="pill ghost small" data-act="demo-start">Посмотреть демо</button></div>`;
    }
    if (P.kind === 'desktop' && !this.demo) h += `<label class="toggle"><input type="checkbox" id="set-agentclean" ${this.store.data.settings.agentAutoClean !== false ? 'checked' : ''}> Убирать закончившие сессии через 30 мин и молчащие — через час</label>`;
    return h;
  }

  // ---------------- Демо-режим ----------------
  // По мотивам Coucou (MIT, Louis Raillé): сценарий показывает все состояния без настройки и
  // ничего не пишет на диск — отдельный хаб, файл в памяти, настроения по очереди.

  startDemo(): void {
    this.stopDemo(true);
    const hub = new AgentHub(() => {}, () => [], () => {});
    hub.onChange = () => this.renderAgents();
    hub.onEvent = (e) => this.onAgentEvent(e);
    const timers: ReturnType<typeof setTimeout>[] = [];
    this.demo = { hub, timers };
    demoScript().forEach((e, i) => timers.push(setTimeout(() => hub.handle(9000 + i, JSON.stringify(e.body)), e.at)));
    // все настроения персонажа по очереди
    const moods = Object.keys(MOOD_LABEL) as Mood[];
    moods.forEach((m, i) =>
      timers.push(
        setTimeout(() => {
          this.flash(m, 1500);
          this.reply = `Демо: ${MOOD_LABEL[m]} (${i + 1} из ${moods.length})`;
          this.replyUntil = Date.now() + 1500;
          this.renderReply();
          this.renderBar();
        }, 5200 + i * 1600),
      ),
    );
    // файл-пример: карточка, обрезка и действия — только в памяти
    if (!this.files.length) {
      const text = '# План работ\n- [ ] Купить кабель ВВГ 3×2,5\n- [ ] Заказать вентилятор EKF\n- [ ] Проверить щит 600×800\n\n' + 'Пояснение к расчёту. '.repeat(400);
      void this.takeFiles([new File([text], 'Демо — план работ.md')]).then(() => this.demo && this.setTab('agents'));
    }
    this.applyMode('expanded');
    this.setTab('agents');
    this.say('Демо: две сессии Claude Code, разрешение, вопрос, файл и все мои настроения. Ничего не сохраняется.', 'wave', 5000);
  }

  stopDemo(silent = false): void {
    if (!this.demo) return;
    for (const t of this.demo.timers) clearTimeout(t);
    this.demo = null;
    this.files = this.files.filter((c) => !c.name.startsWith('Демо — '));
    this.renderFileChip();
    this.renderAgents();
    if (!silent) this.say('Демо закончилось — всё вернул как было.', 'idle', 3000);
  }

  // ---------------- Первый запуск ----------------

  /** Три шага: питомец/остров, горячая клавиша/голос, мозг. Можно открыть снова из ⚙ → «Справка и демо». */
  renderOnboarding(): void {
    const ov = $('#overlay');
    const st = this.store.data.settings;
    const step = Math.min(this.onboardStep, 2);
    const desk = P.kind === 'desktop';
    const dots = [0, 1, 2].map((i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('');
    let body = '';
    if (step === 0) {
      body = desk
        ? `<h2>Привет! Я ${esc(st.name)}.</h2><p>Я живу у верхнего края экрана: наведите мышь — выгляну, щёлкните — раскроюсь. А ещё могу жить прямо на рабочем столе.</p>
          <div class="row"><button class="pill ${this.petOpen ? 'ghost' : ''}" data-act="${this.petOpen ? 'pet-off' : 'pet-on'}">${this.petOpen ? 'Вернуть в строку' : 'Выпустить на рабочий стол'}</button></div>
          <p class="muted small">Перетаскивайте меня мышью; двойной щелчок — обратно в строку. Это же — в меню значка в трее.</p>`
        : P.kind === 'android'
          ? `<h2>Привет! Я ${esc(st.name)}.</h2><p>Могу жить вверху экрана поверх любых приложений — нажали на меня, и открылось маленькое окно с делами и голосом.</p>
            <div class="row"><button class="pill" data-act="island-on">Включить Тука над приложениями</button></div><p class="muted small">Android попросит разрешение «Поверх других приложений».</p>`
          : `<h2>Привет! Я ${esc(st.name)}.</h2><p>Это демо в браузере. В приложении я живу у верхнего края экрана Windows и над приложениями на телефоне.</p>`;
    } else if (step === 1) {
      body = desk
        ? `<h2>Позвать меня</h2><p><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Пробел</kbd> — открыть или свернуть из любой программы, ввод сразу в фокусе. <kbd>Esc</kbd> — свернуть.</p>
          <p>Внутри: <kbd>Alt</kbd>+<kbd>1</kbd>…<kbd>8</kbd> — вкладки, <kbd>Ctrl</kbd>+<kbd>O</kbd> — прикрепить файлы.</p>
          <label class="toggle"><input type="checkbox" id="set-autostart" ${st.autostart ? 'checked' : ''}> Запускать вместе с Windows</label>`
        : `<h2>Позвать меня</h2><p>Нажмите 🎤 и говорите${P.kind === 'android' ? ' — или включите «Тук Тук», чтобы звать голосом с любого экрана' : ''}.</p>
          ${P.kind === 'android' ? '<div class="row"><button class="pill ghost" data-act="wake-on">Включить «Тук Тук»</button></div>' : ''}`;
      body += '<p class="muted small">Пишите как человеку: «напомни завтра в 9 позвонить», «запиши купить кабель», «давление 125 на 80».</p>';
    } else {
      const b = this.brain.state;
      body = `<h2>Мозг</h2><p>Чтобы разговаривать и обсуждать файлы, мне нужна нейросеть. Она работает без интернета, прямо на устройстве.</p>
        ${b.s === 'ready' ? '<p><b>Мозг уже загружен ✓</b></p>' : `<div class="row"><button class="pill" data-act="brain-download">Скачать мозг «${esc(this.brain.model.name)}» · ${(this.brain.model.bytes / 1e9).toFixed(1).replace('.', ',')} ГБ</button></div>`}
        ${desk ? '<p class="muted small">Уже есть Ollama или LM Studio? Подключите их в ⚙ → «Мозг» — скачивать ничего не придётся.</p>' : ''}
        <p class="muted small">Записи, напоминания, файлы-заметки и Claude Code работают и без мозга.</p>`;
    }
    ov.innerHTML = `<div class="sheet onboard"><div class="steps-dots">${dots}</div>${body}
      <div class="row nav">${step > 0 ? '<button class="pill ghost" data-act="onboard-back">Назад</button>' : '<button class="pill ghost" data-act="onboard-skip">Пропустить</button>'}
      ${step < 2 ? '<button class="pill" data-act="onboard-next">Дальше</button>' : '<button class="pill" data-act="onboard-done">Готово</button>'}
      <button class="pill ghost small" data-act="demo-start" title="Посмотреть все состояния без настройки">Демо</button></div></div>`;
    ov.hidden = false;
    if (P.kind === 'desktop' && this.mode !== 'expanded') this.applyMode('expanded');
  }

  finishOnboarding(): void {
    $('#overlay').hidden = true;
    if (!this.store.data.settings.onboarded) {
      this.store.data.settings.onboarded = true;
      this.store.changed('settings');
    }
    this.say('Если что — всё это есть в ⚙. Напишите «помощь», чтобы увидеть, что я умею.', 'happy', 5000);
  }

  // ---------------- Локальный сервер (Ollama / LM Studio) ----------------

  async checkLocal(): Promise<void> {
    const l = (this.store.data.settings.localAi ??= { on: false, url: LOCAL_PRESETS[0].url, model: '' });
    const input = document.querySelector<HTMLInputElement>('#set-local-url');
    if (input) l.url = input.value.trim();
    try {
      this.localModels = await listModels(l.url);
      if (!this.localModels.length) this.say('Сервер отвечает, но моделей нет. В Ollama: «ollama pull qwen3:4b».', 'think', 6000);
      else {
        if (!l.model || !this.localModels.includes(l.model)) l.model = this.localModels[0];
        this.say(`Нашёл моделей: ${this.localModels.length}. Выберите, какой думать.`, 'happy', 4000);
      }
    } catch (e) {
      this.localModels = [];
      this.say(String((e as Error).message ?? e), 'think', 8000);
    }
    this.store.changed('settings');
    this.lastHtml = '';
    this.render();
  }

  localHtml(): string {
    const l = this.store.data.settings.localAi ?? { on: false, url: LOCAL_PRESETS[0].url, model: '' };
    return `<h3>Ollama / LM Studio</h3><div class="card">
      <span class="muted">Если на этом ПК (или дома в сети) уже запущен сервер нейросети, Тук может думать им — быстрее и умнее встроенного мозга. Только локальные адреса: облака Тук не использует.</span>
      <div class="row">${LOCAL_PRESETS.map((x) => `<button class="pill ghost small ${l.url === x.url ? 'on' : ''}" data-act="local-preset" data-id="${x.url}">${x.name}</button>`).join('')}</div>
      <div class="row"><input id="set-local-url" value="${esc(l.url)}" placeholder="http://127.0.0.1:11434"><button class="pill small" data-act="local-check">Проверить</button></div>
      ${this.localModels.length ? `<div class="row">${this.localModels.map((m) => `<button class="pill small ${m === l.model ? '' : 'ghost'}" data-act="local-model" data-id="${esc(m)}">${esc(m)}</button>`).join('')}</div>` : l.model ? `<p class="muted small">Модель: <b>${esc(l.model)}</b></p>` : ''}
      <label class="toggle"><input type="checkbox" id="set-local-on" ${l.on ? 'checked' : ''} ${l.model ? '' : 'disabled'}> Думать этим сервером${this.brain.ready ? ' (встроенный мозг — запасной)' : ''}</label></div>`;
  }

  // ---------------- Горячие клавиши ----------------

  showShortcuts(): void {
    const ov = $('#overlay');
    const rows: [string, string][] = [
      ...(P.kind === 'desktop' ? ([['Ctrl+Alt+Пробел', 'открыть / свернуть Тука из любой программы'], ['Esc', 'свернуть']] as [string, string][]) : []),
      ['Alt+1 … Alt+8', 'вкладки: Сегодня, Чат, Дела, Напоминания, Здоровье, Заметки, Агенты, ⚙'],
      ['Ctrl+O', 'прикрепить файлы'],
      ['Ctrl+Enter', 'разрешить первый запрос агента'],
      ['Ctrl+Backspace', 'запретить первый запрос агента'],
      ['/ или Ctrl+K', 'перейти в строку ввода'],
      ['?', 'эта подсказка'],
    ];
    ov.innerHTML = `<div class="sheet onboard"><h2>Горячие клавиши</h2><table class="keys">${rows.map(([k, v]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(v)}</td></tr>`).join('')}</table><div class="row"><button class="pill" data-act="overlay-close">Понятно</button></div></div>`;
    ov.hidden = false;
  }

  onKey(e: KeyboardEvent): void {
    const typing = (e.target as HTMLElement)?.matches?.('input, textarea');
    if (e.altKey && !e.ctrlKey && /^Digit[1-8]$/.test(e.code)) {
      e.preventDefault();
      this.setTab(TAB_ORDER[+e.code.slice(5) - 1]);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyO') {
      e.preventDefault();
      $<HTMLInputElement>('#file-input').click();
      return;
    }
    const first = this.agentPending()[0];
    if ((e.ctrlKey || e.metaKey) && first && !first.questions && (e.key === 'Enter' || e.key === 'Backspace') && !(typing && e.key === 'Backspace')) {
      e.preventDefault();
      void this.decideAgent(first.reqId, e.key === 'Enter' ? 'allow' : 'deny');
      return;
    }
    if ((e.ctrlKey && e.code === 'KeyK') || (!typing && e.key === '/')) {
      e.preventDefault();
      $<HTMLInputElement>('#input').focus();
      return;
    }
    if (!typing && e.key === '?') this.showShortcuts();
    if (e.key === 'Escape' && !$('#overlay').hidden) {
      $('#overlay').hidden = true;
      if (!this.store.data.settings.onboarded) this.finishOnboarding();
    }
  }

  // ---------------- Музыка ----------------

  async pollMedia(): Promise<void> {
    try {
      const m = await P.mediaInfo();
      const changed = JSON.stringify(m) !== JSON.stringify(this.media);
      this.media = m;
      if (m && m.title !== this.mediaTitle) {
        this.mediaTitle = m.title;
        const b64 = await P.mediaThumb().catch(() => '');
        this.mediaCover = b64 ? `data:image/jpeg;base64,${b64}` : '';
      }
      if (changed) {
        this.renderBar();
        if (this.tab === 'today') this.render();
      }
    } catch {
      this.media = null;
    }
  }

  musicHtml(): string {
    const m = this.media;
    if (!m) return '';
    return `<div class="card music">${this.mediaCover ? `<img src="${this.mediaCover}" alt="">` : '<div class="cover">♪</div>'}
      <div class="body"><div class="t">${esc(m.title || 'Без названия')}</div><div class="m">${esc(m.artist)}</div></div>
      <div class="ctl"><button class="mini" data-act="media-prev" aria-label="Назад">⏮</button><button class="mini ok" data-act="media-toggle" aria-label="Пауза">${m.playing ? '⏸' : '▶'}</button><button class="mini" data-act="media-next" aria-label="Дальше">⏭</button></div></div>`;
  }

  // ---------------- Питомец ----------------

  /** Отправить состояние персонажа окну питомца, если оно изменилось. */
  syncPet(force = false): void {
    if (P.kind !== 'desktop') return;
    const st: PetState = { mood: this.char.mood, outfit: this.char.outfit, hood: this.char.hood, light: this.char.idleLight };
    const key = JSON.stringify(st);
    if (!force && key === this.lastPet) return;
    this.lastPet = key;
    void P.emit('pet-state', st);
  }

  async togglePet(show: boolean): Promise<void> {
    try {
      await P.petShow(show);
      this.petOpen = show;
      this.sfx(show ? 'hello' : 'poke');
      this.say(show ? 'Я на рабочем столе! Перетаскивайте меня, двойной клик — верну в строку.' : 'Вернулся в строку.', show ? 'wave' : 'idle', 3500);
      setTimeout(() => this.syncPet(true), 600);
    } catch (e) {
      this.say('Не получилось: ' + String((e as Error).message ?? e), 'think', 4000);
    }
    this.lastHtml = '';
    this.render();
  }

  // ---------------- Остров (Android) ----------------

  /** Включить остров при запуске, если он был включён. */
  async startIsland(): Promise<void> {
    if (P.kind !== 'android') return;
    const set = this.store.data.settings;
    try {
      const st = await P.island('check');
      this.islandState = st;
      if (!set.island && !set.wake) return;
      if (!st?.granted) return;
      const wake = !!set.wake && st.model === 'ready' && st.mic;
      await P.island('config', { show: !!set.island, wake });
      this.islandOn = !!set.island;
      this.islandKey = '';
      await this.sendSprites();
      this.pushIsland();
    } catch (e) {
      console.warn('остров:', e);
    }
  }

  /** «Тук Тук»: скачать распознавание (один раз) и включить прослушивание. */
  async toggleWake(on: boolean): Promise<void> {
    const set = this.store.data.settings;
    if (!on) {
      set.wake = false;
      this.store.changed('settings');
      await this.startIsland();
      if (!set.island) await P.island('config', { show: false, wake: false }).catch(() => {});
      this.say('Больше не слушаю «Тук Тук».', 'idle', 3000);
      this.lastHtml = '';
      return this.render();
    }
    const st = await P.island('check').catch(() => null);
    this.islandState = st;
    if (!st?.granted) {
      this.awaitGrant = true;
      set.wake = true;
      this.store.changed('settings');
      this.say('Разрешите Туку «Поверх других приложений» — тогда он сможет откликаться на «Тук Тук» из любого места.', 'think', 8000);
      return void P.island('grant').catch(() => {});
    }
    if (st.model !== 'ready') {
      set.wake = true;
      this.store.changed('settings');
      await P.island('download');
      this.say('Скачиваю распознавание речи (45 МБ) — это один раз, дальше всё работает без интернета.', 'carry', 6000);
      this.watchModel();
      return;
    }
    set.wake = true;
    this.store.changed('settings');
    try {
      await P.island('config', { show: !!set.island, wake: true });
      this.say('Слушаю! Скажите «Тук Тук» — и команду. Можно сразу: «Тук Тук, напомни через час позвонить».', 'listen', 6000);
    } catch (e) {
      set.wake = false;
      this.say(String((e as Error).message ?? e), 'think', 6000);
    }
    await this.startIsland();
    this.lastHtml = '';
    this.render();
  }

  /** Следить за скачиванием модели и включить «Тук Тук», когда готово. */
  watchModel(): void {
    if (this.modelTimer) return;
    this.modelTimer = setInterval(async () => {
      const st = await P.island('check').catch(() => null);
      this.islandState = st;
      if (this.tab === 'settings') {
        this.lastHtml = '';
        this.render();
      }
      if (st?.model === 'ready' || st?.model === 'error') {
        clearInterval(this.modelTimer!);
        this.modelTimer = null;
        if (st.model === 'ready') await this.toggleWake(true);
        else this.say('Не получилось скачать распознавание: ' + (st.error ?? 'нет интернета?'), 'think', 6000);
      }
    }, 1000);
  }

  wakeHtml(): string {
    const st = this.islandState;
    const set = this.store.data.settings;
    let h = '<h3>«Тук Тук» — голосом</h3><div class="card">';
    if (st?.model === 'downloading') {
      h += `<b>Скачиваю распознавание…</b><div class="progress"><i style="width:${st.progress ?? 0}%"></i></div><span class="muted small">${st.progress ?? 0}% · один раз, ~45 МБ</span>`;
    } else if (set.wake && st?.model === 'ready') {
      h += '<b>Слушаю «Тук Тук».</b> <span class="muted">Скажите «Тук Тук» — Тук пискнет и выслушает команду. Работает на любом экране, без интернета.</span><div class="row"><button class="pill ghost small" data-act="wake-off">Не слушать</button></div>';
    } else {
      h += '<span class="muted">Тук всегда слушает, но откликается только на «Тук Тук», а потом выполняет команду или отвечает голосом. Распознавание работает прямо на телефоне и без интернета. Один раз нужно скачать языковую модель — около 45 МБ.</span><div class="row"><button class="pill small" data-act="wake-on">' + (st?.model === 'ready' ? 'Включить' : 'Скачать и включить') + '</button></div>';
    }
    h += '<p class="muted small">Пока Тук слушает, вверху горит значок микрофона — так Android показывает, что микрофон включён. Звук никуда не отправляется.</p></div>';
    return h;
  }

  async toggleIsland(on: boolean): Promise<void> {
    const st = this.store.data.settings;
    st.island = on;
    this.store.changed('settings');
    if (!on) {
      if (st.wake) await P.island('config', { show: false, wake: true }).catch(() => {});
      else await P.island('config', { show: false, wake: false }).catch(() => {});
      this.islandOn = false;
      this.say('Убрал Тука с верхней части экрана.', 'idle', 3000);
    } else {
      const c = await P.island('check').catch(() => null);
      if (!c?.granted) {
        this.awaitGrant = true;
        this.say('Разрешите Туку «Поверх других приложений» и вернитесь сюда.', 'think', 8000);
        await P.island('grant').catch(() => {});
      } else {
        await this.startIsland();
        this.say('Я наверху экрана! Нажмите на меня в любом приложении.', 'wave', 4000);
      }
    }
    this.lastHtml = '';
    this.render();
  }

  /** Кадры анимации для острова — рисуются тем же кодом, в текущем наряде. */
  async sendSprites(): Promise<void> {
    const look = { outfit: this.char.outfit, hood: this.char.hood, light: this.char.idleLight };
    const key = JSON.stringify(look) + ISLAND_SPRITE_VERSION;
    if (this.store.data.islandLook === key || this.spritesBusy) return;
    this.spritesBusy = true;
    try {
      for (const [mood, frames, fps] of ISLAND_MOODS) {
        const data = Character.sheet(look, mood, frames, fps, ISLAND_FRAME[0], ISLAND_FRAME[1]);
        await P.island('sprite', { mood, data, frames, fps });
        await new Promise((r) => setTimeout(r, 30));
      }
      this.store.data.islandLook = key;
      this.store.changed('island');
    } finally {
      this.spritesBusy = false;
    }
  }

  islandText(): string {
    const now = Date.now();
    const pend = this.agentPending();
    if (pend.length) return 'Claude ждёт';
    const ring = R.ringing(this.store, now);
    if (ring.length) return ring[0].text;
    if (this.voice === 'listening') return 'Слушаю…';
    if (this.generating) return 'Думаю…';
    const next = R.activeReminders(this.store)
      .filter((i) => (i.dueAt ?? 0) > now)
      .sort((a, b) => a.dueAt! - b.dueAt!)[0];
    if (next && next.dueAt! - now < 60 * 60_000) return `${fmtTime(next.dueAt!)} ${next.text}`;
    return '';
  }

  /** Передать острову настроение и текст (только когда что-то изменилось). */
  pushIsland(): void {
    if (!this.islandOn) return;
    const st = { mood: this.char.mood, text: this.islandText(), badge: R.ringing(this.store).length + this.agentPending().length };
    const key = JSON.stringify(st);
    if (key === this.islandKey) return;
    this.islandKey = key;
    void P.island('update', st).catch(() => {});
  }

  /** Открыли нажатием на остров? Тогда — компактное выпадающее окно. */
  async checkDrop(): Promise<void> {
    if (P.kind !== 'android') return;
    const r = await P.island('consume').catch(() => null);
    if (r?.drop) this.enterDrop();
    if (r?.cmd) {
      // команда после «Тук Тук» — выполнить и ответить голосом
      this.voiceAsked = true;
      $<HTMLInputElement>('#input').value = '';
      await this.handleInput(String(r.cmd));
      setTimeout(() => (this.voiceAsked = false), 1500);
    }
  }

  enterDrop(): void {
    this.drop = true;
    document.documentElement.classList.add('drop');
    if (!['today', 'chat', 'tasks', 'reminders'].includes(this.tab)) this.setTab('today');
    this.activity();
    this.flash('wave', 1200);
    this.sfx('hello');
  }

  exitDrop(back: boolean): void {
    if (!this.drop) return;
    this.drop = false;
    document.documentElement.classList.remove('drop');
    if (back) {
      void P.speakStop();
      void P.island('back');
    }
    this.render();
  }

  // ---------------- Голос ----------------

  setVoice(v: 'off' | 'listening' | 'speaking'): void {
    this.voice = v;
    document.documentElement.classList.toggle('voice-listening', v === 'listening');
    document.documentElement.classList.toggle('voice-speaking', v === 'speaking');
    const mic = document.querySelector<HTMLElement>('#mic');
    if (mic) mic.setAttribute('aria-label', v === 'listening' ? 'Закончить' : v === 'speaking' ? 'Замолчать' : 'Сказать голосом');
    this.pushIsland();
  }

  /** Нажатие на микрофон: слушать → выполнить или ответить → произнести ответ. */
  async voiceTurn(): Promise<void> {
    if (this.voice === 'listening') return void P.listenStop();
    if (this.voice === 'speaking') {
      this.voiceContinue = false;
      await P.speakStop();
      return this.setVoice('off');
    }
    await P.speakStop();
    this.activity();
    this.setVoice('listening');
    this.flash('listen', 60_000);
    this.sfx('wake');
    const input = $<HTMLInputElement>('#input');
    const shown = input.placeholder;
    input.placeholder = 'Говорите…';
    const poll = setInterval(async () => {
      const p = await P.listenPartial().catch(() => null);
      if (p?.text) input.value = p.text;
    }, 250);
    let text = '';
    try {
      text = (await P.hear()).trim();
    } catch (e) {
      clearInterval(poll);
      input.placeholder = shown;
      this.setVoice('off');
      this.tempMood = null;
      const msg = String((e as Error).message ?? e);
      if (!/Отменено/.test(msg)) this.say(msg, 'think', 6000);
      return;
    }
    clearInterval(poll);
    input.placeholder = shown;
    input.value = '';
    this.setVoice('off');
    this.tempMood = null;
    if (!text) return this.say('Не расслышал. Нажмите на микрофон и скажите ещё раз.', 'think', 3500);
    this.voiceAsked = true;
    this.voiceContinue = false;
    await this.handleInput(text);
    // ответ без голоса (например, ничего не сказано) — сбрасываем ожидание
    setTimeout(() => (this.voiceAsked = false), 1500);
  }

  /** Произнести ответ; в разговоре — снова слушать. */
  async speakOut(text: string): Promise<void> {
    const clean = text
      .replace(/[*_`#>]+/g, '')
      .replace(/\p{Extended_Pictographic}/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1200);
    if (!clean) return;
    this.setVoice('speaking');
    try {
      await P.speak(clean, this.voicePreset());
    } catch (e) {
      console.warn('синтез речи:', e);
    }
    if (this.voice !== 'speaking') return; // остановили
    this.setVoice('off');
    if (this.voiceContinue && this.store.data.settings.voiceLoop !== false && (!this.drop || !document.hidden)) {
      this.voiceContinue = false;
      setTimeout(() => void this.voiceTurn(), 250);
    }
  }

  // ---------------- Действия ----------------

  contactsCache: Contact[] | null = null;
  appsCache: { label: string; pkg: string }[] | null = null;
  /** Ждём уточнения: «Кому именно?» */
  pendingPick: { kind: 'call' | 'sms'; options: Contact[]; text?: string } | null = null;

  /** Разрешение на телефоне: спросить и подождать ответа человека (до 25 с). */
  async ensurePerm(which: 'contacts' | 'call', why: string): Promise<boolean> {
    const has = async () => !!(await P.act('perm', { which }).catch(() => null))?.granted;
    if (await has()) return true;
    this.say(why, 'think', 6000);
    await P.act('ask', { which }).catch(() => {});
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await has()) return true;
    }
    return false;
  }

  async contacts(): Promise<Contact[] | null> {
    if (this.contactsCache) return this.contactsCache;
    if (!(await this.ensurePerm('contacts', 'Чтобы звонить и писать людям из ваших контактов, разрешите мне доступ к контактам.'))) {
      this.say('Без доступа к контактам не могу найти человека. Можно назвать номер: «позвони на 8 900 …».', 'think', 6000);
      return null;
    }
    const r = await P.act('contacts');
    this.contactsCache = (r?.list ?? []) as Contact[];
    setTimeout(() => (this.contactsCache = null), 10 * 60_000); // контакты могли измениться
    return this.contactsCache;
  }

  /** Найти одного человека; если подходят несколько — спросить. */
  async pickContact(who: string, kind: 'call' | 'sms', text?: string): Promise<{ c: Contact; phone: string } | null> {
    const book = await this.contacts();
    if (!book) return null;
    const found = matchContacts(who, book);
    if (!found.length) {
      this.say(`Не нашёл «${who}» в контактах.`, 'think', 4000);
      return null;
    }
    const close = found.filter((f) => f.score >= found[0].score - 0.04);
    if (close.length > 1) {
      this.pendingPick = { kind, options: close.slice(0, 4).map((f) => f.contact), text };
      const names = close.slice(0, 4).map((f, i) => `${i + 1}) ${f.contact.name}`).join(', ');
      this.say(`Кому именно? ${names}`, 'think', 15000);
      return null;
    }
    return { c: found[0].contact, phone: found[0].contact.phones[0] };
  }

  /** Ответ на «Кому именно?»: имя, «первому», «второй»… */
  async resolvePick(text: string): Promise<boolean> {
    const p = this.pendingPick;
    if (!p) return false;
    this.pendingPick = null;
    const ord = ['перв', 'втор', 'трет', 'четв'].findIndex((s) => new RegExp(s, 'i').test(text));
    const num = /^\s*(\d)\s*$/.exec(text);
    let c: Contact | undefined;
    if (num) c = p.options[+num[1] - 1];
    else if (ord >= 0) c = p.options[ord];
    else c = matchContacts(text, p.options)[0]?.contact;
    if (!c) return false;
    await this.doContact(p.kind, c, c.phones[0], p.text);
    return true;
  }

  async doContact(kind: 'call' | 'sms', c: Contact, phone: string, text?: string): Promise<void> {
    if (kind === 'call') {
      this.say(`Звоню: ${c.name}.`, 'carry', 2500);
      await new Promise((r) => setTimeout(r, this.voiceAsked ? 1200 : 300));
      const r = await P.act('call', { number: phone });
      if (!r?.direct) {
        this.say('Открыл набор номера — нажмите вызов. Чтобы я звонил сам, разрешите «Телефон».', 'ready', 6000);
        void P.act('ask', { which: 'call' });
      }
    } else {
      await P.act('sms', { number: phone, text: text ?? '' });
      this.say(`Сообщение для ${c.name} готово — проверьте и отправьте.`, 'carry', 4000);
    }
  }

  /** Выполнить команду-действие. */
  async runAction(a: Action): Promise<void> {
    this.activity();
    this.flash('carry', 1500);
    const android = P.kind === 'android';
    const hhmm = (h: number, m: number) => `${h}:${String(m).padStart(2, '0')}`;
    const nextAt = (h: number, m: number) => {
      const d = new Date();
      d.setHours(h, m, 0, 0);
      if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
      return d.getTime();
    };
    try {
      switch (a.kind) {
        case 'time':
          return this.say(`Сейчас ${fmtTime(Date.now())}.`, 'ready', 3500);
        case 'date':
          return this.say(`Сегодня ${new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}.`, 'ready', 3500);
        case 'alarm': {
          const when = hhmm(a.hour, a.minute);
          const days = a.days?.length === 5 ? ' по будням' : a.days?.length === 7 ? ' каждый день' : a.days?.length === 2 ? ' по выходным' : '';
          if (android) {
            await P.act('alarm', { hour: a.hour, minute: a.minute, days: a.days, label: a.label ?? this.store.data.settings.name });
            return this.say(`Будильник на ${when}${days} поставил.`, 'happy', 3500);
          }
          this.store.add({ kind: 'reminder', text: 'Будильник ⏰', dueAt: nextAt(a.hour, a.minute), repeat: a.days?.length === 5 ? 'weekdays' : a.days?.length === 7 ? 'daily' : undefined });
          return this.say(`Разбужу в ${when}${days} — звонком в строке и уведомлением.`, 'happy', 4000);
        }
        case 'timer': {
          const s = a.seconds;
          const txt = s >= 3600 ? `${Math.floor(s / 3600)} ч${s % 3600 ? ` ${Math.round((s % 3600) / 60)} мин` : ''}` : s >= 60 ? `${Math.round(s / 60)} мин` : `${s} с`;
          if (android) await P.act('timer', { seconds: s, label: this.store.data.settings.name });
          else this.store.add({ kind: 'reminder', text: `Таймер ${txt} ⏱`, dueAt: Date.now() + s * 1000 });
          return this.say(`Таймер на ${txt} пошёл.`, 'happy', 3000);
        }
        case 'call':
        case 'sms': {
          if (!android) return this.say('Звонить и писать сообщения я умею на телефоне — скажите это там.', 'think', 4500);
          if (a.number) {
            if (a.kind === 'call') {
              this.say(`Звоню на ${a.number}.`, 'carry', 2500);
              const r = await P.act('call', { number: a.number });
              if (!r?.direct) this.say('Открыл набор номера — нажмите вызов.', 'ready', 4000);
            } else await P.act('sms', { number: a.number, text: a.text });
            return;
          }
          const hit = await this.pickContact(a.who ?? '', a.kind, a.kind === 'sms' ? a.text : undefined);
          if (hit) await this.doContact(a.kind, hit.c, hit.phone, a.kind === 'sms' ? a.text : undefined);
          return;
        }
        case 'open': {
          if (!android) {
            const t = pcTarget(a.app);
            if (!t) return this.say(`Не знаю, как открыть «${a.app}» на этом компьютере.`, 'think', 4000);
            await P.openTarget(t);
            return this.say(`Открываю: ${a.app}.`, 'carry', 2500);
          }
          this.appsCache ??= ((await P.act('apps'))?.list ?? []) as { label: string; pkg: string }[];
          const app = matchApp(a.app, this.appsCache);
          if (!app) {
            const site = pcTarget(a.app);
            if (site?.startsWith('http')) {
              await P.act('url', { url: site });
              return this.say(`Открываю ${a.app}.`, 'carry', 2500);
            }
            return this.say(`Не нашёл приложение «${a.app}».`, 'think', 4000);
          }
          await P.act('open', { pkg: app.pkg });
          return this.say(`Открываю ${app.label}.`, 'carry', 2500);
        }
        case 'torch':
          if (!android) return this.say('Фонарик есть только на телефоне 🙂', 'happy', 3000);
          await P.act('torch', { on: a.on });
          return this.say(a.on ? 'Фонарик включил.' : 'Фонарик выключил.', 'ready', 2500);
        case 'volume': {
          if (!android) return this.say('Громкость на ПК пока регулируйте клавишами — скоро научусь.', 'think', 4000);
          const r = await P.act('volume', { dir: a.dir });
          return this.say(a.dir === 'mute' ? 'Звук выключил.' : `Громкость ${r?.level ?? ''}%.`, 'ready', 2500);
        }
        case 'media':
          if (android) await P.act('media', { key: a.key });
          else await P.mediaControl(a.key === 'next' ? 'next' : a.key === 'prev' ? 'prev' : 'toggle');
          return this.say(a.key === 'next' ? 'Следующий трек.' : a.key === 'prev' ? 'Предыдущий трек.' : a.key === 'pause' ? 'Пауза.' : 'Играю.', 'dance', 2000);
        case 'navigate':
          if (android) await P.act('navigate', { place: a.place });
          else await P.openTarget('https://yandex.ru/maps/?text=' + encodeURIComponent(a.place));
          return this.say(`Строю маршрут: ${a.place}.`, 'search', 3000);
        case 'search':
          if (android) await P.act('search', { query: a.query });
          else await P.openTarget('https://yandex.ru/search/?text=' + encodeURIComponent(a.query));
          return this.say(`Ищу: ${a.query}.`, 'search', 3000);
        case 'battery': {
          if (!android) {
            const b = await (navigator as any).getBattery?.().catch(() => null);
            if (!b) return this.say('На этом компьютере не вижу батарею.', 'think', 3000);
            return this.say(`Заряд ${Math.round(b.level * 100)}%${b.charging ? ', заряжается' : ''}.`, 'ready', 3500);
          }
          const r = await P.act('battery');
          return this.say(`Заряд ${r.level}%${r.charging ? ', заряжается' : ''}.`, r.level < 20 ? 'alert' : 'ready', 3500);
        }
        case 'calendar':
          if (android) {
            await P.act('calendar', { title: a.title, begin: a.at, end: a.at + 3_600_000 });
            return this.say(`Открыл календарь: «${a.title}», ${fmtWhen(a.at)}. Проверьте и сохраните.`, 'write', 4500);
          }
          this.store.add({ kind: 'reminder', text: a.title, dueAt: a.at });
          return this.say(`Записал: «${a.title}», ${fmtWhen(a.at)}.`, 'write', 3500);
        case 'camera':
          if (!android) return void (await P.openTarget('microsoft.windows.camera:'));
          await P.act('camera');
          return this.say('Открываю камеру.', 'carry', 2000);
        case 'settings':
          if (!android) return void (await P.openTarget('ms-settings:'));
          await P.act('settings', { which: a.which });
          return this.say('Открыл настройки.', 'carry', 2000);
        case 'stop': {
          this.voiceContinue = false;
          await P.speakStop();
          this.setVoice('off');
          if (android) await P.act('media', { key: 'pause' }).catch(() => {});
          else await P.mediaControl('toggle').catch(() => {});
          return this.say('Остановил.', 'idle', 1800);
        }
        case 'alarmCtrl': {
          if (!android) return this.say('Будильниками я управляю на телефоне.', 'think', 3500);
          await P.act('alarmControl', { op: a.op });
          const txt = a.op === 'dismiss' ? 'Выключаю будильник.' : a.op === 'snooze' ? 'Отложил будильник.' : a.op === 'showTimers' ? 'Открыл таймеры — остановите нужный.' : 'Вот ваши будильники.';
          return this.say(txt, 'carry', 3500);
        }
        case 'dnd': {
          if (!android) return this.say('«Не беспокоить» — это на телефоне.', 'think', 3000);
          const r = await P.act('dnd', { on: a.on });
          if (r?.needPerm) return this.say('Разрешите Туку управлять режимом «Не беспокоить» — я открыл нужный экран. Потом повторите команду.', 'ready', 7000);
          return this.say(a.on ? 'Включил «Не беспокоить».' : 'Выключил «Не беспокоить».', 'ready', 2500);
        }
        case 'ringer': {
          if (!android) return this.say('Режим звонка меняется на телефоне.', 'think', 3000);
          const r = await P.act('ringer', { mode: a.mode });
          if (r?.needPerm) return this.say('Для беззвучного режима разрешите доступ к «Не беспокоить» — я открыл экран. Потом повторите.', 'ready', 7000);
          return this.say(a.mode === 'silent' ? 'Беззвучный режим.' : a.mode === 'vibrate' ? 'Режим вибрации.' : 'Звук звонка включён.', 'ready', 2500);
        }
        case 'brightness': {
          if (!android) return this.say('Яркость экрана — это на телефоне.', 'think', 3000);
          const r = await P.act('brightness', { dir: a.dir });
          if (r?.needPerm) return this.say('Разрешите Туку менять системные настройки — я открыл нужный экран. Потом повторите команду.', 'ready', 7000);
          return this.say(a.dir === 'auto' ? 'Яркость — автоматическая.' : `Яркость ${r?.level ?? ''}%.`, 'ready', 2500);
        }
        case 'rotate': {
          if (!android) return this.say('Поворот экрана — это на телефоне.', 'think', 3000);
          const r = await P.act('rotate', { lock: a.lock });
          if (r?.needPerm) return this.say('Разрешите Туку менять системные настройки — я открыл экран. Потом повторите.', 'ready', 7000);
          return this.say(a.lock ? 'Автоповорот выключен.' : 'Автоповорот включён.', 'ready', 2500);
        }
      }
    } catch (e) {
      this.sfx('error');
      this.say('Не получилось: ' + String((e as Error).message ?? e), 'think', 5000);
    }
  }

  /** Мозг переводит свободную фразу в понятную Туку команду (или 'НЕТ'). */
  async brainToCommand(text: string): Promise<string | null> {
    const sys =
      'Ты — помощник, который превращает фразу человека в одну короткую команду из списка. ' +
      'Отвечай ТОЛЬКО командой с подставленными словами, без пояснений. Если фраза не подходит ни к одной — ответь «НЕТ».\n' +
      'Команды-образцы:\n' +
      'поставь будильник на 7:00 | отложи будильник | выключи будильник | поставь таймер на 5 минут | останови таймер | ' +
      'позвони <имя> | напиши <имя> что <текст> | открой <приложение> | включи фонарик | выключи фонарик | ' +
      'сделай громче | сделай тише | выключи звук | следующий трек | поставь на паузу | ' +
      'яркость на максимум | убавь яркость | включи не беспокоить | выключи не беспокоить | поставь на вибрацию | ' +
      'включи автоповорот | выключи автоповорот | проложи маршрут до <место> | найди в интернете <запрос> | ' +
      'сколько заряда | который час | открой камеру';
    const msgs: ChatMsg[] = [
      { role: 'system', content: sys },
      { role: 'user', content: `Фраза: «${text}»\nКоманда:` },
    ];
    let out = '';
    await this.brain.chat(msgs, (full) => (out = full)).catch(() => {});
    out = out.split('\n')[0].replace(/^(команда|ответ)\s*[:：]\s*/i, '').replace(/[«»"']/g, '').trim();
    if (!out || /^нет\b/i.test(out) || out.length > 80) return null;
    return out;
  }

  sysAccess: { dnd?: boolean; write?: boolean } | null = null;

  async refreshAccess(): Promise<void> {
    if (P.kind !== 'android') return;
    this.sysAccess = await P.act('canSystem').catch(() => null);
  }

  commandHtml(): string {
    if (P.kind !== 'android') return '';
    const a = this.sysAccess;
    const ok = (v?: boolean) => (v ? '✓ есть' : '— нет');
    return `<h3>Управление телефоном</h3><div class="card">
      <span class="muted">Тук выполняет команды голосом: будильник и таймер (поставить, отложить, выключить), звонок и сообщение, открыть приложение, фонарик, громкость и музыку, «Не беспокоить», режим звонка, яркость, автоповорот, маршрут, поиск. Скажите «стоп», чтобы он замолчал.</span>
      <div class="access"><span>«Не беспокоить» и беззвучный режим: <b>${ok(a?.dnd)}</b></span><span>Яркость и автоповорот: <b>${ok(a?.write)}</b></span></div>
      <div class="row"><button class="pill ghost small" data-act="grant-dnd">Разрешить «Не беспокоить»</button><button class="pill ghost small" data-act="grant-write">Разрешить настройки</button></div>
      <p class="muted small">Эти два доступа Android выдаёт вручную. Без них всё остальное работает, а эти команды Тук попросит включить в нужный момент.</p></div>`;
  }

  // ---------------- Живой голос ----------------

  voiceState: { state: string; progress?: number; error?: string } | null = null;
  voiceTimer: ReturnType<typeof setInterval> | null = null;

  /** Какой голос использовать: '' — системный. */
  voicePreset(): string {
    const v = this.store.data.settings.voicePreset;
    return v === undefined ? 'tuk' : v;
  }

  async refreshVoice(): Promise<void> {
    if (P.kind !== 'android') return;
    this.voiceState = await P.voice('status', this.voicePreset() || 'tuk').catch(() => null);
  }

  async chooseVoice(preset: string): Promise<void> {
    this.store.data.settings.voicePreset = preset;
    this.store.changed('settings');
    await this.refreshVoice();
    if (preset && this.voiceState?.state !== 'ready') {
      await P.voice('download', preset);
      this.say('Скачиваю голос (около 67 МБ) — один раз, дальше он работает без интернета.', 'carry', 5000);
      this.watchVoice();
    } else if (preset) void this.speakOut(VOICE_SAMPLE);
    else void this.speakOut('Теперь говорю системным голосом.');
    this.lastHtml = '';
    this.render();
  }

  watchVoice(): void {
    if (this.voiceTimer) return;
    this.voiceTimer = setInterval(async () => {
      await this.refreshVoice();
      if (this.tab === 'settings') {
        this.lastHtml = '';
        this.render();
      }
      const st = this.voiceState?.state;
      if (st === 'ready' || st === 'error' || st === 'none') {
        clearInterval(this.voiceTimer!);
        this.voiceTimer = null;
        if (st === 'ready') void this.speakOut(VOICE_SAMPLE);
        else if (st === 'error') this.say('Не получилось скачать голос: ' + (this.voiceState?.error ?? 'нет интернета?'), 'think', 6000);
      }
    }, 1000);
  }

  voiceHtml(): string {
    if (P.kind !== 'android') return '';
    const cur = this.voicePreset();
    const st = this.voiceState;
    const opts: [string, string, string][] = [
      ['tuk', 'Тук', 'живой, чуть мальчишеский — по умолчанию'],
      ['bright', 'Звонкий', 'светлый и мягкий'],
      ['boy', 'Мальчишка', 'бодрый, озорной'],
      ['calm', 'Спокойный', 'взрослый, без изменений'],
      ['', 'Системный', 'голос телефона, без скачивания'],
    ];
    let h = '<h3>Голос Тука</h3><div class="voices">';
    for (const [id, name, about] of opts)
      h += `<button class="voice-opt ${cur === id ? 'on' : ''}" data-act="set-voice" data-id="${id}"><b>${name}</b><span>${about}</span></button>`;
    h += '</div>';
    if (st?.state === 'downloading') h += `<div class="progress"><i style="width:${st.progress ?? 0}%"></i></div><p class="muted small">Скачиваю голос… ${st.progress ?? 0}%</p>`;
    else if (cur && st?.state !== 'ready') h += `<p class="muted small">Голос ещё не скачан — нажмите на него, чтобы скачать (около 67 МБ, один раз).</p>`;
    h += `<div class="row"><button class="pill ghost small" data-act="voice-test">Послушать</button></div>`;
    h += '<p class="muted small">Нейросетевой голос работает прямо на телефоне, без интернета.</p>';
    return h;
  }

  // ---------------- События ----------------

  bind(): void {
    const form = $<HTMLFormElement>('#input-form');
    const input = $<HTMLInputElement>('#input');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value;
      input.value = '';
      void this.handleInput(v);
    });
    input.addEventListener('input', () => {
      this.activity();
      if (input.value && !this.tempMood) this.char.set('listen');
    });

    for (const ev of ['pointermove', 'pointerdown', 'keydown'] as const) document.addEventListener(ev, () => this.activity(), { passive: true });
    document.addEventListener('pointermove', (e) => this.char.lookAtScreen(e.clientX, e.clientY), { passive: true });

    const mic = document.querySelector<HTMLElement>('#mic');
    if (mic) {
      mic.hidden = !P.canListen();
      mic.addEventListener('click', () => void this.voiceTurn());
    }

    $('#char').addEventListener('click', (e) => {
      if (P.kind === 'desktop' && this.mode === 'collapsed') return; // клик раскроет строку
      e.stopPropagation();
      this.activity();
      this.poke();
    });

    // файлы: кнопка-скрепка и перетаскивание
    const fileInput = $<HTMLInputElement>('#file-input');
    $('#attach').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const list = [...(fileInput.files ?? [])];
      if (list.length) void this.takeFiles(list);
      fileInput.value = '';
    });
    document.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (this.tempMood !== 'listen') this.flash('listen', 1500);
      if (P.kind === 'desktop' && this.mode === 'collapsed') this.applyMode('compact');
    });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      const list = [...(e.dataTransfer?.files ?? [])];
      if (list.length) void this.takeFiles(list);
    });

    $('#bar').addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-act]')) return;
      this.activity();
      if (P.kind !== 'desktop') {
        this.flash('happy', 1200);
        return;
      }
      this.island.click();
    });

    if (P.kind === 'desktop') this.bindIsland();

    document.addEventListener('keydown', (e) => this.onKey(e));

    $('#tabs').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-tab]') as HTMLElement | null;
      if (b) this.setTab(b.dataset.tab as Tab);
    });

    document.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      if (b) void this.act(b.dataset.act!, b.dataset.id ?? '', b);
    });
    document.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      const st = this.store.data.settings;
      if (t.id === 'set-sound') st.sound = t.checked;
      else if (t.id === 'set-autostart') {
        st.autostart = t.checked;
        void P.setAutostart(t.checked);
      } else if (t.id === 'set-screen') {
        st.islandScreen = t.value === 'cursor' ? 'cursor' : 'primary';
        void P.islandScreen(st.islandScreen);
      } else if (t.id === 'set-name') st.name = t.value.trim() || 'Тук';
      else if (t.id === 'set-usepc') st.usePcBrain = t.checked;
      else if (t.id === 'set-dance') st.dance = t.checked;
      else if (t.id === 'set-voiceloop') st.voiceLoop = t.checked;
      else if (t.id === 'set-agentclean') st.agentAutoClean = t.checked;
      else if (t.id === 'set-local-on' || t.id === 'set-local-url' || t.id === 'set-local-model') {
        const l = (st.localAi ??= { on: false, url: LOCAL_PRESETS[0].url, model: '' });
        if (t.id === 'set-local-on') l.on = t.checked;
        else if (t.id === 'set-local-url') l.url = t.value.trim();
        else l.model = t.value.trim();
        if (l.on && !isLocalUrl(l.url)) {
          l.on = false;
          this.say('Нужен локальный адрес: localhost или компьютер в вашей сети. Облачные сервисы Тук не использует.', 'think', 6000);
        }
        this.lastHtml = '';
      }
      else if (t.id === 'set-volume') {
        st.volume = +t.value / 100;
        this.applyLook();
        this.sfx('message');
      }
      else if (t.id === 'set-device') this.store.data.deviceName = t.value.trim() || this.store.data.deviceName;
      else return;
      this.store.changed('settings');
    });
  }

  async act(act: string, id: string, el: HTMLElement): Promise<void> {
    const s = this.store;
    this.activity();
    switch (act) {
      case 'done': {
        const it = s.get(id);
        if (!it) return;
        if (it.done) s.update(id, { done: false, doneAt: null });
        else {
          const res = R.complete(s, id);
          if (it.tag === 'здоровье') s.add({ kind: 'health', text: it.text, health: { metric: 'meds', value: 1, unit: '' } });
          this.flash('happy', 1500);
          this.sfx('done');
          if (res && !res.done && res.dueAt) this.say(`Следующий раз — ${fmtWhen(res.dueAt)}`, null, 2500);
        }
        break;
      }
      case 'del':
        s.remove(id);
        this.flash('write', 700);
        break;
      case 'snooze':
        R.snooze(s, id, +(el.dataset.min ?? 10));
        this.say(`Отложил на ${el.dataset.min ?? 10} мин.`, 'idle', 2000);
        break;
      case 'water':
        s.add({ kind: 'health', text: 'Стакан воды', health: { metric: 'water', value: 250, unit: 'мл' } });
        this.say(`Сегодня воды: ${this.todaySum('water')} мл.`, 'happy', 2000);
        break;
      case 'meds':
        s.add({ kind: 'health', text: 'Лекарства приняты', health: { metric: 'meds', value: 1, unit: '' } });
        this.say('Отметил приём лекарств.', 'happy', 2000);
        break;
      case 'mood': {
        const v = +(el.dataset.v ?? 3);
        s.add({ kind: 'health', text: 'Самочувствие', health: { metric: 'mood', value: v, unit: '' } });
        this.say(v >= 4 ? 'Рад, что всё хорошо!' : v === 3 ? 'Записал.' : 'Записал. Берегите себя.', v >= 4 ? 'happy' : 'listen', 2200);
        break;
      }
      case 'preview':
        this.flash(el.dataset.mood as Mood, 4000);
        break;
      case 'pin': {
        const code = this.link.startPin();
        this.renderPin(code);
        break;
      }
      case 'reset-key':
        if (confirm('Отвязать все телефоны? Их придётся связать заново.')) {
          this.link.resetKey();
          this.render();
        }
        break;
      case 'scan':
        try {
          const code = await P.scanQr();
          if (code) {
            await this.link.pairByCode(code);
            this.say(`Связал с ${this.store.data.sync.pcName ?? 'ПК'}!`, 'happy', 3000);
            this.sfx('link');
          }
        } catch (e) {
          this.say(String((e as Error).message ?? e), 'angry', 4000);
        }
        this.render();
        break;
      case 'discover':
        el.textContent = 'Ищу…';
        this.found = await P.discover(3000);
        if (!this.found.length) this.say('ПК не найден. Проверьте, что Тук запущен на ПК и оба устройства в одной сети Wi-Fi.', 'think', 5000);
        this.render();
        break;
      case 'pick': {
        const f = this.found.find((x) => x.id === id);
        if (f) $<HTMLInputElement>('#pair-ip').value = f.ip;
        $<HTMLInputElement>('#pair-pin').focus();
        break;
      }
      case 'pair-pin': {
        const ip = $<HTMLInputElement>('#pair-ip').value.trim();
        const pin = $<HTMLInputElement>('#pair-pin').value.replace(/\D/g, '');
        if (!ip || pin.length !== 6) return this.say('Нужны адрес ПК и код из 6 цифр.', 'think', 3000);
        this.flash('think', 3000);
        try {
          await this.link.pairByPin(ip, 47800, pin);
          this.say(`Связал с ${this.store.data.sync.pcName ?? 'ПК'}!`, 'happy', 3000);
            this.sfx('link');
        } catch (e) {
          this.say(String((e as Error).message ?? e), 'angry', 4000);
        }
        this.render();
        break;
      }
      case 'sync':
        this.flash('carry', 1800);
        await this.link.syncNow();
        break;
      case 'unlink':
        if (confirm('Отвязать телефон от ПК? Записи на телефоне останутся.')) this.link.unlink();
        this.render();
        break;
      case 'quit':
        await this.store.flush();
        await P.quit();
        break;
      case 'tab':
        this.setTab(id as Tab);
        break;
      case 'brain-download':
        void this.brain.start();
        break;
      case 'brain-forget':
        if (confirm('Удалить мозг с устройства? Чтобы снова разговаривать, его придётся скачать заново.')) await this.brain.forget();
        break;
      case 'set-model':
        if (this.store.data.settings.model !== id) {
          this.store.data.settings.model = id as ModelId;
          this.store.changed('settings');
          await this.brain.switchModel(id as ModelId);
        }
        break;
      case 'agent-allow':
      case 'agent-deny':
      case 'agent-always':
        await this.decideAgent(+id, act === 'agent-allow' ? 'allow' : act === 'agent-deny' ? 'deny' : 'always');
        break;
      case 'agent-pick':
        await this.pickOption(+id, +(el.dataset.q ?? 0), el.dataset.label ?? '');
        break;
      case 'agent-answer':
        await this.answerAgent(+id);
        break;
      case 'agent-close':
        await this.closeSession(id);
        break;
      case 'agents-clear':
        if (this.agentsLocal) this.agentHub.clearFinished();
        else if (this.remote) for (const x of this.remote.sessions.filter((x) => ['done', 'ended', 'stale', 'error'].includes(x.status))) await this.closeSession(x.id);
        this.renderAgents();
        break;
      case 'demo-start':
        this.startDemo();
        break;
      case 'demo-stop':
        this.stopDemo();
        break;
      case 'set-sec':
        this.setSec = id as SetSec;
        this.lastHtml = '';
        this.render();
        $('#view').scrollTop = 0;
        break;
      case 'onboard-next':
        this.onboardStep++;
        this.renderOnboarding();
        break;
      case 'onboard-back':
        this.onboardStep = Math.max(0, this.onboardStep - 1);
        this.renderOnboarding();
        break;
      case 'onboard-skip':
      case 'onboard-done':
        this.finishOnboarding();
        break;
      case 'onboard-open':
        this.onboardStep = 0;
        this.renderOnboarding();
        break;
      case 'local-preset':
        (this.store.data.settings.localAi ??= { on: false, url: '', model: '' }).url = id;
        this.store.changed('settings');
        this.lastHtml = '';
        this.render();
        break;
      case 'local-check':
        await this.checkLocal();
        break;
      case 'local-model': {
        const l = (this.store.data.settings.localAi ??= { on: true, url: LOCAL_PRESETS[0].url, model: '' });
        l.model = id;
        l.on = true;
        this.store.changed('settings');
        this.say(`Буду думать моделью ${id}.`, 'happy', 3000);
        this.lastHtml = '';
        this.render();
        break;
      }
      case 'shortcuts':
        this.showShortcuts();
        break;
      case 'rule-del':
        (this.store.data.agentRules ?? []).splice(+id, 1);
        this.store.changed('rules');
        this.lastHtml = '';
        this.render();
        break;
      case 'media-toggle':
      case 'media-next':
      case 'media-prev':
        await P.mediaControl(act === 'media-toggle' ? 'toggle' : act === 'media-next' ? 'next' : 'prev').catch(() => {});
        setTimeout(() => void this.pollMedia(), 400);
        break;
      case 'island-on':
        return this.toggleIsland(true);
      case 'island-off':
        return this.toggleIsland(false);
      case 'set-voice':
        return this.chooseVoice(id);
      case 'grant-dnd':
        await P.act('dnd', { on: true }).catch(() => {});
        return this.say('Открыл настройки «Не беспокоить» — включите доступ для Тука.', 'ready', 6000);
      case 'grant-write':
        await P.act('brightness', { dir: 'up' }).catch(() => {});
        return this.say('Открыл системные настройки — разрешите Туку их менять.', 'ready', 6000);
      case 'voice-test':
        return void this.speakOut(VOICE_SAMPLE);
      case 'wake-on':
        return this.toggleWake(true);
      case 'wake-off':
        return this.toggleWake(false);
      case 'drop-close':
        return this.exitDrop(true);
      case 'drop-full':
        return this.exitDrop(false);
      case 'pet-on':
        await this.togglePet(true);
        break;
      case 'pet-off':
        await this.togglePet(false);
        break;
      case 'claude-on':
        await this.setClaudeHooks(true);
        break;
      case 'claude-off':
        await this.setClaudeHooks(false);
        break;
      case 'file-drop':
        this.dropFile(id);
        break;
      case 'file-ask':
      case 'file-note':
      case 'file-tasks':
      case 'file-open':
      case 'file-folder':
        await this.fileAction(act, id);
        break;
      case 'set-outfit':
        this.store.data.settings.outfit = id as Outfit | 'auto';
        this.applyLook();
        this.flash('happy', 1200);
        this.store.changed('settings');
        break;
      case 'set-hood':
        this.store.data.settings.hoodColor = id;
        this.applyLook();
        this.lastHtml = '';
        this.store.changed('settings');
        break;
      case 'set-light':
        this.store.data.settings.lightColor = id || undefined;
        this.applyLook();
        this.lastHtml = '';
        this.store.changed('settings');
        break;
      case 'recap':
        this.showRecap();
        break;
      case 'recap-save': {
        const png = ($('#overlay') as HTMLElement & { _png?: string })._png;
        const note = document.querySelector('#recap-note');
        try {
          const path = await P.saveImage(`Тук-неделя-${new Date().toISOString().slice(0, 10)}.png`, png!.split(',')[1]);
          if (note) note.textContent = `Сохранено: ${path}`;
          this.sfx('done');
        } catch (e) {
          if (note) note.textContent = 'Не удалось сохранить: ' + String((e as Error).message ?? e);
        }
        break;
      }
      case 'overlay-close':
        $('#overlay').hidden = true;
        break;
      case 'chat-stop':
        this.chatAbort?.abort();
        break;
      case 'chat-clear':
        this.store.data.chat = [];
        this.store.changed('chat');
        this.say('Начнём сначала. О чём поговорим?', 'happy', 2500);
        break;
    }
  }

  setTab(t: Tab): void {
    this.tab = t;
    if (this.pinTimer && t !== 'settings') {
      clearInterval(this.pinTimer);
      this.pinTimer = null;
    }
    this.render();
  }

  // ---------------- Отрисовка ----------------

  render(): void {
    this.renderBar();
    this.renderReply();
    this.renderStatus();
    for (const b of document.querySelectorAll<HTMLElement>('#tabs [data-tab]')) b.classList.toggle('on', b.dataset.tab === this.tab);
    const v = $('#view');
    const html = this.viewHtml();
    if (v.dataset.tab !== this.tab || this.lastHtml !== html) {
      const keepScroll = v.dataset.tab === this.tab ? v.scrollTop : 0;
      v.innerHTML = html;
      this.lastHtml = html;
      v.dataset.tab = this.tab;
      v.scrollTop = keepScroll;
      if (this.tab === 'settings' && this.link.pin) this.renderPin(this.link.pin.code);
    }
    if (this.tab === 'settings' && P.kind !== 'android') void this.fillQr();
    if (this.tab === 'settings') this.drawWardrobe();
  }

  async fillQr(): Promise<void> {
    const box = document.querySelector('#qr');
    if (!box || box.childElementCount) return;
    if (!this.store.data.sync.key) this.store.data.sync.key = randomKey(); // демо: ключ только для показа
    const [code, ip] = await Promise.all([this.link.pairCode(), P.localIp()]);
    box.innerHTML = qrSvg(code, 200);
    const el = document.querySelector('#qr-ip');
    if (el) el.textContent = `Адрес ПК: ${ip}, порт 47800`;
  }

  renderPin(code: string): void {
    const el = document.querySelector('#pin-box');
    if (!el) return;
    if (this.pinTimer) clearInterval(this.pinTimer);
    const upd = () => {
      const left = Math.max(0, Math.round(((this.link.pin?.until ?? 0) - Date.now()) / 1000));
      if (!this.link.pin || left <= 0) {
        el.innerHTML = '<span class="muted">Код использован или истёк</span>';
        clearInterval(this.pinTimer!);
        return;
      }
      el.innerHTML = `<div class="pin">${code.slice(0, 3)} ${code.slice(3)}</div><div class="muted">Действует ещё ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</div>`;
    };
    upd();
    this.pinTimer = setInterval(upd, 1000);
  }

  renderReply(): void {
    const r = $('#reply');
    r.textContent = this.reply;
    // в чате ответ и так виден в переписке
    r.classList.toggle('show', !!this.reply && this.tab !== 'chat');
  }

  renderStatus(): void {
    const el = $('#link-status');
    const st = this.link.status;
    el.className = 'link-status ' + st.state;
    el.textContent = P.kind === 'web' ? 'Демо в браузере' : st.text;
  }

  renderBar(): void {
    const now = Date.now();
    const ring = R.ringing(this.store, now);
    const text = $('#bar-text');
    const act = $('#bar-actions');
    const badge = $('#bar-badge');
    let line = '';
    let actions = '';
    const pend = this.agentPending();
    if (pend.length) {
      const p = pend[0];
      const more = pend.length > 1 ? ` <span class="muted">+${pend.length - 1}</span>` : '';
      const dot = `<i class="dotc" style="background:${esc(p.color ?? '#f4c470')}"></i>`;
      if (p.questions) {
        line = `${dot}<b>${esc(p.project)}:</b> ${esc(p.questions[0].question)}${more}`;
        actions = `<button class="mini ok" data-act="tab" data-id="agents" title="Выбрать ответ">Ответить</button>`;
      } else {
        line = `${dot}<b>${esc(p.project)} · ${esc(p.tool)}</b> ${esc(p.summary)}${more}`;
        actions = `<button class="mini ok" data-act="agent-allow" data-id="${p.reqId}" title="Разрешить">✓</button><button class="mini" data-act="agent-deny" data-id="${p.reqId}" title="Запретить">✕</button>`;
      }
    } else if (ring.length) {
      const it = ring[0];
      line = `<b>${esc(it.text)}</b>`;
      actions = `<button class="mini ok" data-act="done" data-id="${it.id}" title="Готово">✓</button><button class="mini" data-act="snooze" data-id="${it.id}" data-min="10" title="Отложить на 10 минут">+10</button>`;
    } else if (this.reply && this.mode !== 'expanded') {
      line = esc(this.reply);
    } else if (this.media?.playing) {
      line = `<span class="muted">♪</span> ${esc(this.media.title)}${this.media.artist ? ` <span class="muted">— ${esc(this.media.artist)}</span>` : ''}`;
      actions = `<button class="mini" data-act="media-toggle" title="Пауза">⏸</button><button class="mini" data-act="media-next" title="Дальше">⏭</button>`;
    } else {
      const next = R.activeReminders(this.store)
        .filter((i) => (i.dueAt ?? 0) > now)
        .sort((a, b) => a.dueAt! - b.dueAt!)[0];
      if (next) line = `<span class="muted">${next.dueAt! - startOfDay() < DAY ? fmtTime(next.dueAt!) : fmtDay(next.dueAt!)}</span> ${esc(next.text)}`;
      else line = `<span class="muted">${esc(this.store.data.settings.name)} · ${MOOD_LABEL[this.char.mood].toLowerCase()}</span>`;
    }
    if (this.mode === 'collapsed' && P.kind === 'desktop') {
      const next = R.activeReminders(this.store).filter((i) => (i.dueAt ?? 0) > now).sort((a, b) => a.dueAt! - b.dueAt!)[0];
      line = ring.length || pend.length ? '<b>!</b>' : this.media?.playing ? '<span class="muted">♪</span>' : next && next.dueAt! - now < 12 * 3_600_000 ? `<span class="muted">${fmtTime(next.dueAt!)}</span>` : '';
      actions = '';
    }
    text.innerHTML = line;
    act.innerHTML = actions;
    const n = ring.length + pend.length;
    badge.textContent = n ? String(n) : '';
    badge.classList.toggle('show', n > 0);
  }

  viewHtml(): string {
    switch (this.tab) {
      case 'today':
        return this.todayHtml();
      case 'chat':
        return this.chatHtml();
      case 'agents':
        return this.agentsHtml();
      case 'tasks':
        return this.tasksHtml();
      case 'reminders':
        return this.remindersHtml();
      case 'health':
        return this.healthHtml();
      case 'notes':
        return this.notesHtml();
      case 'settings':
        return this.settingsHtml();
    }
  }

  row(it: StoredItem, opts: { when?: boolean; check?: boolean } = {}): string {
    const now = Date.now();
    const due = R.effectiveDue(this.store, it) ?? it.dueAt;
    const overdue = !it.done && it.kind === 'reminder' && due != null && due <= now;
    const meta: string[] = [];
    if (opts.when !== false && it.dueAt != null) meta.push(it.allDay ? fmtDay(it.dueAt) : fmtWhen(due ?? it.dueAt));
    if (it.repeat) meta.push(REPEAT_LABEL[it.repeat]);
    if (it.tag) meta.push(it.tag);
    const check = opts.check !== false && (it.kind === 'task' || it.kind === 'reminder');
    return `<li class="item ${it.done ? 'done' : ''} ${overdue ? 'overdue' : ''} k-${it.kind}">
      ${check ? `<button class="check" data-act="done" data-id="${it.id}" aria-label="Готово">${it.done ? '✓' : ''}</button>` : `<span class="dot"></span>`}
      <div class="body"><div class="t">${esc(it.text)}</div>${meta.length ? `<div class="m">${esc(meta.join(' · '))}</div>` : ''}</div>
      ${overdue ? `<button class="mini" data-act="snooze" data-id="${it.id}" data-min="10">+10</button>` : ''}
      <button class="x" data-act="del" data-id="${it.id}" aria-label="Удалить">×</button>
    </li>`;
  }

  section(title: string, items: StoredItem[], empty = '', cls = ''): string {
    if (!items.length && !empty) return '';
    return `<h3 class="${cls}">${title}</h3>${items.length ? `<ul>${items.map((i) => this.row(i)).join('')}</ul>` : `<p class="muted">${empty}</p>`}`;
  }

  todayHtml(): string {
    const now = Date.now();
    const end = startOfDay() + DAY;
    const s = this.store;
    const ring = R.ringing(s, now);
    const todayRem = R.activeReminders(s).filter((i) => !ring.includes(i) && (R.effectiveDue(s, i) ?? 0) < end).sort((a, b) => a.dueAt! - b.dueAt!);
    const tasksToday = s.items.filter((i) => i.kind === 'task' && !i.done && i.dueAt != null && i.dueAt < end);
    const noDue = s.items.filter((i) => i.kind === 'task' && !i.done && i.dueAt == null).sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);
    const doneToday = s.items.filter((i) => i.done && (i.doneAt ?? 0) >= startOfDay()).length;
    let h = this.musicHtml() + `<div class="hello"><div class="big">${fmtDay(now).replace(/^./, (c) => c.toUpperCase())}, ${new Date(now).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</div><div class="muted">${this.summary()}${doneToday ? ` Сделано сегодня: ${doneToday}.` : ''}</div></div>`;
    h += this.section('Просрочено', ring, '', 'warn');
    h += this.section('Сегодня', [...todayRem, ...tasksToday], 'На сегодня ничего не запланировано');
    h += this.section('Без срока', noDue);
    if (new Date(now).getDay() === 1 && this.store.data.recapSeen !== weekKey()) h += `<div class="card recap-banner"><b>Сводка за неделю готова</b><span class="muted">Что сделано, здоровье, серия дней</span><button class="pill small" data-act="recap">Посмотреть</button></div>`;
    h += this.healthChips();
    if (!s.items.length) h += this.examplesHtml();
    return h;
  }

  examplesHtml(): string {
    const ex = ['напомни через 10 минут выключить чайник', 'напомни завтра в 9 позвонить поставщику', 'каждый день в 21 выпить таблетки', 'запиши купить кабель ВВГ 3×2,5', 'давление 125 на 80 пульс 70', 'выпил стакан воды', 'заметка: щит 600×800'];
    return `<h3>Попробуйте написать</h3><div class="examples">${ex.map((e) => `<button class="ex" data-act="example" data-id="${esc(e)}">${esc(e)}</button>`).join('')}</div>`;
  }

  tasksHtml(): string {
    const s = this.store;
    const open = s.items.filter((i) => i.kind === 'task' && !i.done).sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || b.createdAt - a.createdAt);
    const done = s.items.filter((i) => i.kind === 'task' && i.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)).slice(0, 20);
    return this.section('Задачи', open, 'Задач нет. Напишите «запиши …»') + this.section('Выполнено', done);
  }

  remindersHtml(): string {
    const s = this.store;
    const act = R.activeReminders(s).sort((a, b) => (R.effectiveDue(s, a) ?? 0) - (R.effectiveDue(s, b) ?? 0));
    const rep = act.filter((i) => i.repeat);
    const once = act.filter((i) => !i.repeat);
    return this.section('Ближайшие', once, 'Нет напоминаний. Напишите «напомни завтра в 9 …»') + this.section('Повторяющиеся', rep);
  }

  healthChips(): string {
    const latest = this.latestHealth();
    const chips: string[] = [];
    const add = (m: Metric, label: string) => latest[m] && chips.push(`<div class="chip"><span>${label}</span><b>${esc(healthText(latest[m]!.health!))}</b><i>${fmtDay(latest[m]!.createdAt)}</i></div>`);
    add('pressure', 'Давление');
    add('pulse', 'Пульс');
    add('sleep', 'Сон');
    const water = this.todaySum('water');
    if (water) chips.push(`<div class="chip"><span>Вода сегодня</span><b>${water} мл</b><i>сегодня</i></div>`);
    add('mood', 'Самочувствие');
    add('weight', 'Вес');
    return chips.length ? `<h3>Здоровье</h3><div class="chips">${chips.join('')}</div>` : '';
  }

  latestHealth(): Partial<Record<Metric, StoredItem>> {
    const out: Partial<Record<Metric, StoredItem>> = {};
    for (const it of this.store.items) {
      if (it.kind !== 'health' || !it.health) continue;
      const m = it.health.metric;
      if (!out[m] || out[m]!.createdAt < it.createdAt) out[m] = it;
    }
    return out;
  }

  healthHtml(): string {
    const recs = this.store.items.filter((i) => i.kind === 'health').sort((a, b) => b.createdAt - a.createdAt);
    const quick = `<div class="quick">
      <button class="pill" data-act="water">＋ стакан воды</button>
      <button class="pill" data-act="meds">Таблетки приняты</button>
    </div>
    <div class="moods"><span class="muted">Самочувствие:</span>${['😣', '🙁', '😐', '🙂', '😄'].map((e, i) => `<button class="face" data-act="mood" data-v="${i + 1}" title="${i + 1}">${e}</button>`).join('')}</div>`;
    const pressure = recs.filter((r) => r.health?.metric === 'pressure').slice(0, 14).reverse();
    const spark = pressure.length >= 2 ? `<div class="spark-box"><div class="muted">Давление, последние ${pressure.length} замеров</div>${this.spark(pressure.map((r) => [r.health!.value, r.health!.value2 ?? 0]))}</div>` : '';
    const list = recs.slice(0, 40).map((r) => `<li class="item k-health"><span class="dot"></span><div class="body"><div class="t">${esc(METRIC_LABEL[r.health!.metric])}: ${esc(healthText(r.health!))}</div><div class="m">${fmtWhen(r.createdAt)}</div></div><button class="x" data-act="del" data-id="${r.id}" aria-label="Удалить">×</button></li>`).join('');
    return `${quick}${this.healthChips()}${spark}<h3>Записи</h3>${list ? `<ul>${list}</ul>` : '<p class="muted">Пока пусто. Напишите «давление 125 на 80» или «спал 7 часов».</p>'}`;
  }

  spark(pairs: [number, number][]): string {
    const w = 300, h = 70, pad = 6;
    const all = pairs.flat();
    const lo = Math.min(...all) - 5, hi = Math.max(...all) + 5;
    const x = (i: number) => pad + (i * (w - 2 * pad)) / (pairs.length - 1);
    const y = (v: number) => h - pad - ((v - lo) / (hi - lo)) * (h - 2 * pad);
    const line = (k: 0 | 1) => pairs.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p[k]).toFixed(1)}`).join('');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${line(0)}" class="s1"/><path d="${line(1)}" class="s2"/></svg>`;
  }

  notesHtml(): string {
    const notes = this.store.items.filter((i) => i.kind === 'note').sort((a, b) => b.createdAt - a.createdAt);
    const list = notes.map((n) => `<li class="item k-note"><span class="dot"></span><div class="body"><div class="t">${esc(n.text)}</div><div class="m">${fmtWhen(n.createdAt)}</div></div><button class="x" data-act="del" data-id="${n.id}" aria-label="Удалить">×</button></li>`).join('');
    return `<h3>Заметки</h3>${list ? `<ul>${list}</ul>` : '<p class="muted">Напишите «заметка: …» или «запомни …»</p>'}`;
  }

  settingsHtml(): string {
    const nav = `<nav class="setnav">${SET_SECTIONS.map(([id, name]) => `<button class="${this.setSec === id ? 'on' : ''}" data-act="set-sec" data-id="${id}">${name}</button>`).join('')}</nav>`;
    let body = '';
    switch (this.setSec) {
      case 'main': body = this.setMainHtml(); break;
      case 'look': body = this.setLookHtml(); break;
      case 'brain': body = `<h3>Встроенный мозг</h3>${this.brainHtml(true)}${P.kind !== 'android' ? this.localHtml() : ''}`; break;
      case 'link': body = this.setLinkHtml(); break;
      case 'agents': body = this.setAgentsHtml(); break;
      case 'device': body = this.setDeviceHtml(); break;
      case 'help': body = this.setHelpHtml(); break;
    }
    return nav + body + '<p class="muted small">Тук · версия 0.2 · всё хранится только на ваших устройствах</p>';
  }

  setMainHtml(): string {
    const d = this.store.data;
    const st = d.settings;
    return `<h3>Помощник</h3>
      <label class="field"><span>Имя помощника</span><input id="set-name" value="${esc(st.name)}"></label>
      <label class="field"><span>Имя этого устройства</span><input id="set-device" value="${esc(d.deviceName)}"></label>
      <label class="toggle"><input type="checkbox" id="set-sound" ${st.sound ? 'checked' : ''}> Звуки</label>
      <label class="field"><span>Громкость</span><input type="range" id="set-volume" min="0" max="100" value="${Math.round((st.volume ?? 0.5) * 100)}"></label>
      ${P.kind === 'desktop' ? `<label class="toggle"><input type="checkbox" id="set-autostart" ${st.autostart ? 'checked' : ''}> Запускать вместе с Windows</label>
      <label class="field"><span>Экран острова</span><select id="set-screen"><option value="primary" ${st.islandScreen !== 'cursor' ? 'selected' : ''}>Основной</option><option value="cursor" ${st.islandScreen === 'cursor' ? 'selected' : ''}>Тот, где мышь</option></select></label>
      <p class="muted small">Открыть строку: <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Пробел</kbd>. Свернуть: <kbd>Esc</kbd>. <button class="linkbtn" data-act="shortcuts">Все горячие клавиши</button></p>` : ''}
      <h3>Сводка</h3>
      <button class="pill ghost" data-act="recap">Сводка за неделю</button>
      <p class="muted small">Каждый понедельник она появляется на «Сегодня» сама; здесь — в любой день.</p>
      ${P.kind === 'desktop' ? '<h3>Выход</h3><button class="pill ghost" data-act="quit">Выйти из Тука</button>' : ''}`;
  }

  setLookHtml(): string {
    const st = this.store.data.settings;
    return `<h3>Гардероб</h3>
      <div class="wardrobe">${(['auto', ...Object.keys(OUTFIT_LABEL)] as (Outfit | 'auto')[]).map((o) => `<button class="look ${(st.outfit ?? 'auto') === o ? 'on' : ''}" data-act="set-outfit" data-id="${o}"><canvas data-outfit="${o === 'auto' ? seasonalOutfit() : o}"></canvas><span>${o === 'auto' ? 'По сезону' : esc(OUTFIT_LABEL[o])}</span></button>`).join('')}</div>
      <p class="muted small">Цвет капюшона</p>
      <div class="swatches">${Object.entries(HOOD_COLORS).map(([n, c]) => `<button class="sw ${st.hoodColor === n ? 'on' : ''}" data-act="set-hood" data-id="${esc(n)}" title="${esc(n)}" style="background:rgb(${c.join(',')})"></button>`).join('')}</div>
      <p class="muted small">Огонёк в покое</p>
      <div class="swatches"><button class="sw auto ${!st.lightColor ? 'on' : ''}" data-act="set-light" data-id="" title="Как задумано">✦</button>${Object.entries(LIGHT_COLORS).map(([n, c]) => `<button class="sw ${st.lightColor === n ? 'on' : ''}" data-act="set-light" data-id="${esc(n)}" title="${esc(n)}" style="background:rgb(${c.join(',')})"></button>`).join('')}</div>
      ${P.kind === 'desktop' ? `<h3>На рабочем столе</h3>
      <div class="row"><button class="pill ${this.petOpen ? 'ghost' : ''}" data-act="${this.petOpen ? 'pet-off' : 'pet-on'}">${this.petOpen ? 'Вернуть Тука в строку' : 'Выпустить Тука на рабочий стол'}</button></div>
      <p class="muted small">Его можно перетаскивать; клик — тычок, двойной клик — обратно в строку. То же — в меню значка в трее.</p>` : ''}
      <h3>Состояния персонажа</h3><div class="moods-demo">${(Object.keys(MOOD_LABEL) as Mood[]).map((m) => `<button class="pill ghost small" data-act="preview" data-mood="${m}">${MOOD_LABEL[m]}</button>`).join('')}</div>`;
  }

  setLinkHtml(): string {
    const d = this.store.data;
    if (P.kind === 'android') {
      if (this.link.linked)
        return `<h3>Связь с ПК</h3><div class="card"><div><b>Связан с ${esc(d.sync.pcName ?? 'ПК')}</b></div>
          <div class="muted">${esc(d.sync.host ?? '')} · последняя синхронизация: ${d.sync.lastSync ? ago(d.sync.lastSync) : 'ещё не было'}</div>
          ${d.sync.lastError && this.link.status.state === 'error' ? `<div class="err">${esc(d.sync.lastError)}</div>` : ''}
          <div class="row"><button class="pill" data-act="sync">Синхронизировать</button><button class="pill ghost" data-act="unlink">Отвязать</button></div></div>
          <p class="muted small">Через связь приходят записи, сессии Claude Code с ПК, а разговор может идти мозгом ПК (⚙ → «Мозг»).</p>`;
      return `<h3>Связь с ПК</h3><div class="card"><p>Откройте Тук на ПК → ⚙ → «Связь» — там QR-код. ПК и телефон должны быть в одной сети Wi-Fi.</p>
          <button class="pill big" data-act="scan">Сканировать QR-код с ПК</button>
          <p class="muted">Или по коду из 6 цифр:</p>
          <button class="pill ghost" data-act="discover">Найти ПК в сети</button>
          ${this.found.map((f) => `<button class="found" data-act="pick" data-id="${f.id}">${esc(f.name)} · ${f.ip}</button>`).join('')}
          <div class="row"><input id="pair-ip" inputmode="decimal" placeholder="IP ПК, например 192.168.1.5" value="${esc(this.found[0]?.ip ?? '')}"><input id="pair-pin" inputmode="numeric" maxlength="7" placeholder="Код"></div>
          <button class="pill" data-act="pair-pin">Связать</button></div>`;
    }
    const peers = d.sync.peers ?? [];
    return `<h3>Связь с телефоном</h3><div class="card qr-card"><div id="qr" class="qr"></div>
        <div><p>На телефоне: Тук → ⚙ → «Связь» → <b>«Сканировать QR-код с ПК»</b>.</p><p class="muted" id="qr-ip"></p>
        <p class="muted">Нет камеры? Нажмите «Код из 6 цифр» и введите его на телефоне.</p>
        <button class="pill ghost" data-act="pin">Код из 6 цифр</button><div id="pin-box"></div></div></div>
        ${peers.length ? `<h4>Связанные устройства</h4><ul>${peers.map((p) => `<li class="item"><span class="dot"></span><div class="body"><div class="t">${esc(p.name)}</div><div class="m">был на связи ${ago(p.lastSeen)}</div></div></li>`).join('')}</ul><button class="pill ghost" data-act="reset-key">Отвязать все устройства</button>` : ''}
        ${P.kind === 'web' ? '<p class="muted">В демо в браузере QR-код показан для примера — связь работает только в приложении.</p>' : ''}`;
  }

  setAgentsHtml(): string {
    const st = this.store.data.settings;
    let h = '<h3>Claude Code и другие агенты</h3>';
    if (P.kind === 'desktop')
      h += `<div class="card">${this.claudeHooks ? '<b>Подключён.</b> <span class="muted">Сессии, шаги, правки, разрешения и вопросы — во вкладке «Агенты», на ПК и на телефоне.</span>' : '<span class="muted">Тук будет показывать каждую сессию Claude Code своим цветом, просить разрешения и отвечать на вопросы прямо в строке — на ПК и на телефоне.</span>'}
      <div class="row">${this.claudeHooks ? '<button class="pill ghost small" data-act="claude-off">Отключить</button>' : '<button class="pill small" data-act="claude-on">Подключить Claude Code</button>'}<button class="pill ghost small" data-act="tab" data-id="agents">Открыть вкладку «Агенты»</button></div>
      <p class="muted small">Тук добавит свои хуки в ~/.claude/settings.json и сохранит копию файла. Ваши настройки не меняются.</p></div>
      <label class="toggle"><input type="checkbox" id="set-agentclean" ${st.agentAutoClean !== false ? 'checked' : ''}> Убирать закончившие сессии через 30 мин и молчащие — через час</label>
      <p class="muted small">Другие агенты (Codex, Gemini CLI…) появляются своей пилюлей, если их хук добавляет в событие поле <code>"tuk_agent": "codex"</code> и вызывает <code>Tuk.exe --hook</code>.</p>`;
    else h += `<p class="muted">${this.link.linked ? 'Сессии Claude Code с ПК видны во вкладке «Агенты». Разрешение подтверждается отпечатком пальца.' : 'Свяжите телефон с ПК (раздел «Связь») — и сможете разрешать действия Claude Code и отвечать на его вопросы с телефона.'}</p>`;
    const rules = this.store.data.agentRules ?? [];
    if (rules.length)
      h += `<h4>Разрешено всегда</h4><ul>${rules.map((r, i) => `<li class="item"><span class="dot"></span><div class="body"><div class="t">${esc(r.tool)}</div><div class="m">в проекте «${esc(r.project)}»</div></div><button class="x" data-act="rule-del" data-id="${i}" aria-label="Убрать правило">×</button></li>`).join('')}</ul>`;
    h += '<div class="row"><button class="pill ghost small" data-act="demo-start">Посмотреть демо</button></div>';
    return h;
  }

  setDeviceHtml(): string {
    const st = this.store.data.settings;
    if (P.kind === 'desktop')
      return `<h3>Музыка</h3>
      <label class="toggle"><input type="checkbox" id="set-dance" ${st.dance ? 'checked' : ''}> Танцевать под музыку</label>
      <p class="muted small">Тук видит, что играет в Spotify, Яндекс Музыке, браузере и других плеерах Windows, и управляет ими из строки.</p>
      <h3>Команды компьютеру</h3><p class="muted small">«открой калькулятор», «найди в интернете …», «маршрут до …», «поставь таймер на 5 минут», «будильник на 7:00», «следующий трек».</p>`;
    if (P.kind === 'android')
      return `<h3>Тук над приложениями</h3>
      <div class="card">${st.island && this.islandOn ? '<b>Включён.</b> <span class="muted">Тук живёт вверху экрана, вокруг камеры. Нажатие — выпадающее окно, долгое нажатие — всё приложение.</span>' : '<span class="muted">Маленький анимированный Тук вверху экрана поверх любых приложений. Нажали — открылось небольшое окно: голос, записи, дела на сегодня.</span>'}
      <div class="row">${st.island && this.islandOn ? '<button class="pill ghost small" data-act="island-off">Убрать</button>' : '<button class="pill small" data-act="island-on">Включить</button>'}</div>
      <p class="muted small">Нужно разрешение «Поверх других приложений». В шторке появится тихое уведомление «Тук рядом» — так Android не выгружает Тука.</p></div>
      ${this.commandHtml()}
      ${this.voiceHtml()}
      ${this.wakeHtml()}
      <h3>Голос</h3>
      <label class="toggle"><input type="checkbox" id="set-voiceloop" ${st.voiceLoop !== false ? 'checked' : ''}> Продолжать разговор после ответа</label>
      <p class="muted small">Нажмите 🎤 и говорите. Без интернета распознавание работает, если скачан русский язык: Настройки → Общие настройки → Язык и ввод → Распознавание речи.</p>`;
    return '<p class="muted">В браузере управление устройством недоступно — это демо. В приложении здесь музыка, остров, голос и команды телефону.</p>';
  }

  setHelpHtml(): string {
    const can: [string, string][] = [
      ['Записи', '«напомни завтра в 9 позвонить», «каждый день в 21 таблетки», «запиши купить кабель», «заметка: щит 600×800»'],
      ['Здоровье', '«давление 125 на 80 пульс 70», «спал 7 часов», «выпил стакан воды»'],
      ['Файлы', '📎 или перетащить: txt, md, csv, json, log, xml, yaml, ini, srt, PDF, Word, Excel, PowerPoint, картинки — несколько сразу. Спросить, в заметки, в задачи'],
      ['Разговор', 'встроенный мозг без интернета или Ollama / LM Studio'],
      ['Агенты', 'сессии Claude Code своим цветом, разрешения, ответы на вопросы, с ПК и с телефона'],
      ['Команды', P.kind === 'android' ? 'будильник, таймер, звонок, сообщение, фонарик, громкость, яркость, «Не беспокоить», маршрут' : 'открыть программу или сайт, таймер, будильник, маршрут, поиск, музыка'],
      ['Связь', 'ПК ↔ телефон по Wi-Fi, шифрование, без облака'],
    ];
    return `<h3>Посмотреть без настройки</h3><div class="card"><span class="muted">Демо покажет две параллельные сессии Claude Code, разрешение, вопрос с вариантами, файл и все состояния персонажа. Ничего не сохраняется.</span>
      <div class="row">${this.demo ? '<button class="pill ghost small" data-act="demo-stop">Выйти из демо</button>' : '<button class="pill small" data-act="demo-start">Запустить демо</button>'}<button class="pill ghost small" data-act="onboard-open">Знакомство заново</button><button class="pill ghost small" data-act="shortcuts">Горячие клавиши</button></div></div>
      <h3>Что я умею</h3><ul class="can">${can.map(([t, d]) => `<li><b>${t}</b><span>${esc(d)}</span></li>`).join('')}</ul>
      ${this.examplesHtml()}`;
  }
}

async function main() {
  if (P.windowLabel() === 'pet') return runPet();
  let data: Data | null = null;
  try {
    const raw = await P.loadData();
    data = raw ? (JSON.parse(raw) as Data) : null;
  } catch {
    data = null;
  }
  if (!data || data.v !== 1) data = emptyData(P.kind === 'desktop' ? 'ПК' : P.kind === 'android' ? 'Телефон' : 'Браузер');
  data.settings = { ...emptyData('').settings, ...data.settings };
  data.fired ??= {};
  const app = new App(data);
  (window as unknown as { tuk: App }).tuk = app;
  document.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-act="example"]') as HTMLElement | null;
    if (b) void app.handleInput(b.dataset.id!);
  });
  await app.start();
}

void main();

export type { Item };

/** Ключ недели (год-номер понедельника), чтобы сводку показывать раз в неделю. */
function weekKey(t = Date.now()): string {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
