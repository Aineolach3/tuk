import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, emptyData } from '../src/store.ts';
import {
  clientApply, clientRequest, serverHandle, seal, open, makePairCode, readPairCode,
  pinRequest, pinAnswer, pinAccept, type SyncRequest, type SyncResponse,
} from '../src/sync.ts';
import { randomKey, decryptWith, encryptWith } from '../src/crypto.ts';

function pair() {
  const pc = new Store(emptyData('ПК'), () => {});
  const phone = new Store(emptyData('Телефон'), () => {});
  const key = randomKey();
  pc.data.sync = { role: 'server', key, peers: [] };
  phone.data.sync = { role: 'client', key, host: '127.0.0.1', port: 47800, cursor: 0 };
  return { pc, phone, key };
}

/** Полный круг через зашифрованные конверты, как по сети. */
async function round(pc: Store, phone: Store, key: string) {
  const req = clientRequest(phone.data);
  const body = await seal(key, phone.data.deviceId, req);
  const got = await open<SyncRequest>(key, body);
  const { resp } = serverHandle(pc.data, got.payload);
  const back = await open<SyncResponse>(key, await seal(key, pc.data.deviceId, resp));
  clientApply(phone.data, req, back.payload);
}

const texts = (s: Store) => s.items.map((i) => i.text).sort();

test('записи доходят в обе стороны', async () => {
  const { pc, phone, key } = pair();
  pc.add({ kind: 'task', text: 'С ПК' });
  phone.add({ kind: 'task', text: 'С телефона' });
  await round(pc, phone, key);
  assert.deepEqual(texts(pc), ['С ПК', 'С телефона']);
  assert.deepEqual(texts(phone), ['С ПК', 'С телефона']);
  // повторный круг ничего не гоняет
  const req = clientRequest(phone.data);
  assert.equal(req.changes.length, 0);
  const { resp } = serverHandle(pc.data, req);
  assert.equal(resp.changes.length, 0);
});

test('правка и удаление синхронизируются, поздняя правка побеждает', async () => {
  const { pc, phone, key } = pair();
  const t = pc.add({ kind: 'task', text: 'Купить кабель' });
  await round(pc, phone, key);
  phone.update(t.id, { done: true });
  await round(pc, phone, key);
  assert.equal(pc.get(t.id)?.done, true);

  // конфликт: обе стороны правят, телефон позже
  pc.update(t.id, { text: 'Версия ПК' });
  await new Promise((r) => setTimeout(r, 5));
  phone.update(t.id, { text: 'Версия телефона' });
  await round(pc, phone, key);
  assert.equal(pc.get(t.id)?.text, 'Версия телефона');
  assert.equal(phone.get(t.id)?.text, 'Версия телефона');

  pc.remove(t.id);
  await round(pc, phone, key);
  assert.equal(phone.get(t.id), undefined);
  assert.equal(phone.data.items[t.id].deleted, true);
});

test('второй телефон получает всё', async () => {
  const { pc, phone, key } = pair();
  const phone2 = new Store(emptyData('Планшет'), () => {});
  phone2.data.sync = { role: 'client', key, cursor: 0 };
  phone.add({ kind: 'note', text: 'Заметка' });
  await round(pc, phone, key);
  await round(pc, phone2, key);
  assert.deepEqual(texts(phone2), ['Заметка']);
  assert.equal(pc.data.sync.peers?.length, 2);
});

test('чужой ключ не открывает данные', async () => {
  const k1 = randomKey(), k2 = randomKey();
  const c = await encryptWith(k1, 'секрет');
  assert.equal(await decryptWith(k1, c), 'секрет');
  await assert.rejects(decryptWith(k2, c));
});

test('код для QR читается обратно', () => {
  const code = makePairCode({ h: '192.168.1.5', p: 47800, k: randomKey(), d: 'abc', n: 'Рабочий ПК' });
  const back = readPairCode(code);
  assert.equal(back?.n, 'Рабочий ПК');
  assert.equal(readPairCode('мусор'), null);
});

test('сопряжение по PIN', async () => {
  const { pc } = pair();
  const pin = '482913';
  const req = await pinRequest(pin, pc.data.deviceId, { id: 'phone1', name: 'S24' });
  const answer = await pinAnswer(pin, pc.data, req);
  const grant = await pinAccept(pin, pc.data.deviceId, answer);
  assert.equal(grant.key, pc.data.sync.key);
  const wrong = await pinRequest('000000', pc.data.deviceId, { id: 'phone1', name: 'S24' });
  await assert.rejects(pinAnswer(pin, pc.data, wrong));
});
