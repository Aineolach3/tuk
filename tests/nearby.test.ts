import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NearList, cleanName, groupToken, myGroups, packet, parsePacket, HI_COOLDOWN, NEAR_TTL } from '../src/nearby.ts';

const ME = 'mememe0001';

test('пакет «рядом»: сборка и разбор', () => {
  const s = packet({ kind: 'here', id: 'a1b2c3d4e5', group: 'g1', to: '', hood: 'Бордо', outfit: 'scarf', name: '  Тук  Ивана ' });
  assert.equal(s, 'TUKN1|here|a1b2c3d4e5|g1||Бордо|scarf|Тук Ивана');
  assert.deepEqual(parsePacket(s), { kind: 'here', id: 'a1b2c3d4e5', group: 'g1', to: '', hood: 'Бордо', outfit: 'scarf', name: 'Тук Ивана' });
  // JSON от Rust
  const j = JSON.stringify({ ip: '192.168.1.5', kind: 'hi', id: 'a1b2c3d4e5', group: '', to: ME, hood: 'Чёрный', outfit: 'none', name: 'Сосед' });
  assert.equal(parsePacket(j)?.kind, 'hi');
  // имя с «|» и переводом строки чистится при сборке
  assert.equal(cleanName('a|b\nc'), 'a b c');
  assert.equal(cleanName('   '), 'Тук');
  assert.equal([...cleanName('я'.repeat(40))].length, 24);
  // плохие пакеты
  for (const bad of [
    'TUK1|abc|47800|PC',
    'TUKN1|here|short|||Чёрный|none|x',
    'TUKN1|boom|a1b2c3d4e5|||Чёрный|none|x',
    'TUKN1|here|a1b2c3d4e5|||Чёрный|none|',
    'TUKN1|here|a1b2c3d4e5|||Чёрный|<img>|x',
    'TUKN1|here|a1b2c3d4e5|||#fff|none|x',
    'TUKN1|hi|a1b2c3d4e5|||Чёрный|none|x',
    'TUKN1|here|a1b2c3d4e5|||Чёрный|none|a|b',
    '{"kind":"here","id":"a1b2c3d4e5","name":"<script>","hood":"<b>"}',
    '{нет',
    'x'.repeat(500),
  ])
    assert.equal(parsePacket(bad), null, bad);
});

test('список соседей: свои, чужие приветы, свои устройства, уход по тишине', async () => {
  let now = 1_000_000;
  const l = new NearList(() => now);
  const groups = await myGroups('общий-ключ', now);
  assert.equal(groups.length, 3);
  // свой пакет — мимо
  assert.equal(l.handle(packet({ kind: 'here', id: ME, group: '', to: '', hood: 'Чёрный', outfit: 'none', name: 'Я' }), ME, groups), null);
  // свой телефон (та же метка группы) — мимо
  const phone = packet({ kind: 'here', id: 'phone00001', group: await groupToken('общий-ключ', Math.floor(now / 3_600_000)), to: '', hood: 'Чёрный', outfit: 'none', name: 'Телефон' });
  assert.equal(l.handle(phone, ME, groups), null);
  // чужой сосед с другим ключом — виден
  const other = packet({ kind: 'here', id: 'other00001', group: await groupToken('чужой', 1), to: '', hood: 'Хаки', outfit: 'crown', name: 'Сосед' });
  assert.equal(l.handle(other, ME, groups, '192.168.1.7')?.type, 'new');
  assert.equal(l.handle(other, ME, groups), null); // повторный маяк — без события
  assert.equal(l.list.length, 1);
  assert.equal(l.list[0].ip, '192.168.1.7');
  // привет не мне — мимо; мне — событие, но не чаще раза в 5 с
  assert.equal(l.handle(packet({ kind: 'hi', id: 'other00001', group: '', to: 'someone001', hood: 'Хаки', outfit: 'crown', name: 'Сосед' }), ME, groups), null);
  const hi = packet({ kind: 'hi', id: 'other00001', group: '', to: ME, hood: 'Хаки', outfit: 'crown', name: 'Сосед' });
  assert.equal(l.handle(hi, ME, groups)?.type, 'hi');
  assert.equal(l.handle(hi, ME, groups), null);
  now += HI_COOLDOWN;
  assert.equal(l.handle(hi, ME, groups)?.type, 'hi');
  // свой привет — тоже с паузой
  assert.ok(l.canGreet('other00001'));
  assert.ok(!l.canGreet('other00001'));
  assert.ok(!l.canGreet('nobody0001'));
  // молчит — уходит
  now += NEAR_TTL + 1;
  assert.equal(l.sweep().length, 1);
  assert.equal(l.list.length, 0);
  // bye
  l.handle(other, ME, groups);
  assert.equal(l.handle(packet({ kind: 'bye', id: 'other00001', group: '', to: '', hood: 'Хаки', outfit: 'crown', name: 'Сосед' }), ME, groups)?.type, 'bye');
  assert.equal(l.list.length, 0);
  // без ключа связи своих устройств нет
  assert.deepEqual(await myGroups(undefined), []);
});

test('не больше 12 соседей', () => {
  const l = new NearList(() => 1);
  for (let i = 0; i < 20; i++) l.handle(packet({ kind: 'here', id: `peer${String(i).padStart(6, '0')}`, group: '', to: '', hood: '', outfit: 'none', name: 'Т' + i }), ME, []);
  assert.equal(l.list.length, 12);
});
