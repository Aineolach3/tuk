// Локальный сервер нейросети как запасной «мозг»: Ollama или LM Studio на этом же компьютере
// (или в домашней сети). Оба понимают OpenAI-совместимый /v1/chat/completions.
// Ничего не уходит в интернет: адрес — localhost или ваш ПК в сети.
// Идея выбора «локального провайдера» — по мотивам Coucou (MIT, Louis Raillé).

import type { ChatMsg } from './brain.js';

export interface LocalAi {
  on: boolean;
  url: string; // http://127.0.0.1:11434 (Ollama) или http://127.0.0.1:1234 (LM Studio)
  model: string;
}

export const LOCAL_PRESETS: { name: string; url: string }[] = [
  { name: 'Ollama', url: 'http://127.0.0.1:11434' },
  { name: 'LM Studio', url: 'http://127.0.0.1:1234' },
];

const root = (url: string) => url.trim().replace(/\/+$/, '').replace(/\/v1$/, '');

/** Только локальные адреса: localhost и частные сети. Облака — против идеи Тука. */
export function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(root(url));
    if (!/^https?:$/.test(u.protocol)) return false;
    const h = u.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.local');
  } catch {
    return false;
  }
}

function explain(e: unknown, url: string): Error {
  const s = String((e as Error)?.message ?? e);
  if (/Failed to fetch|NetworkError|Load failed|fetch/i.test(s))
    return new Error(`Сервер ${root(url)} не отвечает. Запустите Ollama или LM Studio (в LM Studio — вкладка Developer → Start Server). Для Ollama может понадобиться переменная OLLAMA_ORIGINS=*.`);
  return new Error(s);
}

/** Список моделей на сервере. */
export async function listModels(url: string): Promise<string[]> {
  if (!isLocalUrl(url)) throw new Error('Нужен локальный адрес: localhost или компьютер в вашей сети.');
  try {
    const r = await fetch(root(url) + '/v1/models');
    if (!r.ok) throw new Error(`Сервер ответил ${r.status}`);
    const j = (await r.json()) as { data?: { id: string }[] };
    return (j.data ?? []).map((m) => m.id).filter(Boolean);
  } catch (e) {
    throw explain(e, url);
  }
}

/** Разговор с потоковым ответом. */
export async function localChat(cfg: LocalAi, messages: ChatMsg[], onText: (full: string) => void, signal?: AbortSignal): Promise<string> {
  if (!isLocalUrl(cfg.url)) throw new Error('Нужен локальный адрес: localhost или компьютер в вашей сети.');
  let r: Response;
  try {
    r = await fetch(root(cfg.url) + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, stream: true, messages: messages.map(({ role, content }) => ({ role, content })) }),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw explain(e, cfg.url);
  }
  if (!r.ok || !r.body) throw new Error(`Локальный сервер ответил ${r.status}${r.status === 404 ? ' — проверьте имя модели' : ''}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.replace(/^data:\s*/, '').trim();
      if (!t || t === '[DONE]') continue;
      try {
        const piece = JSON.parse(t)?.choices?.[0]?.delta?.content;
        if (piece) {
          full += piece;
          onText(full.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trimStart());
        }
      } catch {
        /* неполная строка — дождёмся остального */
      }
    }
  }
  return full.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
}
