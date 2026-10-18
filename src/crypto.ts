// Шифрование обмена ПК ↔ телефон: AES-GCM 256, ключ — 32 случайных байта.
// Для сопряжения по PIN ключ выводится из PIN через PBKDF2.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function unb64(s: string): Uint8Array {
  const t = s.replaceAll('-', '+').replaceAll('_', '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomKey(): string {
  const k = new Uint8Array(32);
  crypto.getRandomValues(k);
  return b64(k);
}

export function randomPin(): string {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(a[0] % 1_000_000).padStart(6, '0');
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptWith(keyB64: string, text: string): Promise<string> {
  const key = await importKey(unb64(keyB64));
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64(out);
}

/** Бросает исключение, если ключ не тот или данные подделаны. */
export async function decryptWith(keyB64: string, data: string): Promise<string> {
  const key = await importKey(unb64(keyB64));
  const raw = unb64(data);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
  return dec.decode(pt);
}

export async function keyFromPin(pin: string, pcId: string): Promise<string> {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('tuk-pair:' + pcId), iterations: 150_000 },
    base,
    256,
  );
  return b64(new Uint8Array(bits));
}
