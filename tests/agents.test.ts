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
