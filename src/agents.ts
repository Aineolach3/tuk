// Слежение за Claude Code и другими агентами: хуки присылают события на ПК (Tuk.exe --hook → /hook),
// Тук показывает каждую сессию своей «пилюлей» своего цвета, держит очередь запросов разрешений
// из всех сессий сразу и отвечает на вопросы AskUserQuestion — на ПК и на телефоне.
// Очередь, правило «ход окончен — карточка уходит» и ответ на вопрос через updatedInput —
// по мотивам Coucou (MIT, Louis Raillé): windows/src/island/hooks.ts, hook/src/reply.rs.

/* eslint-disable @typescript-eslint/no-explicit-any */

export type StepKind = 'read' | 'edit' | 'run' | 'search' | 'web' | 'task' | 'ask' | 'other';

export interface Step {
  t: number;
  kind: StepKind;
  text: string;
  plus?: number;
  minus?: number;
}

export type SessionStatus = 'working' | 'waiting' | 'done' | 'error' | 'stale' | 'ended';

export interface Session {
  id: string;
  /** Кто это: «Claude Code», «Codex»… */
  agent: string;
  project: string;
  cwd: string;
  prompt?: string;
  steps: Step[];
  status: SessionStatus;
  updated: number;
  /** Когда сессия появилась. */
  started?: number;
  /** Цвет пилюли (#rrggbb) — у одновременных сессий разные. */
  color?: string;
  /** Сумма правок за текущий запрос. */
  plus?: number;
  minus?: number;
  /** Последний ответ агента (Stop → last_assistant_message). */
  final?: string;
}

export interface AskedOption {
  label: string;
  description?: string;
}
export interface AskedQuestion {
  question: string;
  header?: string;
  options: AskedOption[];
  multiSelect: boolean;
}

export interface Pending {
  reqId: number;
  sessionId: string;
  project: string;
  tool: string;
  summary: string;
  created: number;
  /** Цвет и имя сессии — чтобы карточка совпадала с пилюлей. */
  color?: string;
  agent?: string;
  /** AskUserQuestion: вопросы с вариантами вместо «Разрешить/Запретить». */
  questions?: AskedQuestion[];
}

export interface Rule {
  tool: string;
  project: string;
}

export const KIND_LABEL: Record<StepKind, string> = {
  read: 'читает', edit: 'правит', run: 'запускает', search: 'ищет', web: 'в интернете', task: 'поручение', ask: 'спрашивает', other: 'делает',
};

export const STATUS_LABEL: Record<SessionStatus, string> = {
  working: 'работает', waiting: 'ждёт вас', done: 'закончил', error: 'ошибка', stale: 'молчит', ended: 'закрыта',
};

/** Цвета пилюль: разные, хорошо видны на тёмном фоне. */
export const SESSION_COLORS = ['#f4c470', '#7cc4ff', '#6cc46a', '#e879f9', '#ff8a65', '#2dd4bf', '#a78bfa', '#facc15'];

/** Известные агенты (поле tuk_agent или coucou_agent в событии). Цвета — как у Coucou. */
export const KNOWN_AGENTS: Record<string, { name: string; color: string }> = {
  claude: { name: 'Claude Code', color: '#d97757' },
  codex: { name: 'Codex', color: '#2dd4bf' },
  gemini: { name: 'Gemini CLI', color: '#8ab4f8' },
  cursor: { name: 'Cursor', color: '#c0c4cc' },
  copilot: { name: 'Copilot CLI', color: '#818cf8' },
  opencode: { name: 'OpenCode', color: '#4ade80' },
  amp: { name: 'Amp', color: '#f59e0b' },
};

/** Тайминги уборки (мс). */
export const TIMEOUTS = {
  /** Ждём решения по разрешению; потом Claude Code спросит в терминале. */
  pending: 110_000,
  /** Работает, но давно ни одного события — «молчит». */
  stale: 10 * 60_000,
  /** Молчащая сессия исчезает. */
  staleRemove: 60 * 60_000,
  /** Закончившая сессия исчезает. */
  doneRemove: 30 * 60_000,
  /** Закрытая (SessionEnd) исчезает. */
  endedRemove: 60_000,
};

const base = (p: string) => (p || '').split(/[\\/]/).filter(Boolean).pop() ?? p;

export function kindOf(tool: string): StepKind {
  if (/^(Read|NotebookRead|LS|view_file)$/.test(tool)) return 'read';
  if (/^(Edit|MultiEdit|Write|NotebookEdit|write_to_file|replace_file_content)$/.test(tool)) return 'edit';
  if (/^(Bash|BashOutput|KillShell|PowerShell|run_command)$/.test(tool)) return 'run';
  if (/^(Grep|Glob)$/.test(tool)) return 'search';
  if (/^(WebFetch|WebSearch|search_web|read_url_content)$/.test(tool)) return 'web';
  if (/^(Task|Agent|TodoWrite)$/.test(tool)) return 'task';
  if (tool === 'AskUserQuestion') return 'ask';
  return 'other';
}

/** Короткое описание действия по имени инструмента и его входу. */
export function summarize(tool: string, input: any): string {
  const i = input ?? {};
  switch (kindOf(tool)) {
    case 'read':
    case 'edit':
      return base(i.file_path ?? i.notebook_path ?? i.path ?? '') || tool;
    case 'run':
      return String(i.command ?? i.description ?? tool).slice(0, 160);
    case 'search':
      return String(i.pattern ?? i.query ?? '').slice(0, 80);
    case 'web':
      return String(i.url ?? i.query ?? '').slice(0, 120);
    case 'task':
      return String(i.description ?? i.subject ?? 'подзадача').slice(0, 120);
    case 'ask':
      return String(i.questions?.[0]?.question ?? 'вопрос').slice(0, 160);
    default:
      return tool.replace(/^mcp__/, '').replace(/__/g, ' · ');
  }
}

/** +строк / −строк для правок. */
export function diffCount(tool: string, input: any): { plus: number; minus: number } | null {
  const lines = (s: unknown) => (typeof s === 'string' && s.length ? s.split('\n').length : 0);
  if (tool === 'Write') return { plus: lines(input?.content), minus: 0 };
  if (tool === 'Edit') return { plus: lines(input?.new_string), minus: lines(input?.old_string) };
  if (tool === 'MultiEdit' && Array.isArray(input?.edits))
    return input.edits.reduce((a: any, e: any) => ({ plus: a.plus + lines(e.new_string), minus: a.minus + lines(e.old_string) }), { plus: 0, minus: 0 });
  return null;
}

/** Вопросы AskUserQuestion, если их можно показать кнопками; иначе null — пусть отвечают в терминале. */
export function askedQuestions(tool: string, input: any): AskedQuestion[] | null {
  if (tool !== 'AskUserQuestion' || !Array.isArray(input?.questions)) return null;
  const out: AskedQuestion[] = [];
  for (const raw of input.questions) {
    const question = typeof raw?.question === 'string' ? raw.question : '';
    const options: AskedOption[] = (Array.isArray(raw?.options) ? raw.options : [])
      .filter((o: any) => typeof o?.label === 'string' && o.label)
      .map((o: any) => ({ label: o.label, description: typeof o.description === 'string' ? o.description : '' }));
    if (!question || options.length < 2) return null;
    out.push({ question, header: typeof raw.header === 'string' ? raw.header : undefined, options, multiSelect: raw.multiSelect === true });
  }
  return out.length ? out : null;
}

/** Имя агента из события: tuk_agent / coucou_agent, иначе Claude Code. */
export function agentOf(ev: any): { id: string; name: string } {
  const raw = String(ev?.tuk_agent ?? ev?.coucou_agent ?? '').toLowerCase();
  if (!raw || raw.length > 24 || !/^[a-z0-9-]+$/.test(raw)) return { id: 'claude', name: 'Claude Code' };
  return { id: raw, name: KNOWN_AGENTS[raw]?.name ?? raw };
}

/** События, после которых ждущий запрос этой сессии уже не нужен: ход закончился. */
const TURN_OVER = new Set(['Stop', 'StopFailure', 'UserPromptSubmit', 'SessionEnd', 'Interrupt']);

export type HubEvent =
  | { type: 'permission'; p: Pending }
  | { type: 'done'; s: Session }
  | { type: 'error'; s: Session }
  | { type: 'waiting'; s: Session; message: string };

export type Decision = 'allow' | 'deny' | 'always';

export class AgentHub {
  sessions = new Map<string, Session>();
  /** Очередь запросов: первый пришёл — первый показан. */
  pending: Pending[] = [];
  onChange: () => void = () => {};
  onEvent: (e: HubEvent) => void = () => {};
  /** Полный вход инструмента для ответа на вопрос — на телефон не уходит. */
  private inputs = new Map<number, any>();

  constructor(
    private reply: (reqId: number, body: string) => void,
    private rules: () => Rule[],
    private addRule: (r: Rule) => void,
    private now: () => number = Date.now,
  ) {}

  /** Свободный цвет: у одновременно живущих сессий цвета не повторяются (пока их не больше 8). */
  private pickColor(): string {
    const used = new Set([...this.sessions.values()].map((s) => s.color));
    return SESSION_COLORS.find((c) => !used.has(c)) ?? SESSION_COLORS[this.sessions.size % SESSION_COLORS.length];
  }

  private session(ev: any): Session {
    const agent = agentOf(ev);
    const sid = String(ev.session_id ?? 'default');
    // у разных агентов id сессий могут совпасть — разделяем
    const id = agent.id === 'claude' ? sid : `${agent.id}:${sid}`;
    const t = this.now();
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, agent: agent.name, cwd: ev.cwd ?? '', project: base(ev.cwd ?? '') || 'проект', steps: [], status: 'working', updated: t, started: t, plus: 0, minus: 0 };
      s.color = agent.id !== 'claude' ? KNOWN_AGENTS[agent.id]?.color ?? this.pickColor() : this.pickColor();
      this.sessions.set(id, s);
    }
    if (ev.cwd) {
      s.cwd = ev.cwd;
      s.project = base(ev.cwd) || s.project;
    }
    s.updated = t;
    if (s.status === 'stale') s.status = 'working';
    return s;
  }

  /** Убрать ждущие запросы сессии без решения — Claude Code спросит в терминале. */
  private dropSession(sessionId: string, onlyQuestions = false): number {
    let n = 0;
    for (const p of [...this.pending]) {
      if (p.sessionId !== sessionId || (onlyQuestions && !p.questions)) continue;
      this.release(p.reqId, '');
      n++;
    }
    return n;
  }

  private release(reqId: number, body: string): Pending | undefined {
    const i = this.pending.findIndex((p) => p.reqId === reqId);
    if (i < 0) return undefined;
    const [p] = this.pending.splice(i, 1);
    this.inputs.delete(reqId);
    this.reply(reqId, body);
    const s = this.sessions.get(p.sessionId);
    if (s && s.status === 'waiting' && !this.pending.some((x) => x.sessionId === s.id)) s.status = 'working';
    return p;
  }

  /** Событие хука. Для всех, кроме PermissionRequest, отвечаем сразу и пусто (без решения). */
  handle(reqId: number, body: string): void {
    let ev: any;
    try {
      ev = JSON.parse(body);
    } catch {
      return this.reply(reqId, '');
    }
    const name = String(ev.hook_event_name ?? '');
    const s = this.session(ev);
    if (TURN_OVER.has(name)) this.dropSession(s.id);
    switch (name) {
      case 'SessionStart':
        s.status = 'working';
        break;
      case 'UserPromptSubmit':
        s.prompt = String(ev.prompt ?? ev.message ?? '').slice(0, 300);
        s.status = 'working';
        s.steps = [];
        s.plus = 0;
        s.minus = 0;
        s.final = undefined;
        break;
      case 'PreToolUse':
        s.status = this.pending.some((p) => p.sessionId === s.id) ? 'waiting' : 'working';
        s.final = undefined;
        s.steps.push({ t: this.now(), kind: kindOf(ev.tool_name), text: summarize(ev.tool_name, ev.tool_input) });
        if (s.steps.length > 60) s.steps.splice(0, s.steps.length - 60);
        break;
      case 'PostToolUse': {
        // на вопрос ответили в терминале — карточка врёт
        if (ev.tool_name === 'AskUserQuestion') this.dropSession(s.id, true);
        const d = diffCount(ev.tool_name, ev.tool_input);
        const text = summarize(ev.tool_name, ev.tool_input);
        const last = [...s.steps].reverse().find((x) => x.text === text && x.plus == null);
        if (d) {
          if (last) Object.assign(last, d);
          else s.steps.push({ t: this.now(), kind: 'edit', text, ...d });
          s.plus = (s.plus ?? 0) + d.plus;
          s.minus = (s.minus ?? 0) + d.minus;
        }
        if (s.status !== 'waiting') s.status = 'working';
        break;
      }
      case 'PostToolUseFailure':
        s.steps.push({ t: this.now(), kind: 'other', text: '⚠ не получилось' });
        break;
      case 'SubagentStart':
        s.steps.push({ t: this.now(), kind: 'task', text: '+ помощник' });
        break;
      case 'PermissionRequest': {
        const tool = String(ev.tool_name ?? 'инструмент');
        const input = ev.tool_input ?? {};
        const questions = agentOf(ev).id === 'claude' ? askedQuestions(tool, input) : null;
        if (!questions && this.rules().some((r) => r.tool === tool && r.project === s.project)) {
          this.reply(reqId, decision('allow'));
          this.onChange();
          return;
        }
        const p: Pending = {
          reqId, sessionId: s.id, project: s.project, tool, summary: summarize(tool, input), created: this.now(),
          color: s.color, agent: s.agent, ...(questions ? { questions } : {}),
        };
        if (questions) this.inputs.set(reqId, input);
        s.status = 'waiting';
        this.pending.push(p);
        this.onEvent({ type: 'permission', p });
        this.onChange();
        return; // ответим, когда решит человек (или по таймауту в sweep)
      }
      case 'Notification':
        if (/idle|input|permission/.test(String(ev.notification_type ?? '')) || /\?\s*$/.test(String(ev.message ?? ''))) {
          s.status = 'waiting';
          this.onEvent({ type: 'waiting', s, message: String(ev.message ?? 'Claude ждёт ответа') });
        }
        break;
      case 'Stop':
        s.status = 'done';
        if (ev.last_assistant_message) s.final = String(ev.last_assistant_message).replace(/\s+/g, ' ').slice(0, 300);
        this.onEvent({ type: 'done', s });
        break;
      case 'StopFailure':
        s.status = 'error';
        this.onEvent({ type: 'error', s });
        break;
      case 'Interrupt':
        s.status = 'done';
        break;
      case 'SessionEnd':
        s.status = 'ended';
        break;
    }
    this.reply(reqId, '');
    this.onChange();
  }

  /** Решение по разрешению. Для вопроса «allow» без ответа не годится — используйте answer(). */
  decide(reqId: number, d: Decision): boolean {
    const p = this.pending.find((x) => x.reqId === reqId);
    if (!p) return false;
    if (p.questions && d !== 'deny') return false;
    if (d === 'always') this.addRule({ tool: p.tool, project: p.project });
    this.release(reqId, decision(d === 'deny' ? 'deny' : 'allow'));
    this.onChange();
    return true;
  }

  /** Ответ на AskUserQuestion: { «текст вопроса»: «вариант» | [«вариант», …] }. */
  answer(reqId: number, answers: Record<string, string | string[]>): boolean {
    const p = this.pending.find((x) => x.reqId === reqId);
    if (!p?.questions) return false;
    // ответ должен подходить к вопросам: каждый вопрос, только его варианты
    for (const q of p.questions) {
      const a = answers[q.question];
      const picked = Array.isArray(a) ? a : a != null ? [a] : [];
      const labels = new Set(q.options.map((o) => o.label));
      if (!picked.length || (!q.multiSelect && picked.length > 1) || picked.some((x) => !labels.has(x))) return false;
    }
    const input = this.inputs.get(reqId) ?? { questions: p.questions };
    this.release(reqId, answerJson(input, answers));
    this.onChange();
    return true;
  }

  /** Закрыть сессию вручную: её запросы уходят в терминал, пилюля исчезает. */
  close(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) return false;
    this.dropSession(sessionId);
    this.sessions.delete(sessionId);
    this.onChange();
    return true;
  }

  /** Убрать все закончившие сессии. */
  clearFinished(): number {
    let n = 0;
    for (const s of [...this.sessions.values()]) if (['done', 'ended', 'stale', 'error'].includes(s.status) && !this.pending.some((p) => p.sessionId === s.id)) {
      this.sessions.delete(s.id);
      n++;
    }
    if (n) this.onChange();
    return n;
  }

  /** Уборка по времени: вызывать раз в секунду. Возвращает true, если что-то изменилось. */
  sweep(now = this.now()): boolean {
    let changed = false;
    for (const p of [...this.pending]) {
      if (now - p.created >= TIMEOUTS.pending) {
        this.release(p.reqId, '');
        changed = true;
      }
    }
    for (const s of [...this.sessions.values()]) {
      const quiet = now - s.updated;
      const busy = this.pending.some((p) => p.sessionId === s.id);
      if (busy) continue;
      if (s.status === 'working' && quiet >= TIMEOUTS.stale) {
        s.status = 'stale';
        changed = true;
      }
      const ttl = s.status === 'ended' ? TIMEOUTS.endedRemove : s.status === 'done' || s.status === 'error' ? TIMEOUTS.doneRemove : s.status === 'stale' ? TIMEOUTS.staleRemove : Infinity;
      if (quiet >= ttl) {
        this.sessions.delete(s.id);
        changed = true;
      }
    }
    if (changed) this.onChange();
    return changed;
  }

  /** Сжатое состояние для телефона. */
  snapshot(): { sessions: Session[]; pending: Pending[] } {
    const sessions = this.active.map((s) => ({ ...s, steps: s.steps.slice(-8) }));
    return { sessions, pending: this.pending };
  }

  /** Сессии: сначала ждущие вас, потом работающие, потом остальные; внутри — по свежести. */
  get active(): Session[] {
    const rank: Record<SessionStatus, number> = { waiting: 0, working: 1, error: 2, done: 3, stale: 4, ended: 5 };
    return [...this.sessions.values()].sort((a, b) => rank[a.status] - rank[b.status] || b.updated - a.updated);
  }
}

export function decision(behavior: 'allow' | 'deny'): string {
  const d: any = { behavior };
  if (behavior === 'deny') d.message = 'Отклонено в Туке';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } });
}

/** Ответ на вопрос: тот же вход с добавленным answers (как документировано для PermissionRequest). */
export function answerJson(input: any, answers: Record<string, string | string[]>): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { ...input, answers } } } });
}

/** Время с начала сессии: «3 мин», «1 ч 5 мин». */
export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч${m % 60 ? ` ${m % 60} мин` : ''}`;
}

// ---------- Установка хуков в ~/.claude/settings.json ----------

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest']);

const isOurs = (h: any) => typeof h?.command === 'string' && h.command.includes('--hook') && /tuk/i.test(h.command);

/** Добавить наши хуки, не трогая чужие. Возвращает новый JSON. */
export function installHooks(settingsJson: string, exe: string): string {
  const cfg = settingsJson.trim() ? JSON.parse(settingsJson) : {};
  const cleaned = JSON.parse(uninstallHooks(JSON.stringify(cfg)));
  cleaned.hooks ??= {};
  const command = `"${exe}" --hook`;
  for (const ev of HOOK_EVENTS) {
    const group: any = { hooks: [{ type: 'command', command, timeout: ev === 'PermissionRequest' ? 120 : 10 }] };
    if (TOOL_EVENTS.has(ev)) group.matcher = '*';
    (cleaned.hooks[ev] ??= []).push(group);
  }
  return JSON.stringify(cleaned, null, 2);
}

/** Убрать только наши хуки. */
export function uninstallHooks(settingsJson: string): string {
  const cfg = settingsJson.trim() ? JSON.parse(settingsJson) : {};
  if (!cfg.hooks) return JSON.stringify(cfg, null, 2);
  for (const ev of Object.keys(cfg.hooks)) {
    const groups = (cfg.hooks[ev] as any[])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    if (groups.length) cfg.hooks[ev] = groups;
    else delete cfg.hooks[ev];
  }
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  return JSON.stringify(cfg, null, 2);
}

export function hooksInstalled(settingsJson: string): boolean {
  try {
    const cfg = settingsJson.trim() ? JSON.parse(settingsJson) : {};
    return Object.values(cfg.hooks ?? {}).some((groups: any) => groups.some((g: any) => (g.hooks ?? []).some(isOurs)));
  } catch {
    return false;
  }
}

// ---------- Демо: сценарий из нескольких сессий ----------

/** События для демо-режима: две параллельные сессии, правки, разрешение и вопрос. */
export function demoScript(): { at: number; body: any }[] {
  const A = { session_id: 'demo-a', cwd: 'C:\\Проекты\\shield-thermal' };
  const B = { session_id: 'demo-b', cwd: 'C:\\Проекты\\wire-marking' };
  return [
    { at: 0, body: { ...A, hook_event_name: 'SessionStart' } },
    { at: 200, body: { ...A, hook_event_name: 'UserPromptSubmit', prompt: 'Добавь расчёт вентилятора для щита 600×800' } },
    { at: 900, body: { ...A, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'src/calc.ts' } } },
    { at: 1400, body: { ...B, hook_event_name: 'UserPromptSubmit', prompt: 'Почини экспорт DXF' } },
    { at: 1900, body: { ...B, hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'exportDxf' } } },
    { at: 2600, body: { ...A, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/calc.ts', old_string: 'a\nb', new_string: 'a\nb\nc\nd' } } },
    { at: 2900, body: { ...A, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/calc.ts', old_string: 'a\nb', new_string: 'a\nb\nc\nd' } } },
    { at: 3600, body: { ...B, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } } },
    {
      at: 4400,
      body: {
        ...A, hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Какой вентилятор ставить по умолчанию?', header: 'Вентилятор', multiSelect: false, options: [{ label: 'TDM 120 мм', description: 'дешевле' }, { label: 'EKF 150 мм', description: 'тише' }] }] },
      },
    },
  ];
}
