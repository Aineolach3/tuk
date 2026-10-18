// После «tauri android init»: делаем окно приложения прозрачным,
// чтобы выпадающее окно с острова показывалось поверх текущего приложения.
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const res = 'src-tauri/gen/android/app/src/main/res';
if (!existsSync(res)) {
  console.error('нет ' + res + ' — сначала tauri android init');
  process.exit(1);
}
const ITEMS = `
        <item name="android:windowIsTranslucent">true</item>
        <item name="android:windowBackground">@android:color/transparent</item>
        <item name="android:colorBackgroundCacheHint">@null</item>
        <item name="android:windowAnimationStyle">@android:style/Animation.Translucent</item>
`;
let n = 0;
for (const dir of readdirSync(res)) {
  const f = join(res, dir, 'themes.xml');
  if (!dir.startsWith('values') || !existsSync(f) || !statSync(f).isFile()) continue;
  let s = readFileSync(f, 'utf8');
  if (s.includes('windowIsTranslucent')) continue;
  // первый стиль — тема активности
  s = s.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/, (_m, a, body, c) => a + body + ITEMS + '    ' + c);
  writeFileSync(f, s);
  console.log('прозрачная тема:', f);
  n++;
}
if (!n) {
  console.error('не нашёл themes.xml');
  process.exit(1);
}
