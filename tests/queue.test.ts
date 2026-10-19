import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentHub, TIMEOUTS, SESSION_COLORS, askedQuestions, demoScript, type Rule } from '../src/agents.ts';

function setup() {
  let now = 1_000_000;
  const replies: [number, string][] = [];
  const rules: Rule[] = [];
  const events: string[] = [];
  const hub = new AgentHub((id, b) => replies.push([id, b]), () => rules, (r) => rules.push(r), () => now);
  hub.onEvent = (e) => events.push(e.type);
  const ev = (sid: string, cwd: string) => (o: object) => JSON.stringify({ session_id: sid, cwd, ...o });
  return { hub, replies, rules, events, ev, tick: (ms: number) => (now += ms), get now() { return now; } };
}
const behavior = (b: string) => JSON.parse(b).hookSpecificOutput.decision.behavior;
const Q = {
  questions: [
    { question: 'Какой цвет?', header: 'Цвет', multiSelect: false, options: [{ label: 'Красный' }, { label: 'Синий' }] },
    { question: 'Что добавить?', multiSelect: true, options: [{ label: 'Тесты' }, { label: 'Документацию' }, { label: 'Логи' }] },
  ],
};

test('очередь: запросы трёх сессий не путаются и отвечаются по своим reqId', () => {
  const { hub, replies, ev } = setup();
  const a = ev('a', '/p/alpha'), b = ev('b', '/p/beta'), c = ev('c', '/p/gamma');
  hub.handle(1, a({ hook_event_name: 'UserPromptSubmit', prompt: 'x' }));
  hub.handle(2, b({ hook_event_name: 'UserPromptSubmit', prompt: 'y' }));
  hub.handle(10, a({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm a' } }));
  hub.handle(11, b({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm b' } }));
  hub.handle(12, c({ hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: '/p/gamma/x.ts' } }));
  assert.deepEqual(hub.pending.map((p) => [p.reqId, p.project]), [[10, 'alpha'], [11, 'beta'], [12, 'gamma']]);
  // отвечаем не по порядку
  assert.ok(hub.decide(11, 'deny'));
  assert.ok(hub.decide(12, 'allow'));
  assert.equal(behavior(replies.find((r) => r[0] === 11)![1]), 'deny');
  assert.equal(behavior(replies.find((r) => r[0] === 12)![1]), 'allow');
  assert.equal(replies.filter((r) => r[0] === 10).length, 0, 'запрос alpha всё ещё ждёт');
  assert.deepEqual(hub.pending.map((p) => p.reqId), [10]);
  assert.equal(hub.sessions.get('a')!.status, 'waiting');
  assert.equal(hub.sessions.get('b')!.status, 'working');
  // повторное решение по тому же запросу ничего не делает
  assert.equal(hub.decide(11, 'allow'), false);
  assert.equal(replies.filter((r) => r[0] === 11).length, 1);
});

test('у одновременных сессий разные цвета; Codex — свой цвет и своя пилюля', () => {
  const { hub, ev } = setup();
  for (let i = 0; i < 4; i++) hub.handle(i, ev('s' + i, '/p/' + i)({ hook_event_name: 'SessionStart' }));
  const colors = [...hub.sessions.values()].map((s) => s.color);
  assert.equal(new Set(colors).size, 4);
  assert.ok(colors.every((c) => SESSION_COLORS.includes(c!)));
  hub.handle(9, JSON.stringify({ session_id: 's0', cwd: '/p/0', hook_event_name: 'SessionStart', tuk_agent: 'codex' }));
  assert.equal(hub.sessions.size, 5, 'тот же session_id у другого агента — другая сессия');
  assert.equal(hub.sessions.get('codex:s0')!.agent, 'Codex');
});

test('конец хода снимает ждущий запрос этой сессии, но не чужой', () => {
  const { hub, replies, ev } = setup();
  const a = ev('a', '/p/alpha'), b = ev('b', '/p/beta');
  hub.handle(10, a({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'x' } }));
  hub.handle(11, b({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'y' } }));
  hub.handle(12, a({ hook_event_name: 'Stop' })); // ответили в терминале
  assert.deepEqual(replies.find((r) => r[0] === 10), [10, ''], 'отпущен без решения');
  assert.deepEqual(hub.pending.map((p) => p.reqId), [11]);
  assert.equal(hub.sessions.get('a')!.status, 'done');
});

test('AskUserQuestion: варианты, проверка ответа и updatedInput', () => {
  const { hub, replies, ev, events } = setup();
  const a = ev('a', '/p/alpha');
  hub.handle(20, a({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: Q }));
  const p = hub.pending[0];
  assert.equal(p.questions?.length, 2);
  assert.equal(p.questions![1].multiSelect, true);
  assert.deepEqual(events, ['permission']);
  // «разрешить» вопрос нельзя — только ответить или отказать
  assert.equal(hub.decide(20, 'allow'), false);
  // неверные ответы отвергаются
  assert.equal(hub.answer(20, { 'Какой цвет?': 'Зелёный', 'Что добавить?': ['Тесты'] }), false);
  assert.equal(hub.answer(20, { 'Какой цвет?': ['Красный', 'Синий'], 'Что добавить?': ['Тесты'] }), false);
  assert.equal(hub.answer(20, { 'Какой цвет?': 'Красный' }), false);
  assert.ok(hub.answer(20, { 'Какой цвет?': 'Синий', 'Что добавить?': ['Тесты', 'Логи'] }));
  const out = JSON.parse(replies.find((r) => r[0] === 20)![1]).hookSpecificOutput.decision;
  assert.equal(out.behavior, 'allow');
  assert.deepEqual(out.updatedInput.questions, Q.questions);
  assert.deepEqual(out.updatedInput.answers, { 'Какой цвет?': 'Синий', 'Что добавить?': ['Тесты', 'Логи'] });
  assert.equal(hub.pending.length, 0);
});

test('вопрос, на который ответили в терминале, исчезает (PostToolUse)', () => {
  const { hub, replies, ev } = setup();
  const a = ev('a', '/p/alpha');
  hub.handle(20, a({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: Q }));
  hub.handle(21, a({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: Q }));
  assert.equal(hub.pending.length, 0);
  assert.deepEqual(replies.find((r) => r[0] === 20), [20, '']);
  assert.equal(askedQuestions('AskUserQuestion', { questions: [{ question: 'Один вариант?', options: [{ label: 'да' }] }] }), null);
});

test('таймауты: запрос уходит в терминал, зависшие и закончившие сессии убираются', () => {
  const s = setup();
  const { hub, replies, ev } = s;
  const a = ev('a', '/p/alpha'), b = ev('b', '/p/beta'), c = ev('c', '/p/gamma');
  hub.handle(1, a({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'x' } }));
  hub.handle(2, b({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'x' } }));
  hub.handle(3, c({ hook_event_name: 'Stop' }));
  s.tick(TIMEOUTS.pending);
  assert.ok(hub.sweep(s.now));
  assert.deepEqual(replies.find((r) => r[0] === 1), [1, '']);
  assert.equal(hub.pending.length, 0);
  s.tick(TIMEOUTS.stale);
  hub.sweep(s.now);
  assert.equal(hub.sessions.get('b')!.status, 'stale');
  s.tick(TIMEOUTS.doneRemove);
  hub.sweep(s.now);
  assert.ok(!hub.sessions.has('c'), 'закончившая убрана');
  // новое событие оживляет «молчащую»
  hub.handle(4, b({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }));
  assert.equal(hub.sessions.get('b')!.status, 'working');
  hub.handle(5, b({ hook_event_name: 'SessionEnd' }));
  s.tick(TIMEOUTS.endedRemove);
  hub.sweep(s.now);
  assert.ok(!hub.sessions.has('b'));
});

test('ручное закрытие и очистка закончивших', () => {
  const { hub, replies, ev } = setup();
  const a = ev('a', '/p/alpha'), b = ev('b', '/p/beta');
  hub.handle(1, a({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'x' } }));
  hub.handle(2, b({ hook_event_name: 'Stop' }));
  assert.ok(hub.close('a'));
  assert.deepEqual(replies.find((r) => r[0] === 1), [1, '']);
  assert.equal(hub.sessions.has('a'), false);
  assert.equal(hub.clearFinished(), 1);
  assert.equal(hub.sessions.size, 0);
});

test('+N/−M копятся за запрос; порядок: ждущие наверху', () => {
  const { hub, ev } = setup();
  const a = ev('a', '/p/alpha'), b = ev('b', '/p/beta');
  const edit = { file_path: 'x.ts', old_string: 'a', new_string: 'a\nb\nc' };
  hub.handle(1, a({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: edit }));
  hub.handle(2, a({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: edit }));
  hub.handle(3, a({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'y.ts', content: '1\n2' } }));
  const s = hub.sessions.get('a')!;
  assert.deepEqual([s.plus, s.minus], [5, 1]);
  assert.equal(s.steps.length, 2);
  hub.handle(4, b({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'x' } }));
  assert.equal(hub.active[0].id, 'b');
  hub.handle(5, a({ hook_event_name: 'UserPromptSubmit', prompt: 'дальше' }));
  assert.deepEqual([s.plus, s.minus], [0, 0]);
});

test('демо-сценарий проходит без ошибок', () => {
  const { hub } = setup();
  for (const [i, e] of demoScript().entries()) hub.handle(100 + i, JSON.stringify(e.body));
  assert.equal(hub.sessions.size, 2);
  assert.equal(hub.pending.length, 2);
  assert.ok(hub.pending.some((p) => p.questions));
});
