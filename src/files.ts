// Файлы на Тука: достаём текст из файла, чтобы спросить о нём мозг.
// Текстовые форматы читаются напрямую, PDF — через pdf.js (лежит в dist/pdfjs).

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FileText {
  name: string;
  text: string;
  truncated: boolean;
  pages?: number;
}

/** Сколько текста отдаём мозгу: окно модели — около 4 тысяч токенов. */
export const MAX_CHARS = 6000;

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|xml|html?|css|js|ts|tsx|jsx|py|rs|java|kt|c|cpp|h|cs|go|rb|php|sql|ini|cfg|conf|yaml|yml|toml|bat|ps1|sh|srt|vtt)$/i;

export function isReadable(f: File): boolean {
  return TEXT_EXT.test(f.name) || f.type.startsWith('text/') || /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name);
}

function clip(name: string, text: string, pages?: number): FileText {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { name, text: clean.slice(0, MAX_CHARS), truncated: clean.length > MAX_CHARS, pages };
}

let pdfjs: any = null;

async function readPdf(f: File): Promise<FileText> {
  if (!pdfjs) {
    const path = './pdfjs/pdf.min.mjs';
    pdfjs = await import(/* @vite-ignore */ path);
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs/pdf.worker.min.mjs', location.href).href;
  }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
  let out = '';
  for (let i = 1; i <= doc.numPages && out.length < MAX_CHARS * 1.2; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    out += tc.items.map((it: any) => (it.str ?? '') + (it.hasEOL ? '\n' : ' ')).join('') + '\n\n';
  }
  const pages = doc.numPages;
  await doc.destroy?.();
  if (!out.trim()) throw new Error('В этом PDF нет текста — похоже, это скан. Распознавание сканов пока не умею.');
  return clip(f.name, out, pages);
}

export async function readFile(f: File): Promise<FileText> {
  if (f.size > 50 * 1024 * 1024) throw new Error('Файл больше 50 МБ — слишком большой для меня.');
  if (/\.pdf$/i.test(f.name) || /pdf$/i.test(f.type)) return readPdf(f);
  if (TEXT_EXT.test(f.name) || f.type.startsWith('text/')) return clip(f.name, await f.text());
  throw new Error(`Пока не умею читать «${f.name}». Подойдут текстовые файлы и PDF.`);
}
