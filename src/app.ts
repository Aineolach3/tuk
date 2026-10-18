// Главный модуль: строка с персонажем, панель, вкладки, команды.

import { Character, HOOD_COLORS, LIGHT_COLORS, MOOD_LABEL, OUTFIT_LABEL, seasonalOutfit, type Mood, type Outfit } from './character.js';
import { play, setVolume, type Sound } from './sounds.js';
import { MAX_CHARS, readFile, type FileText } from './files.js';
import { computeRecap, renderRecap } from './recap.js';
import { AgentHub, KIND_LABEL, hooksInstalled, installHooks, uninstallHooks, type HubEvent, type Pending, type Session } from './agents.js';
import { runPet, type PetState } from './pet.js';
import { METRIC_LABEL, healthText, type Item, type Metric } from './model.js';
import { REPEAT_LABEL, fmtDay, fmtTime, fmtWhen, normalize, parse } from './parser.js';
import * as P from './platform.js';
import { Store, emptyData, type Data, type StoredItem } from './store.js';
import { Link, ago } from './link.js';
import { qrSvg } from './qr.js';
import * as R from './reminders.js';
import { randomKey } from './crypto.js';
import { Brain, MODELS, systemPrompt, type BrainState, type ChatMsg, type ModelId } from './brain.js';

type Tab = 'today' | 'chat' | 'tasks' | 'reminders' | 'health' | 'notes' | 'agents' | 'settings';

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
  collapseTimer: ReturnType<typeof setTimeout> | null = null;
  pinTimer: ReturnType<typeof setInterval> | null = null;
  found: P.Found[] = [];
  lastHtml = '';
  brain: Brain;
  generating = false;
  streamText = '';
  chatAbort: AbortController | null = null;
  lastBrainRender = 0;
  pokes: number[] = [];
  file: FileText | null = null; // прикреплённый файл для разговора
  lastBase: Mood = 'idle';
  hub: AgentHub;
  remote: { sessions: Session[]; pending: Pending[] } | null = null;
  claudeHooks: boolean | null = null;
  media: P.Media | null = null;
  mediaTitle = '';
  mediaCover = '';
  petOpen = false;
  lastPet = '';

  constructor(data: Data) {
    this.store = new Store(data, P.saveData);
    this.link = new Link(this.store);
    const st = data.settings;
    st.model ??= P.kind === 'desktop' ? 'smart' : 'lite';
    st.usePcBrain ??= true;
    this.brain = new Brain(st.model);
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
    this.hub.onEvent = (e) => this.onAgentEvent(e);
    this.link.hookHandler = (id, body) => this.hub.handle(id, body);
    this.link.agentsHandler = () => this.hub.snapshot();
    this.link.decideHandler = (reqId, d) => this.hub.decide(reqId, d);
    st.outfit ??= 'auto';
    st.hoodColor ??= 'Чёрный';
    this.char = new Character($<HTMLCanvasElement>('#char'));
    this.applyLook();
    document.documentElement.classList.add(P.kind);
    if (P.kind === 'web') document.documentElement.classList.add('android-like');
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
        this.setTab('settings');
      });
      void this.checkClaude();
    } else if (P.kind === 'android') {
      this.link.startClient();
      setInterval(() => void this.pollAgents(), 3000);
    }
    await R.syncAndroidSchedule(this.store);
    await P.askNotifyPermission().catch(() => {});
    await P.listen('toggle', () => this.toggleFromShortcut());
    await P.listen('open-link', () => {
      this.applyMode('expanded');
      this.setTab('settings');
    });
    await P.setAutostart(this.store.data.settings.autostart);
    this.flash('wave', 2400);
    this.sfx('hello');
    if (!this.store.items.length) this.say('Привет! Я Тук. Напишите, что записать или о чём напомнить.', null, 4000);
  }

  // ---------------- Настроение ----------------

  baseMood(): Mood {
    const now = Date.now();
    if (R.isAngry(this.store, now)) return 'angry';
    if (R.ringing(this.store, now).length || this.agentPending().length) return 'alert';
    if (this.media?.playing && this.store.data.settings.dance) return 'dance';
    if (now - this.lastActivity > this.store.data.settings.sleepAfterSec * 1000) return 'sleep';
    return 'idle';
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
    if (P.kind === 'desktop' && this.mode === 'collapsed') this.applyMode('compact');
    this.renderBar();
    this.renderReply();
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
  }

  // ---------------- Режимы строки (ПК) ----------------

  hovering = false;

  applyMode(m: P.BarMode): void {
    this.mode = m;
    const root = document.documentElement;
    root.classList.remove('mode-collapsed', 'mode-compact', 'mode-expanded');
    root.classList.add('mode-' + m);
    this.char.peek = m === 'collapsed' && P.kind === 'desktop' ? 0.18 : 0;
    void P.setMode(m);
    if (m === 'expanded') setTimeout(() => P.kind === 'desktop' && $<HTMLInputElement>('#input').focus(), 60);
    this.renderBar();
  }

  toggleFromShortcut(): void {
    this.activity();
    if (this.mode === 'expanded') this.applyMode('collapsed');
    else {
      this.applyMode('expanded');
      this.flash('listen', 1500);
    }
  }

  // ---------------- Команды ----------------

  async handleInput(text: string): Promise<void> {
    this.activity();
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
    this.flash('think', 500);
    await new Promise((r) => setTimeout(r, 450));
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
        this.say(`Удалил: «${it.text}».`, 'write', 1200);
        break;
      }
      case 'query':
        this.setTab(p.what);
        this.say(this.summary(), 'idle', 4000);
        break;
      case 'greet':
        this.say(`Привет! ${this.summary()}`, 'happy', 3000);
        break;
      case 'help':
        this.say('Например: «напомни завтра в 9 позвонить», «запиши купить кабель», «давление 125 на 80», «готово кабель».', 'idle', 9000);
        break;
    }
  }

  // ---------------- Разговор ----------------

  /** Есть ли чем думать: свой мозг или мозг ПК (для телефона). */
  canTalk(): boolean {
    return this.brain.ready || (P.kind === 'android' && this.link.linked && !!this.store.data.settings.usePcBrain);
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
    if (this.file) ctxText += `\n\nПрикреплённый файл «${this.file.name}»${this.file.truncated ? ' (начало)' : ''}:\n-----\n${this.file.text}\n-----\nОтвечай на вопросы о нём по его содержанию.`;
    const history = chat.slice(this.file ? -6 : -12).map((m) => ({ role: m.role, content: m.content }));
    const messages: ChatMsg[] = [{ role: 'system', content: systemPrompt(d.settings.name, ctxText) }, ...history];
    this.generating = true;
    this.streamText = '';
    this.chatAbort = new AbortController();
    this.tempMood = 'think';
    this.tempUntil = Date.now() + 600_000;
    this.char.set('think');
    this.renderChatLive();
    let answer = '';
    try {
      const pcFirst = P.kind === 'android' && this.link.linked && d.settings.usePcBrain;
      if (pcFirst) {
        try {
          answer = await this.link.askPc(messages);
        } catch (e) {
          if (!this.brain.ready) throw new Error('ПК не ответил, а своего мозга на телефоне пока нет. Скачайте его во вкладке «Чат».');
        }
      }
      if (!answer) {
        answer = await this.brain.chat(
          messages,
          (full) => {
            if (!this.streamText) this.flash('listen', 600_000);
            this.streamText = full;
            this.renderChatLive();
          },
          this.chatAbort.signal,
        );
      }
      answer = answer.trim() || '…';
      chat.push({ role: 'assistant', content: answer, ts: Date.now() });
      this.store.changed('chat');
      this.flash('happy', 1500);
      this.sfx('message');
      this.say(answer, null, Math.min(30_000, 4000 + answer.length * 60));
    } catch (e) {
      const msg = this.chatAbort?.signal.aborted ? 'Хорошо, остановился.' : String((e as Error).message ?? e);
      if (this.streamText) chat.push({ role: 'assistant', content: this.streamText.trim() });
      this.say(msg, this.chatAbort?.signal.aborted ? 'idle' : 'think', 4000);
    } finally {
      this.generating = false;
      this.streamText = '';
      this.chatAbort = null;
      if (this.tempMood === 'think' || this.tempMood === 'listen') this.tempMood = null;
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
    const head = this.brain.ready ? '' : this.canTalk() ? '<p class="muted small">Отвечает мозг ПК. Свой мозг на телефоне можно скачать в ⚙.</p>' : this.brainHtml();
    const bubbles = chat
      .slice(-40)
      .map((m) => `<div class="msg ${m.role === 'user' ? 'me' : 'tuk'}">${esc(m.content)}</div>`)
      .join('');
    const live = this.generating ? `<div class="msg tuk live" id="stream-bubble">${esc(this.streamText || '…')}</div>` : '';
    const empty = !chat.length && !this.generating
      ? `<p class="muted">Просто напишите что-нибудь: «как дела?», «что у меня завтра?», «посоветуй, с чего начать день». Команды вроде «напомни…» и «запиши…» работают как раньше.</p>`
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

  async takeFile(f: File): Promise<void> {
    this.activity();
    if (P.kind === 'desktop' && this.mode !== 'expanded') this.applyMode('expanded');
    this.flash('eat', 1400);
    this.sfx('eat');
    try {
      this.file = await readFile(f);
      const pages = this.file.pages ? ` (${this.file.pages} стр.)` : '';
      const cut = this.file.truncated ? ` Прочитал первые ${MAX_CHARS} символов — больше в мою голову не влезет.` : '';
      this.renderFileChip();
      if (this.canTalk()) {
        this.setTab('chat');
        this.say(`Проглотил «${this.file.name}»${pages}.${cut} Спросите, что в нём — например, «перескажи коротко».`, null, 7000);
      } else this.say(`Прочитал «${this.file.name}», но чтобы обсудить его, мне нужен мозг — вкладка «Чат».`, 'think', 6000);
    } catch (e) {
      this.file = null;
      this.renderFileChip();
      this.sfx('error');
      this.say(String((e as Error).message ?? e), 'think', 5000);
    }
  }

  renderFileChip(): void {
    const el = $('#file-chip');
    el.hidden = !this.file;
    if (this.file) el.innerHTML = `<span>📎 ${esc(this.file.name)}</span><button data-act="file-drop" aria-label="Убрать файл">×</button>`;
  }

  // ---------------- Недельная сводка ----------------

  showRecap(): void {
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

  agentSessions(): Session[] {
    return P.kind === 'desktop' ? this.hub.active : this.remote?.sessions ?? [];
  }

  agentPending(): Pending[] {
    return P.kind === 'desktop' ? this.hub.pending : this.remote?.pending ?? [];
  }

  onAgentEvent(e: HubEvent): void {
    const name = this.store.data.settings.name;
    if (e.type === 'permission') {
      this.sfx('alert');
      this.flash('alert', 4000);
      if (P.kind === 'desktop' && this.mode === 'collapsed') this.applyMode('compact');
      void P.notify(`${name}: Claude Code просит разрешения`, `${e.p.tool}: ${e.p.summary}`);
    } else if (e.type === 'done') {
      this.flash('happy', 2500);
      this.sfx('done');
      void P.notify(`${name}: Claude закончил`, `Проект «${e.s.project}»`);
    } else if (e.type === 'waiting') {
      void P.notify(`${name}: Claude ждёт вас`, e.message);
    }
    this.renderAgents();
  }

  renderAgents(): void {
    const has = this.agentSessions().length > 0 || this.agentPending().length > 0 || (P.kind === 'desktop' && !!this.claudeHooks);
    $('#tab-agents').hidden = !has;
    this.renderBar();
    if (this.tab === 'agents') {
      this.lastHtml = '';
      this.render();
    }
  }

  async decideAgent(reqId: number, d: 'allow' | 'deny' | 'always'): Promise<void> {
    if (P.kind === 'desktop') {
      this.hub.decide(reqId, d);
    } else {
      if (d !== 'deny' && !(await P.biometric('Разрешить действие Claude Code'))) return;
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

  agentsHtml(): string {
    const pend = this.agentPending();
    const sess = this.agentSessions();
    const STATUS: Record<Session['status'], string> = { working: 'работает', waiting: 'ждёт вас', done: 'закончил', ended: 'сессия закрыта' };
    let h = '';
    if (pend.length) {
      h += '<h3 class="warn">Просит разрешения</h3><ul>';
      for (const p of pend)
        h += `<li class="item perm"><div class="body"><div class="t"><b>${esc(p.tool)}</b> · ${esc(p.summary)}</div><div class="m">${esc(p.project)} · ${ago(p.created)}</div>
          <div class="row"><button class="pill small" data-act="agent-allow" data-id="${p.reqId}">Разрешить</button><button class="pill ghost small" data-act="agent-always" data-id="${p.reqId}">Всегда в этом проекте</button><button class="pill ghost small" data-act="agent-deny" data-id="${p.reqId}">Запретить</button></div></div></li>`;
      h += '</ul>';
    }
    if (!sess.length && !pend.length)
      h += `<p class="muted">${P.kind === 'desktop' ? 'Запустите Claude Code — здесь появятся его шаги, правки и запросы разрешений.' : 'Когда на ПК работает Claude Code, здесь видно, что он делает, и можно разрешать его действия.'}</p>`;
    for (const s of sess) {
      h += `<h3>${esc(s.project)} <span class="pill-status st-${s.status}">${STATUS[s.status]}</span></h3>`;
      if (s.prompt) h += `<p class="muted small">«${esc(s.prompt)}»</p>`;
      const steps = s.steps.slice(-10).reverse();
      if (steps.length)
        h += `<ul class="steps">${steps
          .map((st) => `<li><span class="k k-${st.kind}">${KIND_LABEL[st.kind]}</span> <span class="tx">${esc(st.text)}</span>${st.plus != null ? ` <span class="plus">+${st.plus}</span> <span class="minus">−${st.minus}</span>` : ''}</li>`)
          .join('')}</ul>`;
    }
    return h;
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
      const f = fileInput.files?.[0];
      if (f) void this.takeFile(f);
      fileInput.value = '';
    });
    document.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (this.tempMood !== 'listen') this.flash('listen', 1500);
      if (P.kind === 'desktop' && this.mode === 'collapsed') this.applyMode('compact');
    });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) void this.takeFile(f);
    });

    $('#bar').addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-act]')) return;
      this.activity();
      if (P.kind !== 'desktop') {
        this.flash('happy', 1200);
        return;
      }
      this.applyMode(this.mode === 'expanded' ? 'collapsed' : 'expanded');
    });

    if (P.kind === 'desktop') {
      document.body.addEventListener('mouseenter', () => {
        this.hovering = true;
        if (this.collapseTimer) clearTimeout(this.collapseTimer);
        if (this.mode === 'collapsed') this.applyMode('compact');
      });
      document.body.addEventListener('mouseleave', () => {
        this.hovering = false;
        if (this.mode !== 'compact') return;
        this.collapseTimer = setTimeout(() => {
          if (this.mode === 'compact' && !R.ringing(this.store).length && Date.now() > this.replyUntil) this.applyMode('collapsed');
        }, 900);
      });
      window.addEventListener('blur', () => {
        setTimeout(() => {
          if (!document.hasFocus() && this.mode === 'expanded') this.applyMode(R.ringing(this.store).length ? 'compact' : 'collapsed');
        }, 250);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') this.applyMode('collapsed');
      });
    }

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
      } else if (t.id === 'set-name') st.name = t.value.trim() || 'Тук';
      else if (t.id === 'set-usepc') st.usePcBrain = t.checked;
      else if (t.id === 'set-dance') st.dance = t.checked;
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
      case 'media-toggle':
      case 'media-next':
      case 'media-prev':
        await P.mediaControl(act === 'media-toggle' ? 'toggle' : act === 'media-next' ? 'next' : 'prev').catch(() => {});
        setTimeout(() => void this.pollMedia(), 400);
        break;
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
        this.file = null;
        this.renderFileChip();
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
      line = `<b>Claude: ${esc(p.tool)}</b> ${esc(p.summary)}`;
      actions = `<button class="mini ok" data-act="agent-allow" data-id="${p.reqId}" title="Разрешить">✓</button><button class="mini" data-act="agent-deny" data-id="${p.reqId}" title="Запретить">✕</button>`;
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
    const d = this.store.data;
    const st = d.settings;
    let link = '';
    if (P.kind === 'android') {
      if (this.link.linked) {
        link = `<div class="card"><div><b>Связан с ${esc(d.sync.pcName ?? 'ПК')}</b></div>
          <div class="muted">${esc(d.sync.host ?? '')} · последняя синхронизация: ${d.sync.lastSync ? ago(d.sync.lastSync) : 'ещё не было'}</div>
          ${d.sync.lastError && this.link.status.state === 'error' ? `<div class="err">${esc(d.sync.lastError)}</div>` : ''}
          <div class="row"><button class="pill" data-act="sync">Синхронизировать</button><button class="pill ghost" data-act="unlink">Отвязать</button></div></div>`;
      } else {
        link = `<div class="card"><p>Откройте Тук на ПК → вкладка ⚙ — там QR-код. ПК и телефон должны быть в одной сети Wi-Fi.</p>
          <button class="pill big" data-act="scan">Сканировать QR-код с ПК</button>
          <p class="muted">Или по коду из 6 цифр:</p>
          <button class="pill ghost" data-act="discover">Найти ПК в сети</button>
          ${this.found.map((f) => `<button class="found" data-act="pick" data-id="${f.id}">${esc(f.name)} · ${f.ip}</button>`).join('')}
          <div class="row"><input id="pair-ip" inputmode="decimal" placeholder="IP ПК, например 192.168.1.5" value="${esc(this.found[0]?.ip ?? '')}"><input id="pair-pin" inputmode="numeric" maxlength="7" placeholder="Код"></div>
          <button class="pill" data-act="pair-pin">Связать</button></div>`;
      }
    } else {
      const peers = d.sync.peers ?? [];
      link = `<div class="card qr-card"><div id="qr" class="qr"></div>
        <div><p>На телефоне: Тук → ⚙ → <b>«Сканировать QR-код с ПК»</b>.</p><p class="muted" id="qr-ip"></p>
        <p class="muted">Нет камеры? Нажмите «Код из 6 цифр» и введите его на телефоне.</p>
        <button class="pill ghost" data-act="pin">Код из 6 цифр</button><div id="pin-box"></div></div></div>
        ${peers.length ? `<h4>Связанные устройства</h4><ul>${peers.map((p) => `<li class="item"><span class="dot"></span><div class="body"><div class="t">${esc(p.name)}</div><div class="m">был на связи ${ago(p.lastSeen)}</div></div></li>`).join('')}</ul><button class="pill ghost" data-act="reset-key">Отвязать все устройства</button>` : ''}
        ${P.kind === 'web' ? '<p class="muted">В демо-режиме QR-код показан для примера — связь работает только в приложении.</p>' : ''}`;
    }
    const moods = (Object.keys(MOOD_LABEL) as Mood[]).map((m) => `<button class="pill ghost small" data-act="preview" data-mood="${m}">${MOOD_LABEL[m]}</button>`).join('');
    return `<h3>Связь ${P.kind === 'android' ? 'с ПК' : 'с телефоном'}</h3>${link}
      <h3>Мозг</h3>${this.brainHtml(true)}
      <h3>Помощник</h3>
      <label class="field"><span>Имя помощника</span><input id="set-name" value="${esc(st.name)}"></label>
      <label class="field"><span>Имя этого устройства</span><input id="set-device" value="${esc(d.deviceName)}"></label>
      <label class="toggle"><input type="checkbox" id="set-sound" ${st.sound ? 'checked' : ''}> Звуки</label>
      <label class="field"><span>Громкость</span><input type="range" id="set-volume" min="0" max="100" value="${Math.round((st.volume ?? 0.5) * 100)}"></label>
      <h3>Гардероб</h3>
      <div class="wardrobe">${(['auto', ...Object.keys(OUTFIT_LABEL)] as (Outfit | 'auto')[]).map((o) => `<button class="look ${(st.outfit ?? 'auto') === o ? 'on' : ''}" data-act="set-outfit" data-id="${o}"><canvas data-outfit="${o === 'auto' ? seasonalOutfit() : o}"></canvas><span>${o === 'auto' ? 'По сезону' : esc(OUTFIT_LABEL[o])}</span></button>`).join('')}</div>
      <p class="muted small">Цвет капюшона</p>
      <div class="swatches">${Object.entries(HOOD_COLORS).map(([n, c]) => `<button class="sw ${st.hoodColor === n ? 'on' : ''}" data-act="set-hood" data-id="${esc(n)}" title="${esc(n)}" style="background:rgb(${c.join(',')})"></button>`).join('')}</div>
      <p class="muted small">Огонёк в покое</p>
      <div class="swatches"><button class="sw auto ${!st.lightColor ? 'on' : ''}" data-act="set-light" data-id="" title="Как задумано">✦</button>${Object.entries(LIGHT_COLORS).map(([n, c]) => `<button class="sw ${st.lightColor === n ? 'on' : ''}" data-act="set-light" data-id="${esc(n)}" title="${esc(n)}" style="background:rgb(${c.join(',')})"></button>`).join('')}</div>
      ${P.kind === 'desktop' ? `<h3>На рабочем столе</h3>
      <div class="row"><button class="pill ${this.petOpen ? 'ghost' : ''}" data-act="${this.petOpen ? 'pet-off' : 'pet-on'}">${this.petOpen ? 'Вернуть Тука в строку' : 'Выпустить Тука на рабочий стол'}</button></div>
      <p class="muted small">Его можно перетаскивать; клик — тычок, двойной клик — обратно в строку. То же — в меню значка в трее.</p>
      <h3>Музыка</h3>
      <label class="toggle"><input type="checkbox" id="set-dance" ${st.dance ? 'checked' : ''}> Танцевать под музыку</label>
      <p class="muted small">Тук видит, что играет в Spotify, Яндекс Музыке, браузере и других плеерах Windows, и управляет ими из строки.</p>
      <h3>Claude Code</h3>
      <div class="card">${this.claudeHooks ? '<b>Подключён.</b> <span class="muted">Шаги и запросы разрешений — во вкладке «Агенты», на ПК и на телефоне.</span>' : '<span class="muted">Тук будет показывать, что делает Claude Code, и просить разрешения прямо в строке — на ПК и на телефоне.</span>'}
      <div class="row">${this.claudeHooks ? '<button class="pill ghost small" data-act="claude-off">Отключить</button>' : '<button class="pill small" data-act="claude-on">Подключить Claude Code</button>'}</div>
      <p class="muted small">Тук добавит свои хуки в ~/.claude/settings.json и сохранит копию файла. Ваши настройки не меняются.</p></div>` : ''}
      <h3>Сводка</h3>
      <button class="pill ghost" data-act="recap">Сводка за неделю</button>
      ${P.kind === 'desktop' ? `<label class="toggle"><input type="checkbox" id="set-autostart" ${st.autostart ? 'checked' : ''}> Запускать вместе с Windows</label><p class="muted">Открыть строку: Ctrl+Alt+Пробел. Свернуть: Esc.</p>` : ''}
      <h3>Состояния персонажа</h3><div class="moods-demo">${moods}</div>
      ${P.kind === 'desktop' ? '<button class="pill ghost" data-act="quit">Выйти из Тука</button>' : ''}
      <p class="muted small">Тук · версия 0.1 · всё хранится только на ваших устройствах</p>`;
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
