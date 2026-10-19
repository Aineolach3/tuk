import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalUrl } from '../src/localai.ts';

test('локальный мозг: только localhost и домашняя сеть', () => {
  for (const u of ['http://127.0.0.1:11434', 'http://localhost:1234/v1', 'http://192.168.1.5:11434', 'http://10.0.0.2', 'http://172.20.1.1:1234', 'http://pc.local:11434'])
    assert.ok(isLocalUrl(u), u);
  for (const u of ['https://api.openai.com', 'http://8.8.8.8', 'ftp://127.0.0.1', 'не адрес', 'http://172.40.0.1'])
    assert.ok(!isLocalUrl(u), u);
});
