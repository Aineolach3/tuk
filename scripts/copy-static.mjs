// Копирует index.html, styles.css и движок нейросети (wllama) в dist после компиляции TypeScript.
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
for (const f of ['index.html', 'styles.css']) copyFileSync(`src/${f}`, `dist/${f}`);
const wl = 'node_modules/@wllama/wllama/esm';
if (existsSync(wl)) {
  cpSync(wl, 'dist/wllama', { recursive: true });
  console.log('wllama скопирован');
} else console.warn('ВНИМАНИЕ: нет node_modules/@wllama/wllama — разговор с нейросетью работать не будет. Выполните npm install.');
console.log('dist готов');
