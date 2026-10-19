import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentHub, decision, diffCount, hooksInstalled, installHooks, summarize, uninstallHooks, type Rule } from '../src/agents.ts';

const EXE = 'C:\\Program Files\\Tuk\\Tuk.exe';

test('установка хуков сохраняет чужие настройки и хуки', () => {
  const mine = JSON.stringify({
    model: 'opus',
    permissions: { allow: ['Bash(npm test)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-check.sh' }] }] },
  });
  const out = JSON.parse(installHooks(mine, EXE));
  assert.equal(out.model, 'opus');
  assert.deepEqual(out.permissions.allow, ['Bash(npm test)']);
  assert.equal(out.hooks.PreToolUse.length, 2);
  assert.equal(out.hooks.PreToolUse[0].hooks[0].command, 'my-check.sh');
  assert.equal(out.hooks.PermissionRequest[0].hooks[0].command, `"${EXE}" --hook`);
  assert.equal(out.hooks.PermissionRequest[0].matcher, '*');
  assert.equal(out.hooks.Stop[0].matcher, undefined);
  assert.ok(hooksInstalled(JSON.stringify(out)));
  // повторная установка не дублирует
  const twice = JSON.parse(installHooks(JSON.stringify(out), EXE));
  assert.equal(twice.hooks.PreToolUse.length, 2);
  // удаление оставляет чужое
  const back = JSON.parse(uninstallHooks(JSON.stringify(twice)));
  assert.deepEqual(back.hooks, { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-check.sh' }] }] });
  assert.ok(!hooksInstalled(JSON.stringify(back)));
  // пустой файл
  assert.ok(hooksInstalled(installHooks('', EXE)));
  assert.deepEqual(JSON.parse(uninstallHooks(installHooks('', EXE))), {});
});

test('описания шагов и правки', () => {
  assert.equal(summarize('Read', { file_path: 'C:\\proj\\src\\app.ts' }), 'app.ts');
  assert.equal(summarize('Bash', { command: 'npm test' }), 'npm test');
  assert.equal(summarize('mcp__github__create_issue', {}), 'github · create_issue');
  assert.deepEqual(diffCount('Edit', { old_string: 'a\nb', new_string: 'a\nb\nc' }), { plus: 3, minus: 2 });
  assert.deepEqual(diffCount('Write', { content: 'x\ny' }), { plus: 2, minus: 0 });
});

test('разрешение: ждём решения, «всегда» запоминается', () => {
  const replies: [number, string][] = [];
  const rules: Rule[] = [];
  const events: string[] = [];
  const hub = new AgentHub((id, b) => replies.push([id, b]), () => rules, (r) => rules.push(r));
  hub.onEvent = (e) => events.push(e.type);
  const ev = (o: object) => JSON.stringify({ session_id: 's1', cwd: '/home/u/shield', ...o });
  hub.handle(1, ev({ hook_event_name: 'UserPromptSubmit', prompt: 'почини тесты' }));
  hub.handle(2, ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  hub.handle(3, ev({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } }));
  assert.deepEqual(replies.map((r) => r[0]), [1, 2]); // на запрос разрешения пока не ответили
  assert.equal(hub.pending.length, 1);
  assert.equal(hub.active[0].project, 'shield');
  assert.equal(hub.active[0].status, 'waiting');
  hub.decide(3, 'deny');
  assert.equal(JSON.parse(replies.at(-1)![1]).hookSpecificOutput.decision.behavior, 'deny');
  hub.handle(4, ev({ hook_event_name: 'PermissionRequest', tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }));
  hub.decide(4, 'always');
  assert.deepEqual(rules, [{ tool: 'Edit', project: 'shield' }]);
  // следующий такой же запрос — разрешён сразу
  hub.handle(5, ev({ hook_event_name: 'PermissionRequest', tool_name: 'Edit', tool_input: { file_path: 'b.ts' } }));
  assert.equal(JSON.parse(replies.at(-1)![1]).hookSpecificOutput.decision.behavior, 'allow');
  assert.equal(hub.pending.length, 0);
  hub.handle(6, ev({ hook_event_name: 'Stop' }));
  assert.deepEqual(events, ['permission', 'permission', 'done']);
  assert.equal(JSON.parse(decision('allow')).hookSpecificOutput.hookEventName, 'PermissionRequest');
});

test('полный diff правки: Edit, MultiEdit, Write, structuredPatch, патч Codex', async () => {
  const { lineDiff, compact, editDiff, patchDiffs } = await import('../src/agents.ts');
  const d = lineDiff('a\nb\nc', 'a\nB\nc\nd');
  assert.deepEqual(d.map((l) => l.t + l.s), [' a', '-b', '+B', ' c', '+d']);
  // длинный файл: контекст по 3 строки
  const old = Array.from({ length: 40 }, (_, i) => 'стр' + i).join('\n');
  const neu = old.replace('стр20', 'СТР20');
  const c = compact(lineDiff(old, neu));
  assert.deepEqual(c.map((l) => l.t), ['…', ' ', ' ', ' ', '-', '+', ' ', ' ', ' ', '…']);
  assert.equal(c[0].s, '17 без изменений');
  assert.equal(c[4].a, 21);
  // Edit: номера строк фрагмента не показываем
  const e = editDiff('Edit', { file_path: 'C:\\p\\a.ts', old_string: 'x\ny', new_string: 'x\nz' })!;
  assert.equal(e[0].file, 'C:\\p\\a.ts');
  assert.deepEqual(e[0].lines, [{ t: ' ', s: 'x' }, { t: '-', s: 'y' }, { t: '+', s: 'z' }]);
  // structuredPatch из tool_response — с настоящими номерами
  const sp = editDiff('Edit', { file_path: 'a.ts', old_string: 'y', new_string: 'z' }, { structuredPatch: [{ oldStart: 10, newStart: 10, lines: [' x', '-y', '+z'] }] })!;
  assert.deepEqual(sp[0].lines.map((l) => [l.t, l.a, l.b]), [[' ', 10, 10], ['-', 11, undefined], ['+', undefined, 11]]);
  // MultiEdit — правки через разделитель
  const me = editDiff('MultiEdit', { file_path: 'a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] })!;
  assert.deepEqual(me[0].lines.map((l) => l.t), ['-', '+', '…', '-', '+']);
  // Write нового файла — всё добавлено
  const w = editDiff('Write', { file_path: 'n.ts', content: '1\n2' })!;
  assert.deepEqual(w[0].lines.map((l) => l.t + l.s), ['+1', '+2']);
  // нет строк — нет diff
  assert.equal(editDiff('Edit', { file_path: 'a.ts' }), null);
  assert.equal(editDiff('Bash', { command: 'ls' }), null);
  // огромная правка обрезается
  const big = editDiff('Write', { file_path: 'big.txt', content: 'x'.repeat(100).concat('\n').repeat(2000) })!;
  assert.ok(big[0].cut);
  // патч Codex
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@ fn main\n-old\n+new\n ctx\n*** Add File: b.ts\n+hello\n*** End Patch';
  const pd = patchDiffs(patch);
  assert.deepEqual(pd.map((f) => f.file), ['src/a.ts', 'b.ts']);
  assert.deepEqual(pd[0].lines.map((l) => l.t + l.s), ['…fn main', '-old', '+new', ' ctx']);
  assert.deepEqual(diffCount('apply_patch', { input: patch }), { plus: 2, minus: 1 });
  assert.equal(summarize('apply_patch', { input: patch }), 'a.ts, b.ts');
});

test('PostToolUse сохраняет diff на ПК, а телефону уходит без него; процессы для терминала', () => {
  const sent: string[] = [];
  const hub = new AgentHub((_, b) => sent.push(b), () => [], () => {});
  const base = { session_id: 's1', cwd: 'C:\\Проекты\\tuk', tuk_pids: [50, 40, 20], tuk_console: 0 };
  hub.handle(1, JSON.stringify({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' } }));
  hub.handle(2, JSON.stringify({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' } }));
  const s = hub.sessions.get('s1')!;
  assert.equal(s.steps.length, 1);
  assert.deepEqual(hub.step('s1', 0)?.diff?.[0].lines.map((l) => l.t + l.s), ['-a', '+b']);
  assert.deepEqual(s.pids, [50, 40, 20]);
  assert.equal(s.console, undefined);
  const snap = hub.snapshot();
  assert.equal((snap.sessions[0].steps[0] as any).diff, undefined);
  assert.equal((snap.sessions[0] as any).pids, undefined);
  assert.equal(snap.sessions[0].steps[0].plus, 1);
});

test('события Gemini CLI и Codex приводятся к Claude Code', async () => {
  const { normalizeEvent } = await import('../src/agents.ts');
  const hub = new AgentHub(() => {}, () => [], () => {});
  // Gemini: событие из аргумента (tuk_event), инструмент — toolCall
  hub.handle(1, JSON.stringify({ tuk_agent: 'gemini', tuk_event: 'PreToolUse', hook_event_name: 'BeforeTool', session_id: 'g', cwd: '/p/x', tool_name: 'run_shell_command', tool_input: { command: 'npm test' } }));
  const g = hub.sessions.get('gemini:g')!;
  assert.equal(g.agent, 'Gemini CLI');
  assert.equal(g.steps[0].kind, 'run');
  assert.equal(g.steps[0].text, 'npm test');
  hub.handle(2, JSON.stringify({ tuk_agent: 'gemini', hook_event_name: 'AfterAgent', session_id: 'g' }));
  assert.equal(g.status, 'done');
  assert.equal(normalizeEvent({ toolCall: { name: 'read_file', args: { path: 'a' } } }).tool_input.path, 'a');
  assert.equal(normalizeEvent({ toolArgs: '{"x":1}' }).tool_input.x, 1);
  // Codex: разрешение ждёт решения и получает hookSpecificOutput
  const sent: [number, string][] = [];
  const h2 = new AgentHub((id, b) => sent.push([id, b]), () => [], () => {});
  h2.handle(7, JSON.stringify({ tuk_agent: 'codex', hook_event_name: 'PermissionRequest', session_id: 'c', tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'ls'] } }));
  assert.equal(sent.length, 0);
  assert.equal(h2.pending[0].summary, 'bash -lc ls');
  h2.decide(7, 'allow');
  assert.equal(JSON.parse(sent[0][1]).hookSpecificOutput.decision.behavior, 'allow');
});

test('хуки Codex и Gemini: установка рядом с чужими и удаление', async () => {
  const { installAgentHooks, uninstallAgentHooks, agentHooksInstalled, CODEX_EVENTS, GEMINI_EVENTS } = await import('../src/agents.ts');
  const theirs = { model: 'o3', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify.exe' }] }] } };
  const c = JSON.parse(installAgentHooks('codex', JSON.stringify(theirs), EXE));
  assert.equal(c.model, 'o3');
  assert.equal(c.hooks.Stop.length, 2);
  assert.equal(c.hooks.PermissionRequest[0].hooks[0].command, `"${EXE}" --hook --agent codex`);
  assert.equal(c.hooks.PermissionRequest[0].hooks[0].timeout, 120);
  assert.equal(c.hooks.PreToolUse[0].matcher, undefined);
  assert.equal(Object.keys(c.hooks).length, CODEX_EVENTS.length);
  assert.ok(agentHooksInstalled('codex', JSON.stringify(c)));
  assert.ok(!agentHooksInstalled('gemini', JSON.stringify(c)));
  const twice = JSON.parse(installAgentHooks('codex', JSON.stringify(c), EXE));
  assert.equal(twice.hooks.Stop.length, 2);
  assert.deepEqual(JSON.parse(uninstallAgentHooks('codex', JSON.stringify(twice))), theirs);

  const g = JSON.parse(installAgentHooks('gemini', '{"theme":"Default"}', 'C:\\Users\\O\'Neil\\Tuk.exe'));
  assert.equal(g.theme, 'Default');
  assert.equal(g.hooks.BeforeTool[0].matcher, '*');
  assert.equal(g.hooks.BeforeTool[0].hooks[0].command, "& 'C:\\Users\\O''Neil\\Tuk.exe' --hook --agent gemini PreToolUse");
  assert.equal(g.hooks.BeforeTool[0].hooks[0].timeout, 5000);
  assert.equal(Object.keys(g.hooks).length, GEMINI_EVENTS.length);
  assert.deepEqual(JSON.parse(uninstallAgentHooks('gemini', JSON.stringify(g))), { theme: 'Default' });
  assert.ok(!agentHooksInstalled('gemini', 'не json'));
});
