// Копирует index.html, styles.css и движок нейросети (wllama) в dist после компиляции TypeScript.
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
for (const f of ['index.html', 'styles.css', 'demo.html']) if (existsSync(`src/${f}`)) copyFileSync(`src/${f}`, `dist/${f}`);
const wl = 'node_modules/@wllama/wllama/esm';
if (existsSync(wl)) {
  cpSync(wl, 'dist/wllama', { recursive: true });
  console.log('wllama скопирован');
} else console.warn('ВНИМАНИЕ: нет node_modules/@wllama/wllama — разговор с нейросетью работать не будет. Выполните npm install.');
const pdf = 'node_modules/pdfjs-dist/build';
if (existsSync(pdf)) {
  mkdirSync('dist/pdfjs', { recursive: true });
  for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) copyFileSync(`${pdf}/${f}`, `dist/pdfjs/${f}`);
  console.log('pdf.js скопирован');
} else console.warn('ВНИМАНИЕ: нет pdfjs-dist — PDF читаться не будут.');
console.log('dist готов');
