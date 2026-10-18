// Главный модуль: строка с персонажем, панель, вкладки, команды.

import { Character, MOOD_LABEL, type Mood } from './character.js';
import { METRIC_LABEL, healthText, type Item, type Metric } from './model.js';
import { REPEAT_LABEL, fmtDay, fmtTime, fmtWhen, normalize, parse } from './parser.js';
import * as P from './platform.js';
import { Store, emptyData, type Data, type StoredItem } from './store.js';
import { Link, ago } from './link.js';
import { qrSvg } from './qr.js';
import * as R from './reminders.js';
import { randomKey } from './crypto.js';

type Tab = 'today' | 'tasks' | 'reminders' | 'health' | 'notes' | 'settings';

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

  constructor(data: Data) {
    this.store = new Store(data, P.saveData);
    this.link = new Link(this.store);
    this.char = new Character($<HTMLCanvasElement>('#char'));
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
    if (P.kind === 'desktop') await this.link.startServer();
    else if (P.kind === 'android') this.link.startClient();
    await R.syncAndroidSchedule(this.store);
    await P.askNotifyPermission().catch(() => {});
    await P.listen('toggle', () => this.toggleFromShortcut());
    await P.listen('open-link', () => {
      this.applyMode('expanded');
      this.setTab('settings');
    });
    await P.setAutostart(this.store.data.settings.autostart);
    if (!this.store.items.length) this.say('Привет! Я Тук. Напишите, что записать или о чём напомнить.', 'happy', 4000);
  }

  // ---------------- Настроение ----------------

  baseMood(): Mood {
    const now = Date.now();
    if (R.isAngry(this.store, now)) return 'angry';
    if (R.ringing(this.store, now).length) return 'alert';
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
    if (wasAsleep && !this.tempMood) this.char.set('idle');
  }

  tick(): void {
    const now = Date.now();
    // напоминания
    for (const it of R.dueToFire(this.store, now)) {
      R.markFired(this.store, it);
      this.store.changed('fired');
      if (P.kind !== 'android') void P.notify(this.store.data.settings.name, it.text);
      this.beep(880);
      this.flash('alert', 3000);
      if (P.kind === 'desktop') this.applyMode(this.mode === 'expanded' ? 'expanded' : 'compact');
    }
    if (this.tempMood && now > this.tempUntil) this.tempMood = null;
    if (!this.tempMood) this.char.set(this.baseMood());
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
    this.flash('think', 500);
    await new Promise((r) => setTimeout(r, 450));
    const s = this.store;

    switch (p.type) {
      case 'reminder': {
        s.add({ kind: 'reminder', text: p.text, dueAt: p.dueAt, repeat: p.repeat, tag: p.tag });
        const rep = p.repeat ? `, ${REPEAT_LABEL[p.repeat]}` : '';
        this.say(`Напомню ${fmtWhen(p.dueAt)}${rep}: «${p.text}»`, 'write', 1600);
        this.beep(660);
        break;
      }
      case 'task': {
        s.add({ kind: 'task', text: p.text, dueAt: p.dueAt, allDay: p.allDay });
        const when = p.dueAt ? ` на ${fmtDay(p.dueAt)}` : '';
        const extra = p.reason === 'no-time' ? ' Чтобы напомнить, добавьте время: «завтра в 9».' : '';
        this.say(`Записал задачу${when}: «${p.text}».${extra}`, 'write', 1600);
        this.beep(660);
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

  beep(freq: number): void {
    if (!this.store.data.settings.sound) return;
    try {
      const AC = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
      const ac = (this as unknown as { ac?: AudioContext }).ac ?? new AC();
      (this as unknown as { ac?: AudioContext }).ac = ac;
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.12, ac.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.25);
      o.connect(g).connect(ac.destination);
      o.start();
      o.stop(ac.currentTime + 0.3);
    } catch {
      /* без звука */
    }
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
          this.beep(990);
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
    r.classList.toggle('show', !!this.reply);
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
    if (ring.length) {
      const it = ring[0];
      line = `<b>${esc(it.text)}</b>`;
      actions = `<button class="mini ok" data-act="done" data-id="${it.id}" title="Готово">✓</button><button class="mini" data-act="snooze" data-id="${it.id}" data-min="10" title="Отложить на 10 минут">+10</button>`;
    } else if (this.reply && this.mode !== 'expanded') {
      line = esc(this.reply);
    } else {
      const next = R.activeReminders(this.store)
        .filter((i) => (i.dueAt ?? 0) > now)
        .sort((a, b) => a.dueAt! - b.dueAt!)[0];
      if (next) line = `<span class="muted">${next.dueAt! - startOfDay() < DAY ? fmtTime(next.dueAt!) : fmtDay(next.dueAt!)}</span> ${esc(next.text)}`;
      else line = `<span class="muted">${esc(this.store.data.settings.name)} · ${MOOD_LABEL[this.char.mood].toLowerCase()}</span>`;
    }
    if (this.mode === 'collapsed' && P.kind === 'desktop') {
      const next = R.activeReminders(this.store).filter((i) => (i.dueAt ?? 0) > now).sort((a, b) => a.dueAt! - b.dueAt!)[0];
      line = ring.length ? '<b>!</b>' : next && next.dueAt! - now < 12 * 3_600_000 ? `<span class="muted">${fmtTime(next.dueAt!)}</span>` : '';
      actions = '';
    }
    text.innerHTML = line;
    act.innerHTML = actions;
    const n = ring.length;
    badge.textContent = n ? String(n) : '';
    badge.classList.toggle('show', n > 0);
  }

  viewHtml(): string {
    switch (this.tab) {
      case 'today':
        return this.todayHtml();
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
    let h = `<div class="hello"><div class="big">${fmtDay(now).replace(/^./, (c) => c.toUpperCase())}, ${new Date(now).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</div><div class="muted">${this.summary()}${doneToday ? ` Сделано сегодня: ${doneToday}.` : ''}</div></div>`;
    h += this.section('Просрочено', ring, '', 'warn');
    h += this.section('Сегодня', [...todayRem, ...tasksToday], 'На сегодня ничего не запланировано');
    h += this.section('Без срока', noDue);
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
      <h3>Помощник</h3>
      <label class="field"><span>Имя помощника</span><input id="set-name" value="${esc(st.name)}"></label>
      <label class="field"><span>Имя этого устройства</span><input id="set-device" value="${esc(d.deviceName)}"></label>
      <label class="toggle"><input type="checkbox" id="set-sound" ${st.sound ? 'checked' : ''}> Звуки</label>
      ${P.kind === 'desktop' ? `<label class="toggle"><input type="checkbox" id="set-autostart" ${st.autostart ? 'checked' : ''}> Запускать вместе с Windows</label><p class="muted">Открыть строку: Ctrl+Alt+Пробел. Свернуть: Esc.</p>` : ''}
      <h3>Состояния персонажа</h3><div class="moods-demo">${moods}</div>
      ${P.kind === 'desktop' ? '<button class="pill ghost" data-act="quit">Выйти из Тука</button>' : ''}
      <p class="muted small">Тук · версия 0.1 · всё хранится только на ваших устройствах</p>`;
  }
}

async function main() {
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
