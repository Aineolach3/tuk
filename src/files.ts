// Файлы на Тука: достаём текст из файлов, чтобы спросить о них мозг, сделать заметку или задачи.
// Без новых зависимостей: текст — напрямую (UTF-8, UTF-16 или Windows-1251), PDF — через pdf.js
// (лежит в dist/pdfjs), DOCX/XLSX/PPTX — это zip: распаковываем встроенным
// DecompressionStream('deflate-raw') и разбираем XML регулярными выражениями.
// Изображения — карточка с превью и размером в пикселях, прочее — карточка «имя, размер».
// Идея карточки «что сделать с файлом» — по мотивам Coucou (MIT, Louis Raillé).

/* eslint-disable @typescript-eslint/no-explicit-any */

export type FileKind = 'text' | 'table' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'image' | 'other';

export interface FileCard {
  id: string;
  name: string;
  size: number;
  mime: string;
  kind: FileKind;
  /** Текст для мозга — уже урезанный под общий бюджет. */
  text: string;
  /** Весь извлечённый текст (до MAX_EXTRACT символов) — для заметки и задач. */
  full: string;
  /** Текст обрезан: мозгу ушла только часть. */
  truncated: boolean;
  pages?: number;
  sheets?: string[];
  slides?: number;
  width?: number;
  height?: number;
  /** Превью картинки (blob: или data: URL). */
  preview?: string;
  /** Путь на диске, если файл пришёл из Проводника. */
  path?: string;
  /** Пояснение: «скан без текста», «не умею читать» и т. п. */
  note?: string;
}

/** Совместимость со старым кодом: то, что раньше возвращал readFile. */
export type FileText = FileCard;

/** Сколько текста отдаём мозгу на все файлы вместе: окно модели — около 4 тысяч токенов. */
export const MAX_CHARS = 6000;
/** Сколько текста вообще извлекаем из одного файла. */
export const MAX_EXTRACT = 200_000;
/** Больше — не читаем, только карточка. */
export const MAX_BYTES = 50 * 1024 * 1024;
/** Защита от «zip-бомб»: распакованная часть документа не больше. */
const MAX_UNZIP = 40 * 1024 * 1024;

const TEXT_EXT = /\.(txt|text|md|markdown|csv|tsv|json|jsonl|log|xml|html?|css|js|mjs|ts|tsx|jsx|py|rs|java|kt|c|cpp|h|hpp|cs|go|rb|php|sql|ini|cfg|conf|env|properties|yaml|yml|toml|bat|cmd|ps1|sh|srt|vtt|sub|tex|rtf|svg)$/i;
const TABLE_EXT = /\.(csv|tsv)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;

const ext = (name: string) => (/\.([^.]+)$/.exec(name)?.[1] ?? '').toLowerCase();

export function kindOf(name: string, mime = ''): FileKind {
  const e = ext(name);
  if (e === 'pdf' || /pdf$/i.test(mime)) return 'pdf';
  if (e === 'docx' || e === 'docm') return 'docx';
  if (e === 'xlsx' || e === 'xlsm') return 'xlsx';
  if (e === 'pptx') return 'pptx';
  if (IMAGE_EXT.test(name) || (mime.startsWith('image/') && e !== 'svg')) return 'image';
  if (TABLE_EXT.test(name)) return 'table';
  if (TEXT_EXT.test(name) || mime.startsWith('text/') || /json|xml|yaml/.test(mime)) return 'text';
  return 'other';
}

/** Можно ли извлечь из файла текст. */
export function isReadable(f: { name: string; type?: string }): boolean {
  const k = kindOf(f.name, f.type ?? '');
  return k !== 'image' && k !== 'other';
}

export const KIND_LABEL: Record<FileKind, string> = {
  text: 'Текст', table: 'Таблица', pdf: 'PDF', docx: 'Word', xlsx: 'Excel', pptx: 'Презентация', image: 'Картинка', other: 'Файл',
};
export const KIND_ICON: Record<FileKind, string> = {
  text: '📄', table: '📊', pdf: '📕', docx: '📘', xlsx: '📗', pptx: '📙', image: '🖼', other: '📦',
};

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

function tidy(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------- Кодировки ----------------

/** UTF-8, UTF-16 с BOM или Windows-1251 (старые русские txt из Блокнота). */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('windows-1251').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}

// ---------------- ZIP ----------------

export interface ZipEntry {
  name: string;
  method: number; // 0 — без сжатия, 8 — deflate
  compSize: number;
  size: number;
  offset: number; // смещение локального заголовка
}

const u16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

/** Оглавление zip-архива (центральный каталог). */
export function listZip(b: Uint8Array): ZipEntry[] {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Это не zip-архив или он повреждён');
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= b.length; n++) {
    if (u32(b, p) !== 0x02014b50) break;
    const nameLen = u16(b, p + 28), extraLen = u16(b, p + 30), commentLen = u16(b, p + 32);
    out.push({
      method: u16(b, p + 10),
      compSize: u32(b, p + 20),
      size: u32(b, p + 24),
      offset: u32(b, p + 42),
      name: dec.decode(b.subarray(p + 46, p + 46 + nameLen)),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as any).DecompressionStream;
  if (!DS) throw new Error('Этот браузер не умеет распаковывать архивы');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DS('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Распаковать один файл из архива. */
export async function unzipEntry(b: Uint8Array, e: ZipEntry): Promise<Uint8Array> {
  if (e.size > MAX_UNZIP) throw new Error(`«${e.name}» внутри архива слишком большой`);
  const p = e.offset;
  if (u32(b, p) !== 0x04034b50) throw new Error('Архив повреждён');
  const start = p + 30 + u16(b, p + 26) + u16(b, p + 28);
  const raw = b.subarray(start, start + e.compSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return inflateRaw(raw);
  throw new Error(`Неизвестное сжатие в архиве (метод ${e.method})`);
}

/** Прочитать из архива текстовые файлы, чьи имена подходят под фильтр. */
export async function readZipText(b: Uint8Array, want: (name: string) => boolean): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const e of listZip(b)) if (want(e.name)) out.set(e.name, new TextDecoder().decode(await unzipEntry(b, e)));
  return out;
}

// ---------------- XML ----------------

export function xmlDecode(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'amp') return '&';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });
}

const attr = (tag: string, name: string) => xmlDecode(new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? '');

/** Текст документа Word (word/document.xml): абзацы, списки, заголовки, таблицы через « | ». */
export function docxText(xml: string): string {
  const lines: string[] = [];
  let buf = '';
  let prefix = '';
  let cell = 0; // глубина ячеек таблицы
  let row: string[] = [];
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>|<w:numPr>|<w:pStyle\s[^>]*\/>|<(\/?)w:(p|tc|tr)(?=[\s>\/])[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const tok = m[0];
    if (m[1] !== undefined) buf += xmlDecode(m[1]);
    else if (m[2]) buf += m[2] === 'tab' ? '\t' : '\n';
    else if (tok === '<w:numPr>') prefix ||= '• ';
    else if (tok.startsWith('<w:pStyle')) {
      const v = attr(tok, 'w:val');
      const h = /^(?:heading|заголовок)\s*(\d)$/i.exec(v) ?? /^(\d)$/.exec(v);
      if (h) prefix = '#'.repeat(Math.min(3, +h[1])) + ' ';
      else if (/^title$/i.test(v)) prefix = '# ';
    } else {
      const closing = m[3] === '/';
      const selfClosing = m[5] === '/';
      const el = m[4];
      if (el === 'p' && (closing || selfClosing)) {
        const t = buf.trim() ? prefix + buf : buf;
        if (cell > 0) row.length ? (row[row.length - 1] += (row[row.length - 1] ? ' ' : '') + t.trim()) : row.push(t.trim());
        else lines.push(t);
        buf = '';
        prefix = '';
      } else if (el === 'p') {
        buf = '';
        prefix = '';
      } else if (el === 'tc' && !closing && !selfClosing) {
        cell++;
        row.push('');
      } else if (el === 'tc' && closing) cell = Math.max(0, cell - 1);
      else if (el === 'tr' && !closing && !selfClosing) row = [];
      else if (el === 'tr' && closing) {
        if (row.some((c) => c)) lines.push(row.join(' | '));
        row = [];
      }
    }
  }
  if (buf.trim()) lines.push(prefix + buf);
  return tidy(lines.join('\n'));
}

/** Общие строки книги Excel (xl/sharedStrings.xml). */
export function xlsxSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const body = si[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, ''); // фонетические подсказки — не текст
    out.push([...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => xmlDecode(t[1])).join(''));
  }
  return out;
}

/** «B12» → номер столбца с нуля (1). */
export function colIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function cellNumber(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n) || v.trim() === '') return v;
  return Number.isInteger(n) ? String(n) : String(+n.toPrecision(12)).replace('.', ',');
}

/** Строки листа Excel: ячейки через табуляцию, пустые столбцы сохраняются. */
export function xlsxSheetRows(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const r of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells: string[] = [];
    let next = 0;
    for (const c of (r[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = ' ' + c[1];
      const ref = attr(a, 'r');
      const idx = ref ? colIndex(ref) : next;
      next = idx + 1;
      const t = attr(a, 't');
      const body = c[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let val = '';
      if (t === 's') val = shared[+(v ?? -1)] ?? '';
      else if (t === 'inlineStr') val = [...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((x) => xmlDecode(x[1])).join('');
      else if (t === 'b') val = v === '1' ? 'ИСТИНА' : v === '0' ? 'ЛОЖЬ' : '';
      else if (t === 'str' || t === 'e') val = xmlDecode(v ?? '');
      else if (v !== undefined) val = cellNumber(xmlDecode(v));
      if (idx > 2000) continue; // защита от странных ссылок вроде XFD1
      while (cells.length < idx) cells.push('');
      cells[idx] = val.replace(/[\t\r\n]+/g, ' ');
    }
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    rows.push(cells);
  }
  while (rows.length && !rows[rows.length - 1].length) rows.pop();
  return rows;
}

/** Порядок и имена листов: workbook.xml + workbook.xml.rels. */
export function xlsxSheetList(workbook: string, rels: string, files: string[]): { name: string; path: string }[] {
  const targets = new Map<string, string>();
  for (const r of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(r[0], 'Id');
    let t = attr(r[0], 'Target');
    if (!id || !t) continue;
    t = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
    targets.set(id, t);
  }
  const out: { name: string; path: string }[] = [];
  for (const s of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(s[0], 'name');
    const path = targets.get(attr(s[0], 'r:id'));
    if (path && files.includes(path)) out.push({ name, path });
  }
  if (out.length) return out;
  // без оглавления — просто по номерам sheet1, sheet2…
  return files
    .filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
    .sort((a, b) => +/(\d+)\.xml$/.exec(a)![1] - +/(\d+)\.xml$/.exec(b)![1])
    .map((path, i) => ({ name: `Лист${i + 1}`, path }));
}

export async function docxFromZip(b: Uint8Array): Promise<string> {
  const files = await readZipText(b, (n) => n === 'word/document.xml');
  const xml = files.get('word/document.xml');
  if (xml == null) throw new Error('В документе нет word/document.xml — это точно .docx?');
  return docxText(xml);
}

export async function xlsxFromZip(b: Uint8Array, limit = MAX_EXTRACT): Promise<{ text: string; sheets: string[] }> {
  const entries = listZip(b);
  const names = entries.map((e) => e.name);
  const get = async (n: string) => {
    const e = entries.find((x) => x.name === n);
    return e ? new TextDecoder().decode(await unzipEntry(b, e)) : '';
  };
  const shared = xlsxSharedStrings(await get('xl/sharedStrings.xml'));
  const list = xlsxSheetList(await get('xl/workbook.xml'), await get('xl/_rels/workbook.xml.rels'), names);
  if (!list.length) throw new Error('В книге нет листов — это точно .xlsx?');
  let text = '';
  for (const s of list) {
    if (text.length > limit) break;
    const rows = xlsxSheetRows(await get(s.path), shared);
    text += `## Лист «${s.name}»${rows.length ? '' : ' (пустой)'}\n` + rows.map((r) => r.join('\t')).join('\n') + '\n\n';
  }
  return { text: tidy(text), sheets: list.map((s) => s.name) };
}

export async function pptxFromZip(b: Uint8Array): Promise<{ text: string; slides: number }> {
  const files = await readZipText(b, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const order = [...files.keys()].sort((a, b2) => +/(\d+)\.xml$/.exec(a)![1] - +/(\d+)\.xml$/.exec(b2)![1]);
  const text = order
    .map((n, i) => {
      const xml = files.get(n)!;
      const paras = xml.split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => xmlDecode(t[1])).join('')).filter((s) => s.trim());
      return `## Слайд ${i + 1}\n${paras.join('\n')}`;
    })
    .join('\n\n');
  return { text: tidy(text), slides: order.length };
}

/** HTML → текст: без скриптов, стилей и тегов. */
export function htmlText(html: string): string {
  return tidy(
    xmlDecode(
      html
        .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' '),
    ),
  );
}

// ---------------- Картинки ----------------

/** Ширина и высота PNG/JPEG/GIF/BMP/WebP по заголовку. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const be16 = (i: number) => (b[i] << 8) | b[i + 1];
  const be32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: be32(16), height: be32(20) };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: u16(b, 6), height: u16(b, 8) };
  if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4d) return { width: u32(b, 18), height: Math.abs(u32(b, 22) | 0) };
  if (b.length > 30 && u32(b, 0) === 0x46464952 && u32(b, 8) === 0x50424557) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (chunk === 'VP8 ') return { width: u16(b, 26) & 0x3fff, height: u16(b, 28) & 0x3fff };
    if (chunk === 'VP8L') {
      const v = u32(b, 21);
      return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
    }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: be16(i + 7), height: be16(i + 5) };
      i += 2 + be16(i + 2);
    }
  }
  return null;
}

// ---------------- PDF ----------------

let pdfjs: any = null;

async function pdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  if (!pdfjs) {
    const path = './pdfjs/pdf.min.mjs';
    pdfjs = await import(/* @vite-ignore */ path);
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs/pdf.worker.min.mjs', location.href).href;
  }
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  let out = '';
  for (let i = 1; i <= doc.numPages && out.length < MAX_EXTRACT; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    out += tc.items.map((it: any) => (it.str ?? '') + (it.hasEOL ? '\n' : ' ')).join('') + '\n\n';
  }
  const pages = doc.numPages;
  await doc.destroy?.();
  return { text: out, pages };
}

// ---------------- Чтение ----------------

let seq = 0;
const newCardId = () => `f${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Прочитать один файл в карточку. Никогда не бросает исключение — ошибка попадает в note. */
export async function readFile(f: File, path?: string): Promise<FileCard> {
  const kind = kindOf(f.name, f.type);
  const card: FileCard = { id: newCardId(), name: f.name, size: f.size, mime: f.type, kind, text: '', full: '', truncated: false, path };
  if (f.size > MAX_BYTES) {
    card.note = `Файл больше ${fmtSize(MAX_BYTES)} — читать не стану, но могу открыть или показать в папке.`;
    return card;
  }
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    let text = '';
    switch (kind) {
      case 'text':
      case 'table':
        text = decodeText(bytes);
        if (/\.html?$/i.test(f.name)) text = htmlText(text);
        if (kind === 'table') card.note = `${text.split('\n').filter((l) => l.trim()).length} строк`;
        break;
      case 'pdf': {
        const r = await pdfText(bytes);
        card.pages = r.pages;
        text = r.text;
        if (!text.trim()) card.note = 'В этом PDF нет текста — похоже, это скан. Распознавать сканы пока не умею.';
        break;
      }
      case 'docx':
        text = await docxFromZip(bytes);
        break;
      case 'xlsx': {
        const r = await xlsxFromZip(bytes);
        text = r.text;
        card.sheets = r.sheets;
        break;
      }
      case 'pptx': {
        const r = await pptxFromZip(bytes);
        text = r.text;
        card.slides = r.slides;
        break;
      }
      case 'image': {
        const s = imageSize(bytes);
        if (s) Object.assign(card, s);
        try {
          card.preview = URL.createObjectURL(f);
        } catch {
          /* без превью */
        }
        break;
      }
      case 'other':
        card.note = 'Этот формат я не читаю — но могу открыть файл или показать его в папке.';
        break;
    }
    text = tidy(text);
    card.full = text.slice(0, MAX_EXTRACT);
    card.truncated = text.length > MAX_EXTRACT;
    card.text = card.full;
    if (!text && !card.note && kind !== 'image' && kind !== 'other') card.note = 'Файл пустой — текста в нём нет.';
  } catch (e) {
    card.note = `Не получилось прочитать: ${String((e as Error).message ?? e)}`;
  }
  return card;
}

/**
 * Поделить бюджет символов между файлами: короткие берут сколько им нужно,
 * остаток поровну делят длинные. Меняет text и truncated у карточек.
 */
export function fitBudget(cards: FileCard[], total = MAX_CHARS): FileCard[] {
  const withText = cards.filter((c) => c.full);
  let left = total;
  let rest = [...withText].sort((a, b) => a.full.length - b.full.length);
  while (rest.length) {
    const share = Math.floor(left / rest.length);
    const c = rest[0];
    const take = Math.min(c.full.length, share);
    c.text = c.full.slice(0, take);
    c.truncated = take < c.full.length || c.full.length >= MAX_EXTRACT;
    left -= take;
    rest = rest.slice(1);
  }
  return cards;
}

/** Прочитать сразу несколько файлов и поделить между ними бюджет. */
export async function readFiles(files: File[], total = MAX_CHARS, paths: (string | undefined)[] = []): Promise<FileCard[]> {
  const cards: FileCard[] = [];
  for (let i = 0; i < files.length; i++) cards.push(await readFile(files[i], paths[i]));
  return fitBudget(cards, total);
}

/** Карточка из байтов (файл, пришедший по пути из Проводника). */
export function fileFromBytes(name: string, bytes: Uint8Array): File {
  return new File([bytes as BlobPart], name);
}

/** Коротко о файле для карточки: «Word · 34 КБ · 12 400 символов». */
export function describe(c: FileCard): string {
  const parts: string[] = [KIND_LABEL[c.kind], fmtSize(c.size)];
  if (c.pages) parts.push(`${c.pages} стр.`);
  if (c.sheets?.length) parts.push(c.sheets.length === 1 ? `лист «${c.sheets[0]}»` : `${c.sheets.length} листа(ов)`);
  if (c.slides) parts.push(`${c.slides} слайд(ов)`);
  if (c.width && c.height) parts.push(`${c.width}×${c.height}`);
  if (c.full) parts.push(`${c.full.length.toLocaleString('ru-RU')} символов`);
  return parts.join(' · ');
}

/** Явное сообщение об обрезке: сколько из скольки ушло мозгу. */
export function truncationNote(c: FileCard): string {
  if (!c.truncated) return '';
  const all = c.full.length >= MAX_EXTRACT ? `больше ${MAX_EXTRACT.toLocaleString('ru-RU')}` : c.full.length.toLocaleString('ru-RU');
  return `Мозгу ушло только начало: ${c.text.length.toLocaleString('ru-RU')} из ${all} символов. Спросите про конкретную часть — или уберите другие файлы, чтобы освободить место.`;
}

/** Текст файлов для подсказки мозгу. */
export function filesContext(cards: FileCard[]): string {
  const parts = cards.map((c) => {
    if (c.kind === 'image') return `Файл «${c.name}» — картинка ${c.width ?? '?'}×${c.height ?? '?'}, ${fmtSize(c.size)}. Содержимое картинок ты не видишь.`;
    if (!c.text) return `Файл «${c.name}» (${fmtSize(c.size)}) — текста нет${c.note ? `: ${c.note}` : ''}.`;
    return `Файл «${c.name}»${c.truncated ? ' (только начало — дальше обрезано)' : ''}:\n-----\n${c.text}\n-----`;
  });
  return parts.join('\n\n') + '\nОтвечай на вопросы о файлах по их содержанию. Если ответа в показанной части нет — так и скажи.';
}

// ---------------- Заметки и задачи из файла ----------------

/** Пункты-дела из текста: чек-листы, TODO, нумерованные списки. */
export function extractTasks(text: string, max = 20): string[] {
  const lines = text.split('\n');
  const pick = (re: RegExp) => lines.map((l) => re.exec(l)?.[1]?.trim()).filter((s): s is string => !!s && s.length > 1);
  let out = pick(/^\s*(?:[-*•]\s*)?\[\s?\]\s*(.+)$/); // - [ ] пункт
  if (!out.length) out = pick(/^\s*(?:[-*•]\s*)?(?:TODO|FIXME|ToDo|Сделать|Надо|Нужно)\s*[:\-—]\s*(.+)$/i);
  if (!out.length) out = pick(/^\s*\d{1,2}[.)]\s+(.+)$/);
  if (!out.length) out = pick(/^\s*[-*•]\s+(.+)$/);
  return [...new Set(out.map((s) => s.replace(/\s+/g, ' ').slice(0, 200)))].slice(0, max);
}

/** Текст заметки из файла: имя и начало содержания. */
export function noteFromFile(c: FileCard, max = 1500): string {
  const head = `📎 ${c.name}`;
  if (!c.full) return `${head} (${describe(c)})${c.path ? ` — ${c.path}` : ''}`;
  const body = c.full.length > max ? c.full.slice(0, max).replace(/\s+\S*$/, '') + '…' : c.full;
  return `${head}\n${body}`;
}
