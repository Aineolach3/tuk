// Копирует index.html и styles.css в dist после компиляции TypeScript.
import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
for (const f of ['index.html', 'styles.css']) copyFileSync(`src/${f}`, `dist/${f}`);
console.log('dist готов');
