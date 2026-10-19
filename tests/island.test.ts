import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IslandFsm, MODE_OF, PHASE_OF, applyIslandClasses, unionRect, type IslandPhase, type Timers } from '../src/island.ts';

/** Ручные часы: таймеры срабатывают только по tick(). */
function clock() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set: (fn, ms) => {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (id) => void pending.delete(id as number),
  };
  const tick = (ms: number) => {
    now += ms;
    for (const [id, t] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= now && pending.has(id)) {
        pending.delete(id);
        t.fn();
      }
    }
  };
  return { timers, tick, count: () => pending.size };
}

function make() {
  const c = clock();
  const fsm = new IslandFsm(c.timers);
  const log: string[] = [];
  fsm.onChange = (to, from) => log.push(`${from}>${to}`);
  return { fsm, log, ...c };
}

test('наведение — выглянул, ушла мышь — спрятался после задержки', () => {
  const { fsm, log, tick } = make();
  fsm.enter();
  assert.equal(fsm.state, 'peek');
  fsm.leave();
  tick(500);
  assert.equal(fsm.state, 'peek', 'не прячется мгновенно');
  tick(500);
  assert.equal(fsm.state, 'hidden');
  assert.deepEqual(log, ['hidden>peek', 'peek>hidden']);
});

test('вернулся мышью до конца задержки — остаётся', () => {
  const { fsm, tick } = make();
  fsm.enter();
  fsm.leave();
  tick(600);
  fsm.enter();
  tick(5000);
  assert.equal(fsm.state, 'peek');
});

test('клик раскрывает, клик мимо и Esc сворачивают', () => {
  const { fsm } = make();
  fsm.enter();
  fsm.click();
  assert.equal(fsm.state, 'home');
  fsm.outside();
  assert.equal(fsm.state, 'hidden');
  fsm.click();
  assert.equal(fsm.state, 'home', 'клик по капсуле сразу открывает');
  fsm.escape();
  assert.equal(fsm.state, 'hidden');
  fsm.escape();
  assert.equal(fsm.state, 'hidden');
});

test('раскрытый остров не сворачивается от ухода мыши, только от потери фокуса', () => {
  const { fsm, tick } = make();
  fsm.open();
  fsm.leave();
  tick(10_000);
  assert.equal(fsm.state, 'home');
  fsm.blur();
  assert.equal(fsm.state, 'hidden');
});

test('потеря фокуса под мышью — остаётся выглянувшим', () => {
  const { fsm, tick } = make();
  fsm.enter();
  fsm.click();
  fsm.blur();
  assert.equal(fsm.state, 'peek');
  fsm.leave();
  tick(1000);
  assert.equal(fsm.state, 'hidden');
});

test('хоткей открывает и закрывает из любого состояния', () => {
  const { fsm } = make();
  fsm.toggle();
  assert.equal(fsm.state, 'home');
  fsm.toggle();
  assert.equal(fsm.state, 'hidden');
  fsm.enter();
  fsm.toggle();
  assert.equal(fsm.state, 'home');
});

test('pinned: напоминание держит остров выглянувшим', () => {
  const { fsm, tick } = make();
  fsm.pinned = true;
  fsm.reveal();
  tick(60_000);
  assert.equal(fsm.state, 'peek');
  fsm.open();
  fsm.escape();
  assert.equal(fsm.state, 'peek', 'Esc при тревоге не прячет совсем');
  fsm.unpin();
  tick(1000);
  assert.equal(fsm.state, 'hidden');
});

test('reveal: короткий показ ответа и продление', () => {
  const { fsm, tick } = make();
  fsm.reveal(3000);
  assert.equal(fsm.state, 'peek');
  tick(2000);
  fsm.reveal(3000);
  tick(2000);
  assert.equal(fsm.state, 'peek', 'второй reveal продлил показ');
  tick(1000);
  assert.equal(fsm.state, 'hidden');
});

test('reveal не трогает раскрытый остров', () => {
  const { fsm, tick } = make();
  fsm.open();
  fsm.reveal(100);
  tick(1000);
  assert.equal(fsm.state, 'home');
});

test('sync принимает состояние без события и без висящих таймеров', () => {
  const { fsm, log, count } = make();
  fsm.enter();
  fsm.leave();
  assert.equal(count(), 1);
  fsm.sync('home');
  assert.equal(fsm.state, 'home');
  assert.equal(count(), 0);
  assert.deepEqual(log, ['hidden>peek']);
});

test('старые режимы строки ↔ фазы', () => {
  for (const p of ['hidden', 'peek', 'home'] as IslandPhase[]) assert.equal(PHASE_OF[MODE_OF[p]], p);
});

test('классы на html', () => {
  const set = new Set<string>(['desktop', 'island-home']);
  const root = { classList: { remove: (...t: string[]) => t.forEach((x) => set.delete(x)), add: (...t: string[]) => t.forEach((x) => set.add(x)) } };
  applyIslandClasses('peek', root);
  assert.deepEqual([...set].sort(), ['desktop', 'island-peek']);
});

test('объединение прямоугольников для click-through', () => {
  assert.deepEqual(unionRect([]), { x: 0, y: 0, width: 0, height: 0 });
  assert.deepEqual(
    unionRect([
      { x: 20, y: 0, width: 440, height: 72 },
      { x: 30, y: 72, width: 420, height: 300 },
      { x: 0, y: 0, width: 0, height: 0 },
    ]),
    { x: 20, y: 0, width: 440, height: 372 },
  );
});
