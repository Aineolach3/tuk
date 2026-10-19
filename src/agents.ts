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
  /** Правка целиком (PostToolUse Edit/Write/MultiEdit…) — показывается по клику. На телефон не уходит. */
  diff?: FileDiff[];
}

/** Строка построчного сравнения: ' ' — без изменений, '-' — убрана, '+' — добавлена, '…' — пропуск. */
export interface DiffLine {
  t: ' ' | '-' | '+' | '…';
  s: string;
  /** Номер строки в старом / новом тексте (если известен). */
  a?: number;
  b?: number;
}
export interface FileDiff {
  file: string;
  lines: DiffLine[];
  /** Сравнение обрезано (слишком большая правка). */
  cut?: boolean;
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
  /** ПК: процессы-предки хука (ближайший первым) и окно консоли — для «Перейти в терминал». */
  pids?: number[];
  console?: number;
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
  // Claude Code, Gemini CLI (read_file, replace, run_shell_command…), Codex (shell, apply_patch)
  if (/^(Read|NotebookRead|LS|view_file|read_file|read_many_files|list_directory)$/.test(tool)) return 'read';
  if (/^(Edit|MultiEdit|Write|NotebookEdit|write_to_file|replace_file_content|replace|write_file|apply_patch|edit)$/.test(tool)) return 'edit';
  if (/^(Bash|BashOutput|KillShell|PowerShell|run_command|run_shell_command|shell|local_shell|exec_command)$/.test(tool)) return 'run';
  if (/^(Grep|Glob|glob|search_file_content|grep)$/.test(tool)) return 'search';
  if (/^(WebFetch|WebSearch|search_web|read_url_content|web_fetch|google_web_search)$/.test(tool)) return 'web';
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
      if (tool === 'apply_patch') return patchFiles(patchText(i)).map(base).join(', ').slice(0, 160) || tool;
      return base(i.file_path ?? i.notebook_path ?? i.absolute_path ?? i.path ?? '') || tool;
    case 'run':
      return String(Array.isArray(i.command) ? i.command.join(' ') : i.command ?? i.cmd ?? i.description ?? tool).slice(0, 160);
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
  // Gemini CLI: write_file / replace; Codex: apply_patch
  if (tool === 'write_file') return { plus: lines(input?.content), minus: 0 };
  if (tool === 'replace') return { plus: lines(input?.new_string), minus: lines(input?.old_string) };
  if (tool === 'apply_patch') {
    const d = patchDiffs(patchText(input));
    if (!d.length) return null;
    return d.reduce((a, f) => ({ plus: a.plus + f.lines.filter((l) => l.t === '+').length, minus: a.minus + f.lines.filter((l) => l.t === '-').length }), { plus: 0, minus: 0 });
  }
  return null;
}

// ---------- Полный diff правки ----------

/** Предел на одну правку: больше — сравнение обрезается (память и перерисовка). */
export const DIFF_MAX_CHARS = 60_000;
const CONTEXT = 3;

const splitLines = (s: string): string[] => (s ? s.replace(/\r\n/g, '\n').split('\n') : []);

/**
 * Построчное сравнение (наибольшая общая подпоследовательность). Возвращает все строки;
 * сжать неизменённые участки — compact(). Слишком большие тексты — «всё убрано, всё добавлено».
 */
export function lineDiff(oldText: string, newText: string, startA = 1, startB = 1): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  // общие начало и конец — без таблицы
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const out: DiffLine[] = [];
  for (let i = 0; i < pre; i++) out.push({ t: ' ', s: a[i], a: startA + i, b: startB + i });
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  if (n * m > 1_000_000) {
    A.forEach((s, i) => out.push({ t: '-', s, a: startA + pre + i }));
    B.forEach((s, j) => out.push({ t: '+', s, b: startB + pre + j }));
  } else {
    // L[i][j] — длина общей подпоследовательности A[i..] и B[j..]
    const L = new Uint32Array((n + 1) * (m + 1));
    const w = m + 1;
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) {
        out.push({ t: ' ', s: A[i], a: startA + pre + i, b: startB + pre + j });
        i++;
        j++;
      } else if (i < n && (j >= m || L[(i + 1) * w + j] >= L[i * w + j + 1])) {
        // при равенстве сначала убранная строка, потом добавленная — как в git diff
        out.push({ t: '-', s: A[i], a: startA + pre + i });
        i++;
      } else {
        out.push({ t: '+', s: B[j], b: startB + pre + j });
        j++;
      }
    }
  }
  for (let k = 0; k < suf; k++) out.push({ t: ' ', s: a[a.length - suf + k], a: startA + a.length - suf + k, b: startB + b.length - suf + k });
  return out;
}

/** Оставить у изменений по 3 строки контекста, остальное — строкой «…». */
export function compact(lines: DiffLine[], ctx = CONTEXT): DiffLine[] {
  const keep = new Uint8Array(lines.length);
  lines.forEach((l, i) => {
    if (l.t === '+' || l.t === '-') for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) keep[k] = 1;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ t: '…', s: `${skipped} без изменений` });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ t: '…', s: `${skipped} без изменений` });
  return out;
}

/** Текст патча Codex (apply_patch): строка или { input | patch }. */
function patchText(input: any): string {
  if (typeof input === 'string') return input;
  const v = input?.input ?? input?.patch ?? input?.command;
  if (Array.isArray(v)) return v.find((x: unknown) => typeof x === 'string' && x.includes('*** Begin Patch')) ?? '';
  return typeof v === 'string' ? v : '';
}

function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
}

/** Разбор патча Codex: *** Update/Add/Delete File: путь, затем строки « », «-», «+», «@@». */
export function patchDiffs(patch: string): FileDiff[] {
  const out: FileDiff[] = [];
  let cur: FileDiff | null = null;
  for (const raw of splitLines(patch)) {
    const head = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(raw);
    if (head) {
      cur = { file: head[2].trim(), lines: [] };
      out.push(cur);
      continue;
    }
    if (!cur || raw.startsWith('*** ')) continue;
    if (raw.startsWith('@@')) cur.lines.push({ t: '…', s: raw.replace(/^@@\s?/, '').trim() || '…' });
    else if (raw[0] === '+' || raw[0] === '-' || raw[0] === ' ') cur.lines.push({ t: raw[0] as DiffLine['t'], s: raw.slice(1) });
  }
  return out;
}

/** structuredPatch из ответа инструмента Claude Code (tool_response) — с настоящими номерами строк. */
function structuredDiff(file: string, hunks: any): FileDiff | null {
  if (!Array.isArray(hunks) || !hunks.length) return null;
  const lines: DiffLine[] = [];
  for (const h of hunks) {
    if (!Array.isArray(h?.lines)) return null;
    let a = +h.oldStart || 1;
    let b = +h.newStart || 1;
    if (lines.length) lines.push({ t: '…', s: '' });
    for (const l of h.lines) {
      if (typeof l !== 'string') continue;
      const t = l[0];
      if (t === '-') lines.push({ t: '-', s: l.slice(1), a: a++ });
      else if (t === '+') lines.push({ t: '+', s: l.slice(1), b: b++ });
      else if (t === ' ') lines.push({ t: ' ', s: l.slice(1), a: a++, b: b++ });
    }
  }
  return { file, lines };
}

/** Обрезать сравнение по размеру. */
function capDiff(d: FileDiff): FileDiff {
  let total = 0;
  const lines: DiffLine[] = [];
  for (const l of d.lines) {
    total += l.s.length + 1;
    if (total > DIFF_MAX_CHARS) return { ...d, lines, cut: true };
    lines.push(l.s.length > 2000 ? { ...l, s: l.s.slice(0, 2000) + '…' } : l);
  }
  return { ...d, lines };
}

/** Полный diff правки из события хука (PostToolUse): Edit, MultiEdit, Write и аналоги Gemini/Codex. */
export function editDiff(tool: string, input: any, response?: any): FileDiff[] | null {
  const i = input ?? {};
  const file = String(i.file_path ?? i.absolute_path ?? i.path ?? '');
  const long = (s: unknown) => typeof s === 'string' && s.length > DIFF_MAX_CHARS * 4;
  let out: FileDiff[] | null = null;
  const sp = structuredDiff(file, response?.structuredPatch);
  if (sp && (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write')) out = [sp];
  else if (tool === 'Edit' || tool === 'replace') {
    if (typeof i.old_string !== 'string' || typeof i.new_string !== 'string') return null;
    if (long(i.old_string) || long(i.new_string)) return null;
    out = [{ file, lines: lineDiff(i.old_string, i.new_string) }];
  } else if (tool === 'MultiEdit' && Array.isArray(i.edits)) {
    const lines: DiffLine[] = [];
    for (const e of i.edits) {
      if (typeof e?.old_string !== 'string' || typeof e?.new_string !== 'string' || long(e.old_string) || long(e.new_string)) continue;
      if (lines.length) lines.push({ t: '…', s: '' });
      lines.push(...lineDiff(e.old_string, e.new_string));
    }
    out = lines.length ? [{ file, lines }] : null;
  } else if (tool === 'Write' || tool === 'write_file') {
    if (typeof i.content !== 'string' || long(i.content)) return null;
    const before = typeof response?.originalFile === 'string' && !long(response.originalFile) ? response.originalFile : '';
    out = [{ file, lines: lineDiff(before, i.content) }];
  } else if (tool === 'apply_patch') {
    const d = patchDiffs(patchText(i));
    out = d.length ? d : null;
  }
  if (!out) return null;
  // у фрагмента Edit номера строк считаются от начала фрагмента, а не файла — не показываем их
  const relative = !sp && (tool === 'Edit' || tool === 'replace' || tool === 'MultiEdit');
  return out.map((d) => {
    let lines = d.lines.some((l) => l.a != null || l.b != null) ? compact(d.lines) : d.lines;
    if (relative) lines = lines.map(({ t, s }) => ({ t, s }));
    return capDiff({ ...d, lines });
  });
}

/** Имена событий других агентов → имена Claude Code (как в ретрансляторе Coucou). */
export function canonicalEvent(name: string): string {
  const MAP: Record<string, string> = {
    BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse', BeforeAgent: 'UserPromptSubmit', AfterAgent: 'Stop',
    pre_tool_use: 'PreToolUse', post_tool_use: 'PostToolUse', user_prompt_submit: 'UserPromptSubmit',
    session_start: 'SessionStart', session_end: 'SessionEnd', stop: 'Stop',
  };
  return MAP[name] ?? name;
}

/** Поля события другого агента под имена Claude Code (tool_name, tool_input). Вход не меняется. */
export function normalizeEvent(ev: any): any {
  const e = { ...ev };
  e.hook_event_name = canonicalEvent(String(ev.tuk_event || ev.hook_event_name || ''));
  e.tool_name ??= ev.toolName ?? ev.toolCall?.name ?? (typeof ev.tool === 'string' ? ev.tool : undefined);
  if (e.tool_input == null) {
    const a = ev.toolArgs ?? ev.toolCall?.args;
    if (a && typeof a === 'object') e.tool_input = a;
    else if (typeof a === 'string') {
      try {
        e.tool_input = JSON.parse(a);
      } catch {
        /* не JSON */
      }
    }
  }
  if (e.prompt == null && typeof ev.user_prompt === 'string') e.prompt = ev.user_prompt;
  return e;
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
  /** Убирать закончившие и зависшие сессии самим (ждущие запросы уходят по таймауту всегда). */
  autoClean = true;
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
    // откуда пришло событие (Tuk.exe --hook на Windows): для «Перейти в терминал»
    if (Array.isArray(ev.tuk_pids) && ev.tuk_pids.length) s.pids = ev.tuk_pids.filter((x: unknown) => Number.isInteger(x) && (x as number) > 0).slice(0, 16);
    const con = Number(ev.tuk_console);
    if (Number.isSafeInteger(con) && con !== 0) s.console = con;
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
      ev = normalizeEvent(JSON.parse(body));
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
          const diff = editDiff(ev.tool_name, ev.tool_input, ev.tool_response) ?? undefined;
          if (last) Object.assign(last, d, diff ? { diff } : {});
          else s.steps.push({ t: this.now(), kind: 'edit', text, ...d, ...(diff ? { diff } : {}) });
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
      if (this.autoClean && quiet >= ttl) {
        this.sessions.delete(s.id);
        changed = true;
      }
    }
    if (changed) this.onChange();
    return changed;
  }

  /** Сжатое состояние для телефона. */
  snapshot(): { sessions: Session[]; pending: Pending[] } {
    // без полных diff и процессов: телефон опрашивает часто, ему хватает +N/−M
    const sessions = this.active.map(({ pids, console, ...s }) => {
      void pids;
      void console;
      return { ...s, steps: s.steps.slice(-8).map(({ diff, ...st }) => (void diff, st)) };
    });
    return { sessions, pending: this.pending };
  }

  /** Шаг сессии по индексу (для «показать правку»). */
  step(sessionId: string, index: number): Step | undefined {
    return this.sessions.get(sessionId)?.steps[index];
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

// ---------- Хуки Codex CLI и Gemini CLI ----------
// По образцу Coucou (MIT): windows/src-tauri/src/agents.rs и docs/AGENTS.md.
// Codex — ~/.codex/hooks.json: группы без matcher, таймауты в секундах, команды через cmd /C;
// новые хуки Codex запускает только после доверия (/hooks в Codex).
// Gemini CLI — ~/.gemini/settings.json: matcher «*», таймауты в миллисекундах, команды
// через PowerShell; имя события передаём аргументом (BeforeTool → PreToolUse и т. д.).

export type HookAgent = 'codex' | 'gemini';

export const CODEX_EVENTS: [string, number][] = [
  ['SessionStart', 10], ['UserPromptSubmit', 10], ['PreToolUse', 10], ['PermissionRequest', 120], ['PostToolUse', 10],
  ['Stop', 10], ['SubagentStart', 10], ['SubagentStop', 10], ['Interrupt', 3], ['SessionEnd', 3],
];
export const GEMINI_EVENTS: [string, string, number][] = [
  ['SessionStart', 'SessionStart', 10000], ['SessionEnd', 'SessionEnd', 10000], ['BeforeTool', 'PreToolUse', 5000],
  ['AfterTool', 'PostToolUse', 5000], ['BeforeAgent', 'UserPromptSubmit', 5000], ['AfterAgent', 'Stop', 5000],
];
export const AGENT_HOOK_INFO: Record<HookAgent, { name: string; file: string; note: string }> = {
  codex: { name: 'Codex CLI', file: '~/.codex/hooks.json', note: 'Codex запускает новые хуки только после доверия: откройте Codex и один раз подтвердите их командой /hooks.' },
  gemini: { name: 'Gemini CLI', file: '~/.gemini/settings.json', note: 'Начните новую сессию Gemini CLI — хуки подхватятся.' },
};

const isOursFor = (agent: HookAgent) => (h: any) => isOurs(h) && h.command.includes(`--agent ${agent}`);

/** Команда хука: Codex — cmd /C (путь в кавычках), Gemini — PowerShell (& 'путь'). */
export function agentHookCommand(agent: HookAgent, exe: string, event = ''): string {
  if (agent === 'gemini') return `& '${exe.replace(/'/g, "''")}' --hook --agent gemini${event ? ' ' + event : ''}`;
  return `"${exe}" --hook --agent codex`;
}

/** Добавить хуки Codex / Gemini, не трогая чужие. */
export function installAgentHooks(agent: HookAgent, json: string, exe: string): string {
  const cfg = JSON.parse(uninstallAgentHooks(agent, json));
  cfg.hooks ??= {};
  if (agent === 'codex')
    for (const [ev, timeout] of CODEX_EVENTS) {
      const hook: any = { type: 'command', command: agentHookCommand('codex', exe), timeout };
      if (ev === 'PermissionRequest') hook.statusMessage = 'Ждёт вашего ответа в Туке';
      (cfg.hooks[ev] ??= []).push({ hooks: [hook] });
    }
  else
    for (const [ev, said, timeout] of GEMINI_EVENTS)
      (cfg.hooks[ev] ??= []).push({ matcher: '*', hooks: [{ type: 'command', command: agentHookCommand('gemini', exe, said), timeout }] });
  return JSON.stringify(cfg, null, 2);
}

export function uninstallAgentHooks(agent: HookAgent, json: string): string {
  const cfg = json.trim() ? JSON.parse(json) : {};
  if (!cfg.hooks || typeof cfg.hooks !== 'object') return JSON.stringify(cfg, null, 2);
  const ours = isOursFor(agent);
  for (const ev of Object.keys(cfg.hooks)) {
    if (!Array.isArray(cfg.hooks[ev])) continue;
    const groups = (cfg.hooks[ev] as any[]).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !ours(h)) })).filter((g) => g.hooks.length);
    if (groups.length) cfg.hooks[ev] = groups;
    else delete cfg.hooks[ev];
  }
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  return JSON.stringify(cfg, null, 2);
}

export function agentHooksInstalled(agent: HookAgent, json: string): boolean {
  try {
    const cfg = json.trim() ? JSON.parse(json) : {};
    const ours = isOursFor(agent);
    return Object.values(cfg.hooks ?? {}).some((groups: any) => Array.isArray(groups) && groups.some((g: any) => (g.hooks ?? []).some(ours)));
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

// ---------- Показ правки и окно терминала (интерфейс) ----------

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** HTML построчного сравнения: номера строк, знак, строка; убранные — красным, добавленные — зелёным. */
export function diffHtml(diffs: FileDiff[]): string {
  return diffs
    .map((d) => {
      const plus = d.lines.filter((l) => l.t === '+').length;
      const minus = d.lines.filter((l) => l.t === '-').length;
      const rows = d.lines
        .map((l) => {
          if (l.t === '…') return `<tr class="dl-gap"><td colspan="3">${escHtml(l.s || '⋯')}</td></tr>`;
          const cls = l.t === '+' ? 'dl-add' : l.t === '-' ? 'dl-del' : 'dl-ctx';
          const num = l.t === '+' ? l.b : l.a;
          return `<tr class="${cls}"><td class="dl-n">${num ?? ''}</td><td class="dl-m">${l.t === ' ' ? '' : l.t === '-' ? '−' : '+'}</td><td class="dl-s">${escHtml(l.s) || ' '}</td></tr>`;
        })
        .join('');
      return `<div class="diff"><div class="diff-h"><b>${escHtml(base(d.file) || d.file || 'файл')}</b> <span class="plus">+${plus}</span> <span class="minus">−${minus}</span><span class="muted small diff-path">${escHtml(d.file)}</span></div>
        <div class="diff-b"><table>${rows}</table></div>${d.cut ? '<p class="muted small">Правка большая — показано начало.</p>' : ''}</div>`;
    })
    .join('');
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const tauriInvoke = (cmd: string, args?: Record<string, unknown>): Promise<any> => {
  const T = (globalThis as any).__TAURI__;
  return T ? T.core.invoke(cmd, args) : Promise.reject(new Error('Только в приложении на ПК'));
};

/** Файл хуков агента: прочитать (json не задан) или записать. */
export const agentConfig = (agent: HookAgent, json?: string): Promise<string> => tauriInvoke('agent_config', { agent, json: json ?? null });

/** Перейти в окно терминала сессии; если окно не найдено — открыть папку проекта. */
export async function focusTerminal(s: Pick<Session, 'pids' | 'console' | 'cwd'>): Promise<'window' | 'folder'> {
  return tauriInvoke('focus_terminal', { pids: s.pids ?? [], console: s.console ?? 0, cwd: s.cwd ?? '' });
}
