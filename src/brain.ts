// «Мозги» Тука: локальная нейросеть (llama.cpp в WebAssembly через wllama).
// Модель один раз скачивается с Hugging Face и хранится в памяти приложения,
// дальше всё работает без интернета. Одинаково на Windows и Android.

/* eslint-disable @typescript-eslint/no-explicit-any */

export type ModelId = 'lite' | 'smart';

export interface ModelInfo {
  id: ModelId;
  name: string;
  about: string;
  url: string;
  bytes: number;
  ctx: number;
  /** Qwen3 «гибрид»: отключаем режим рассуждений, чтобы отвечал сразу */
  noThink: boolean;
}

export const MODELS: Record<ModelId, ModelInfo> = {
  lite: {
    id: 'lite',
    name: 'Лёгкий',
    about: 'Qwen3 1.7B — быстрый, для телефона',
    url: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf',
    bytes: 1_107_409_472,
    ctx: 4096,
    noThink: true,
  },
  smart: {
    id: 'smart',
    name: 'Умный',
    about: 'Qwen3 4B — лучше понимает и рассуждает, для ПК',
    url: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q3_K_M.gguf',
    bytes: 2_075_618_400,
    ctx: 4096,
    noThink: false,
  },
};

export type BrainState =
  | { s: 'absent' } // модель не скачана
  | { s: 'unavailable'; why: string } // движок не загрузился
  | { s: 'downloading'; done: number; total: number }
  | { s: 'loading' }
  | { s: 'ready' }
  | { s: 'error'; why: string };

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Engine {
  isCached(url: string): Promise<boolean>;
  load(m: ModelInfo, onProgress: (done: number, total: number) => void): Promise<void>;
  chat(m: ModelInfo, messages: ChatMsg[], onText: (full: string) => void, signal?: AbortSignal): Promise<string>;
  forget(): Promise<void>;
}

/** Убирает служебные блоки рассуждений, если модель их всё-таки выдала. */
export function cleanReply(s: string): string {
  return s
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/g, '')
    .replace(/^\s+/, '');
}

// ---------- wllama ----------

class WllamaEngine implements Engine {
  private w: any = null;
  private mod: any = null;

  private async lib(): Promise<any> {
    if (this.mod) return this.mod;
    const path = './wllama/index.js';
    this.mod = await import(/* @vite-ignore */ path);
    return this.mod;
  }

  private async instance(): Promise<any> {
    if (this.w) return this.w;
    const { Wllama } = await this.lib();
    const wasm = new URL('wllama/wasm/wllama.wasm', location.href).href;
    this.w = new Wllama({ default: wasm }, { suppressNativeLog: true, parallelDownloads: 3 });
    return this.w;
  }

  async isCached(url: string): Promise<boolean> {
    const w = await this.instance();
    const models = await w.modelManager.getModels();
    return models.some((m: any) => m.url === url);
  }

  async load(m: ModelInfo, onProgress: (done: number, total: number) => void): Promise<void> {
    const w = await this.instance();
    if (w.isModelLoaded?.()) await w.exit();
    const params = {
      n_ctx: m.ctx,
      progressCallback: ({ loaded, total }: { loaded: number; total: number }) => onProgress(loaded, total || m.bytes),
    };
    try {
      await w.loadModelFromUrl(m.url, params);
    } catch (e) {
      // видеокарта через WebGPU не справилась — пробуем только процессор
      if (/gpu|webgpu|device/i.test(String(e))) {
        await w.exit().catch(() => {});
        this.w = null;
        const w2 = await this.instance();
        await w2.loadModelFromUrl(m.url, { ...params, n_gpu_layers: 0 });
      } else throw e;
    }
  }

  async chat(m: ModelInfo, messages: ChatMsg[], onText: (full: string) => void, signal?: AbortSignal): Promise<string> {
    const w = await this.instance();
    const stream = await w.createChatCompletion({
      messages,
      stream: true,
      max_tokens: 400,
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      abortSignal: signal,
      chat_template_kwargs: m.noThink ? { enable_thinking: false } : undefined,
    });
    let full = '';
    for await (const chunk of stream) {
      const piece = chunk?.choices?.[0]?.delta?.content ?? '';
      if (!piece) continue;
      full += piece;
      onText(cleanReply(full));
    }
    return cleanReply(full).trim();
  }

  async forget(): Promise<void> {
    const w = await this.instance();
    if (w.isModelLoaded?.()) await w.exit();
    await w.modelManager.clear();
    this.w = null;
  }
}

// ---------- Мозг ----------

export class Brain {
  state: BrainState = { s: 'absent' };
  model: ModelInfo;
  onState: (s: BrainState) => void = () => {};
  private engine: Engine;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(modelId: ModelId, engine?: Engine) {
    this.model = MODELS[modelId];
    // в тестах можно подставить свой движок через globalThis.__TUK_ENGINE__
    this.engine = engine ?? ((globalThis as any).__TUK_ENGINE__ as Engine) ?? new WllamaEngine();
  }

  private set(s: BrainState) {
    this.state = s;
    this.onState(s);
  }

  get ready(): boolean {
    return this.state.s === 'ready';
  }

  /** При запуске: если модель уже скачана — загрузить её в память. */
  async init(): Promise<void> {
    try {
      if (await this.engine.isCached(this.model.url)) await this.start();
      else this.set({ s: 'absent' });
    } catch (e) {
      this.set({ s: 'unavailable', why: String((e as Error).message ?? e) });
    }
  }

  /** Скачать (если надо) и загрузить модель. */
  async start(): Promise<void> {
    if (this.state.s === 'downloading' || this.state.s === 'loading') return;
    try {
      const cached = await this.engine.isCached(this.model.url).catch(() => false);
      this.set(cached ? { s: 'loading' } : { s: 'downloading', done: 0, total: this.model.bytes });
      await this.engine.load(this.model, (done, total) => {
        if (done >= total) this.set({ s: 'loading' });
        else this.set({ s: 'downloading', done, total });
      });
      this.set({ s: 'ready' });
    } catch (e) {
      this.set({ s: 'error', why: humanError(e) });
    }
  }

  async switchModel(id: ModelId): Promise<void> {
    this.model = MODELS[id];
    this.set({ s: 'absent' });
    await this.init();
  }

  async forget(): Promise<void> {
    await this.engine.forget();
    this.set({ s: 'absent' });
  }

  /** Ответ на разговор. Запросы идут по очереди: модель одна. */
  chat(messages: ChatMsg[], onText: (full: string) => void, signal?: AbortSignal): Promise<string> {
    const run = async () => {
      if (!this.ready) throw new Error('Мозг ещё не загружен');
      return this.engine.chat(this.model, messages, onText, signal);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}

function humanError(e: unknown): string {
  const s = String((e as Error)?.message ?? e);
  if (/fetch|network|Failed to fetch|NetworkError/i.test(s)) return 'Нет интернета для загрузки модели. Подключитесь к Wi-Fi и нажмите «Скачать» ещё раз — загрузка продолжится.';
  if (/quota|storage|space/i.test(s)) return 'Не хватает места на устройстве для модели.';
  if (/memory|OOM|allocate/i.test(s)) return 'Не хватает оперативной памяти. Попробуйте «Лёгкий» мозг.';
  return s;
}

// ---------- Характер и контекст ----------

export function systemPrompt(name: string, context: string): string {
  return `Ты — ${name}, маленький дружелюбный помощник-персонаж: малыш в чёрном капюшоне с антенной-огоньком. Ты живёшь в строке на экране компьютера и телефона своего хозяина и работаешь без интернета.
Характер: тёплый, внимательный, с лёгким юмором, но не болтливый.
Правила:
- Всегда отвечай по-русски, коротко: 1–4 предложения, если не просят подробнее.
- Поддерживай разговор: можно спросить в ответ, пошутить, подбодрить.
- Ты не знаешь новостей и событий после своего обучения и не можешь заходить в интернет — честно говори об этом.
- Про здоровье: не ставь диагнозы и не советуй дозировки лекарств; при тревожных симптомах советуй обратиться к врачу.
- Если человек хочет что-то запомнить или получить напоминание, подскажи формат: «напомни завтра в 9 …», «запиши …».
- Используй сведения ниже, когда спрашивают о делах, планах и записях. Не выдумывай записей, которых там нет.

${context}`;
}
