// Копирует index.html, styles.css и движок нейросети (wllama) в dist после компиляции TypeScript.
// Остров на Android (island-android.*) дополнительно кладётся в assets плагина: его грузит WebView сервиса.
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
for (const f of ['index.html', 'styles.css', 'demo.html', 'island-android.html']) if (existsSync(`src/${f}`)) copyFileSync(`src/${f}`, `dist/${f}`);
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
// Страница острова для Android: WebView в IslandService не видит ресурсы Tauri (они внутри Rust-библиотеки),
// поэтому страница и её модули едут в APK как assets плагина и отдаются сервисом сам.
const islandAssets = 'src-tauri/tauri-plugin-tuk/android/src/main/assets/island';
const islandFiles = ['island-android.html', 'island-android.js', 'character.js'];
if (islandFiles.every((f) => existsSync(`dist/${f}`))) {
  mkdirSync(islandAssets, { recursive: true });
  for (const f of islandFiles) copyFileSync(`dist/${f}`, `${islandAssets}/${f}`);
  console.log('остров Android скопирован');
} else console.warn('ВНИМАНИЕ: нет dist/island-android.* — остров на Android будет рисоваться старыми кадрами.');
console.log('dist готов');
