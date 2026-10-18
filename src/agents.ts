// Слежение за Claude Code: хуки присылают события на ПК (Tuk.exe --hook → /hook),
// Тук показывает шаги агента и просит разрешения прямо в строке — на ПК и на телефоне.

/* eslint-disable @typescript-eslint/no-explicit-any */

export type StepKind = 'read' | 'edit' | 'run' | 'search' | 'web' | 'task' | 'other';

export interface Step {
  t: number;
  kind: StepKind;
  text: string;
  plus?: number;
  minus?: number;
}

export interface Session {
  id: string;
  agent: string;
  project: string;
  cwd: string;
  prompt?: string;
  steps: Step[];
  status: 'working' | 'waiting' | 'done' | 'ended';
  updated: number;
}

export interface Pending {
  reqId: number;
  sessionId: string;
  project: string;
  tool: string;
  summary: string;
  created: number;
}

export interface Rule {
  tool: string;
  project: string;
}

export const KIND_LABEL: Record<StepKind, string> = {
  read: 'читает', edit: 'правит', run: 'запускает', search: 'ищет', web: 'в интернете', task: 'поручение', other: 'делает',
};

const base = (p: string) => (p || '').split(/[\\/]/).filter(Boolean).pop() ?? p;

export function kindOf(tool: string): StepKind {
  if (/^(Read|NotebookRead|LS)$/.test(tool)) return 'read';
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return 'edit';
  if (/^(Bash|BashOutput|KillShell|PowerShell)$/.test(tool)) return 'run';
  if (/^(Grep|Glob)$/.test(tool)) return 'search';
  if (/^(WebFetch|WebSearch)$/.test(tool)) return 'web';
  if (/^(Task|Agent|TodoWrite)$/.test(tool)) return 'task';
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

export type HubEvent =
  | { type: 'permission'; p: Pending }
  | { type: 'done'; s: Session }
  | { type: 'waiting'; s: Session; message: string };

export class AgentHub {
  sessions = new Map<string, Session>();
  pending: Pending[] = [];
  onChange: () => void = () => {};
  onEvent: (e: HubEvent) => void = () => {};
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(
    private reply: (reqId: number, body: string) => void,
    private rules: () => Rule[],
    private addRule: (r: Rule) => void,
  ) {}

  private session(ev: any): Session {
    const id = String(ev.session_id ?? 'default');
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, agent: 'Claude Code', cwd: ev.cwd ?? '', project: base(ev.cwd ?? '') || 'проект', steps: [], status: 'working', updated: Date.now() };
      this.sessions.set(id, s);
    }
    if (ev.cwd) {
      s.cwd = ev.cwd;
      s.project = base(ev.cwd) || s.project;
    }
    s.updated = Date.now();
    return s;
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
    switch (name) {
      case 'UserPromptSubmit':
        s.prompt = String(ev.prompt ?? '').slice(0, 300);
        s.status = 'working';
        s.steps = [];
        break;
      case 'PreToolUse':
        s.status = 'working';
        s.steps.push({ t: Date.now(), kind: kindOf(ev.tool_name), text: summarize(ev.tool_name, ev.tool_input) });
        if (s.steps.length > 60) s.steps.splice(0, s.steps.length - 60);
        break;
      case 'PostToolUse': {
        const d = diffCount(ev.tool_name, ev.tool_input);
        const last = [...s.steps].reverse().find((x) => x.text === summarize(ev.tool_name, ev.tool_input));
        if (d && last) Object.assign(last, d);
        break;
      }
      case 'PermissionRequest': {
        const tool = String(ev.tool_name ?? 'инструмент');
        if (this.rules().some((r) => r.tool === tool && r.project === s.project)) {
          this.reply(reqId, decision('allow'));
          this.onChange();
          return;
        }
        const p: Pending = { reqId, sessionId: s.id, project: s.project, tool, summary: summarize(tool, ev.tool_input), created: Date.now() };
        s.status = 'waiting';
        this.pending.push(p);
        // никто не ответил — пусть Claude Code спросит в терминале как обычно
        this.timers.set(reqId, setTimeout(() => this.drop(reqId), 110_000));
        this.onEvent({ type: 'permission', p });
        this.onChange();
        return;
      }
      case 'Notification':
        if (/idle|input|permission/.test(String(ev.notification_type ?? ''))) {
          s.status = 'waiting';
          this.onEvent({ type: 'waiting', s, message: String(ev.message ?? 'Claude ждёт ответа') });
        }
        break;
      case 'Stop':
        s.status = 'done';
        this.onEvent({ type: 'done', s });
        break;
      case 'SessionEnd':
        s.status = 'ended';
        setTimeout(() => {
          if (this.sessions.get(s.id)?.status === 'ended') {
            this.sessions.delete(s.id);
            this.onChange();
          }
        }, 10 * 60_000);
        break;
    }
    this.reply(reqId, '');
    this.onChange();
  }

  decide(reqId: number, d: 'allow' | 'deny' | 'always'): boolean {
    const i = this.pending.findIndex((p) => p.reqId === reqId);
    if (i < 0) return false;
    const p = this.pending[i];
    this.pending.splice(i, 1);
    clearTimeout(this.timers.get(reqId));
    this.timers.delete(reqId);
    if (d === 'always') this.addRule({ tool: p.tool, project: p.project });
    this.reply(reqId, decision(d === 'deny' ? 'deny' : 'allow'));
    const s = this.sessions.get(p.sessionId);
    if (s && !this.pending.some((x) => x.sessionId === s.id)) s.status = 'working';
    this.onChange();
    return true;
  }

  private drop(reqId: number) {
    const i = this.pending.findIndex((p) => p.reqId === reqId);
    if (i >= 0) this.pending.splice(i, 1);
    this.reply(reqId, '');
    this.onChange();
  }

  /** Сжатое состояние для телефона. */
  snapshot(): { sessions: Session[]; pending: Pending[] } {
    const sessions = [...this.sessions.values()].map((s) => ({ ...s, steps: s.steps.slice(-8) }));
    return { sessions, pending: this.pending };
  }

  get active(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.updated - a.updated);
  }
}

export function decision(behavior: 'allow' | 'deny'): string {
  const d: any = { behavior };
  if (behavior === 'deny') d.message = 'Отклонено в Туке';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } });
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
