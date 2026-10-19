# Передача задач между участниками

## От программиста функций (TS) — дизайнеру

- [ ] Временные стили новых блоков лежат в `src/index.html` (`<style id="features-css">`): пилюли сессий `.spill`, цветная точка `.dotc` (цвет в `--sc`), карточки вопросов `.opt`, карточки файлов `.fcard/.fthumb`, разделы ⚙ `.setnav`, знакомство `.sheet.onboard`, `kbd`, подсветка вкладки `#tabs .attn`. Перенесите в `styles.css` и переоформите как считаете нужным — после переноса блок `<style>` удалю я.
- [ ] В `#tabs` добавлена последняя вкладка `⚙` (`.tab-gear`) — на узком острове её, возможно, стоит сделать иконкой фиксированной ширины.
- [ ] Новое настроение не нужно, но в демо-режиме все 21 состояние показываются по очереди (`MOOD_LABEL`), по 1,6 с — проверьте, что переходы между ними плавные.

## От программиста функций (TS) — программисту ПК

- [ ] Нативный drag & drop из Проводника (`onDragDropEvent`) на остров и питомца: прислать в главное окно событие `files-drop` с `{ files: [{ name, path, size, data }] }`, где `data` — содержимое base64 (не присылать, если файл больше 50 МБ — тогда будет карточка «имя, размер, путь»). Обработчик уже есть: `App.takeDropped` в `src/app.ts`.
- [ ] «Показать в папке» сейчас открывает папку файла через `open_target`. Если добавите `explorer /select,"путь"` отдельной командой (`reveal_path`), скажите — переключу.
- [ ] `/agent-answer` и `/agent-close` — новые адреса для телефона (зашифрованы общим ключом, как `/agent-decide`). Rust их не фильтрует — ничего делать не нужно, только учесть, если появится белый список путей.
- [ ] Ответ на `AskUserQuestion` — JSON `hookSpecificOutput.decision = { behavior: "allow", updatedInput: { ...вход, answers } }`; `hook_main` печатает его как есть — проверьте на реальном Claude Code, что одной строки достаточно.
- [ ] Ollama/LM Studio: `fetch` к `http://127.0.0.1:11434` из WebView. Если CSP или mixed content в WebView2 помешает (страница `tauri://` / `https://tauri.localhost`), нужна команда-прокси в Rust — сообщите.

## От дизайнера

Сделано по запросу программиста функций: блок `<style id="features-css">` перенесён в `src/styles.css` и удалён из `src/index.html`; ⚙ во вкладках — круглая иконка 32 px, на узком острове (≤ 460 px) прижата справа, вкладки прокручиваются под ней. Демо по 1,6 с: переходы между всеми 21 состоянием плавные (веса поз смешиваются пружиной, смена формы глаз — через моргание).

### Программисту ПК (Rust/Tauri, `src/platform.ts`)

- [ ] **`scripts/copy-static.mjs`** — копировать и `demo.html` (демо-страница анимаций: `dist/demo.html`, скрипт `dist/demo.js` собирает tsc):
  ```js
  for (const f of ['index.html', 'styles.css', 'demo.html']) copyFileSync(`src/${f}`, `dist/${f}`);
  ```
- [ ] **Окно питомца по размеру персонажа** (`src-tauri/src/desktop.rs`, `pet_show`): сейчас `inner_size(150.0, 170.0)`. Холст рисует Тука во всё окно без полей, пропорции фигуры ≈ 1 : 1,2. Предлагаю `.inner_size(120.0, 144.0)` (как ТЗ: «~120 px»). Если поставите другое — рисунок впишется сам.
- [ ] **Полёт питомца:** `pet.ts` слушает `getCurrentWindow().onMoved` — нужно право `core:window:allow-start-dragging` и события перемещения окна (входят в `core:default`, проверьте, что для окна `pet` в `capabilities/default.json` они есть). Если `onMoved` недоступен, питомец просто приземлится через 0,4 с после начала перетаскивания.
- [ ] **Click-through питомца по фигуре** (по желанию): в `Character` есть метод `contains(clientX, clientY)` — попадает ли точка в силуэт. Если будете делать `set_ignore_cursor_events` по маске, можно опрашивать его из `pet.ts` (скажите — добавлю отправку).
- [ ] **Прозрачность:** в `index.html` добавлен ранний `<script>`, ставящий `html.desktop` до первой отрисовки, и убран `<meta name="color-scheme" content="dark">` — в WebView2 именно он заливал прозрачное окно тёмным фоном. На корне `html.desktop` теперь `color-scheme: normal` и `background: transparent !important`; тёмный фон есть только у капсулы `#shell`. Если тёмный прямоугольник останется — это фон самого WebView2: нужен `.background_color(Color(0,0,0,0))` у `WebviewWindowBuilder` (обоих окон) или `"backgroundColor": "#00000000"` в `tauri.conf.json`.
- [ ] **Капсула не до краёв окна:** `#shell` отстоит от краёв на 3 px сверху и 5–10 px по бокам/снизу (место под мягкую тень). Окно острова должно быть на ~20 px шире и ~12 px выше видимой пилюли, иначе тень обрежется. Размеры, под которые рисовал: hidden ≈ 190×44, peek ≈ 420×84, home ≈ 440×640 (как сейчас в `set_mode`).
- [ ] **Классы состояний острова:** CSS понимает `html.island-hidden` / `island-peek` / `island-home` и прежние `mode-collapsed` / `mode-compact` / `mode-expanded` как синонимы. Ставьте любые; при переключении анимация пружинная (только transform/clip-path, без пересчёта раскладки). Если окно меняет размер одновременно с классом — сначала увеличивайте окно, потом ставьте класс (при сворачивании — наоборот, класс, затем через ~300 мс уменьшать окно), чтобы не было обрезки.

### Программисту функций (`src/app.ts`)

- [ ] **Экономия кадров на свёрнутом острове:** в `applyMode` добавьте `this.char.lowPower = m === 'collapsed';` — в свёрнутом виде 15 к/с вместо 60. (Сам `Character` уже снижает частоту до 15 к/с через 12 с покоя и до 12 к/с во сне, а при `document.hidden` останавливается.)
- [ ] **Танец в такт:** у `Character` есть поле `bpm` (по умолчанию 112). Если медиа знает темп — `this.char.bpm = …`; в `PetState` добавлено необязательное `bpm`, `pet.ts` его применяет.
- [ ] **Новые методы `Character`** (по желанию): `blink()`, `squash()`, `jump()`, `gulp()`, `hover(on)`, `land()`, `setFlight(vx, vy)`. Реакции уже запускаются сами при `set('poke' | 'happy' | 'eat' | 'dizzy' | 'alert')`, вызывать отдельно не обязательно. Наведение мыши на `#char` обрабатывает сам холст (глаза растут + моргает).
- [ ] `takeFile`/`takeDropped`: настроение `eat` теперь длится ~0,9 с анимации (рот-коробка открывается, «жуёт», закрывается) — текущие 1400 мс подходят, менять не нужно.

## От программиста ПК → функции

Всё ниже уже есть в `src/platform.ts` (обёртки) и `src-tauri/src/*` (команды). Rust здесь не собирается (crates.io закрыт) — проверка только в GitHub Actions.

### Файлы из Проводника (нативный drag & drop) — `files.rs`
- Окна `main` (остров) и `pet` (питомец) принимают перетаскивание Tauri (`dragDropEnabled: true`, `WindowEvent::DragDrop`). Остров/питомец на время перетаскивания перестают быть «прозрачными для кликов», иначе Проводник не нашёл бы цель.
- **Событие `files-drop`** (только в окно `main`, даже если бросили на питомца):
  ```ts
  { target: 'main' | 'pet', files: [{ name, path, size, data?: base64, dir?: true, error?: string }] }
  ```
  `data` нет, если файл > 50 МБ, если все файлы броска вместе > 120 МБ, если это папка (`dir: true`) или не прочиталось (`error`). Берётся не больше 20 файлов. Ваш `takeDropped` уже читает `payload.files` — **просьба:** для `dir`/`error` показывать карточку «папка» / «не прочитать: …» (сейчас придёт как файл размером 0).
- **Событие `files-hover`** `{ target, state: 'enter'|'over'|'leave'|'drop', count }` — в `main` (и в `pet`, если над ним). В `app.ts` на `enter` уже стоит `flash('listen')`; анимацию «глотает» можно повесить на `drop`.
- Команды (в `platform.ts`):
  - `P.readDroppedFile(path, maxBytes?) → Uint8Array` — байты, лимит ≤ 50 МБ;
  - `P.readDroppedText(path, maxChars?) → { text, truncated, size }` — UTF-8 с заменой битых байтов, BOM убран;
  - `P.droppedPaths() → string[]` — пути последнего броска (если страница перезагрузилась и событие пропустила).
  Читать можно **только файлы, которые человек сам бросил на Тука** (белый список в Rust), иначе ошибка «Этот файл не бросали на Тука».
- `P.revealPath(path)` — Проводник с выделенным файлом (`explorer /select,"…"`); `P.openPath(path)` — открыть в программе по умолчанию. В `app.ts` «Открыть» / «Показать в папке» уже переключены на них (с запасным `openTarget`).

### Ollama / LM Studio без fetch — `localhttp.rs`
`fetch` из WebView к `http://127.0.0.1:11434` ломают COEP `require-corp` и «смешанное содержимое» (`https://tauri.localhost` → `http://`). Rust-прокси: только `http://`, только адреса этого ПК и частных сетей (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, ::1, fc00::/7, fe80::/10) — проверяется адрес после DNS.
- `P.localHttp('GET' | 'POST' | 'DELETE', url, body?) → { status, body }` — целиком (список моделей);
- `P.localHttpStream('POST', url, body, onPiece, signal?) → status` — потоково: `onPiece` получает **сырые куски тела** (для SSE — `data: {...}\n` строки, могут резаться посередине строки, как в fetch), `signal.abort()` останавливает. Ошибка сети → промис отклоняется с понятным текстом.
- `P.hasLocalHttp()` — есть ли прокси (в браузере-демо нет → оставьте fetch).
- **Просьба** в `src/localai.ts` (ваш файл):
  ```ts
  // listModels
  const r = P.hasLocalHttp() ? await P.localHttp('GET', root(url) + '/v1/models') : null;
  if (r && r.status !== 200) throw new Error(`Сервер ответил ${r.status}`);
  const j = r ? JSON.parse(r.body) : await (await fetch(root(url) + '/v1/models')).json();
  // localChat: вместо fetch + reader
  let buf = '', full = '';
  const status = await P.localHttpStream('POST', root(cfg.url) + '/v1/chat/completions', JSON.stringify({ model: cfg.model, stream: true, messages }), (piece) => {
    buf += piece;
    const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const line of lines) { /* тот же разбор data: … что сейчас */ }
  }, signal);
  if (status !== 200) throw new Error(`Локальный сервер ответил ${status}…`);
  ```

### Несколько сессий Claude Code — как события доходят (`net.rs`, `lib.rs`)
Путь: Claude Code → `Tuk.exe --hook` (stdin) → `POST 127.0.0.1:47800/hook` (только с этого ПК) → Rust → событие `sync-request` `{ id, path: '/hook', body }` → `link.ts` → `AgentHub.handle(id, body)` → `server_reply(id, …)` → ответ в stdout хука.
- Каждое HTTP-соединение — свой поток и свой `id` (растёт, не повторяется) → одновременные запросы разных сессий не путаются; решение уходит именно тому `Tuk.exe --hook`, который спросил. Сессию различайте по `session_id` в `body` (как сейчас).
- **Изменение:** события **без решения** (всё, кроме `PermissionRequest`, включая `AskUserQuestion`-через-PermissionRequest) Rust теперь подтверждает Claude Code **сразу** пустым ответом, а страница получает их тем же `sync-request`. Раньше каждое событие каждой сессии держало Claude Code, пока страница не ответит, и при занятой странице события копились/отваливались по таймауту. `server_reply` на такие id безвреден (ничего не делает) — менять `AgentHub` не нужно.
- `PermissionRequest` ждёт решения до **112 с** (хук ждёт 115 с, в settings.json таймаут 120 с; ваш `TIMEOUTS.pending` = 110 с — согласовано). Не ответили — Claude Code получает пустой ответ и спрашивает в терминале.
- **Новое:** `P.serverInflight() → SyncRequestEvent[]` — запросы, которые ещё ждут ответа страницы, по порядку прихода. **Просьба** в `link.ts` (`startServer`), сразу после `P.listen('sync-request', …)`:
  ```ts
  for (const req of await P.serverInflight()) void this.handle(req); // страница перезагрузилась — ждущие разрешения не теряются
  ```
  и в `AgentHub.handle` для `PermissionRequest` не добавлять второй `Pending` с тем же `reqId`, если он уже в очереди.
- `sync-request` теперь идёт только в окно `main` (раньше — во все окна, в т. ч. в питомца).
- Ответ на `AskUserQuestion` одной строкой JSON — достаточно: `hook_main` печатает тело как есть, если оно начинается с `{`. На реальном Claude Code не проверял (нет Windows) — тестировщику в чек-лист.

### Остров (ПК) — `island.rs`, `src/island.ts`; правки в `app.ts` сделаны мной
- Машина состояний `IslandFsm` (`src/island.ts`, тест `tests/island.test.ts`): `hidden → peek` (наведение) `→ home` (клик); сворачивание: клик мимо (Rust шлёт `island-outside`), Esc, потеря фокуса, хоткей; `pinned` (звонит напоминание / ждёт агент) не даёт спрятаться самому. Классы `html.island-hidden|peek|home` + прежние `mode-*`.
- `applyMode(m)` остался: старый код (`say`, напоминания, `open-link`) работает как раньше, машина просто узнаёт новое состояние (`island.sync`). Для новых мест лучше `this.island.open() / reveal(ms) / hide()`.
- Rust сам: размер окна по фазе (hidden 210×56, peek 440×96, home 460×656 — капсула дизайнера + поля под тень; растёт сразу, сжимается через 320 мс после анимации), click-through вне `#shell` (страница шлёт прямоугольник `island_set_rect`), фокус только в `home`, окно не в Alt-Tab, сверка размера раз в ~1 с.
- События для страницы: `island-cursor` `{ x, y, inside }`, `island-outside`, `island-screen`; `toggle` теперь с payload `'toggle' | 'open'` (хоткей Ctrl+Alt+Пробел — `'toggle'`, трей/второй запуск — `'open'`).
- Настройка «Экран острова: основной / тот, где мышь» — в ⚙ → Основное (`settings.islandScreen`).
- Питомец: окно 120×144 (как просил дизайнер), создаётся при запуске из `tauri.conf.json`, прячется за край экрана; click-through вне силуэта (эллипс), место запоминается и проверяется, что оно на подключённом мониторе. Событие `pet-visible` (bool) в `main` и `pet`; `pet-cursor` `{ x, y }` в `pet` (~60 Гц, можно вместо опроса `cursorRel`).
- `tauri-plugin-single-instance`: второй запуск `Tuk.exe` открывает остров первого (кроме `--autostart`); `Tuk.exe --hook` плагин не трогает — `main.rs` выходит раньше.

## От программиста ПК → дизайнеру
- Ваши пункты сделаны: окно питомца 120×144; `copy-static.mjs` копирует `demo.html`; `backgroundColor: #00000000` у обоих окон в `tauri.conf.json` + `set_background_color(0,0,0,0)` в Rust; окно острова на 20 px шире и на 12 px выше капсулы; при сворачивании окно уменьшается через 320 мс после смены класса.
- Click-through считается по `getBoundingClientRect()` у `#shell` (+6 px). Если у острова появятся части вне `#shell` (всплывающие карточки, тосты) — скажите, добавлю их в `reportIslandRect` в `app.ts` (функция `unionRect` уже есть).
- Пока открыт `#overlay` (знакомство, сводка), окно принимает мышь целиком — `#overlay` занимает всё окно острова.
- [ ] **Важно для CPU:** окно `pet` теперь создаётся при запуске и, пока питомец «в строке», стоит за краем экрана (на Windows его не прячут — повторный show крадёт фокус). `document.hidden` при этом **не** становится true. В `pet.ts` слушайте `pet-visible` (bool) и на `false` останавливайте `Character` (и опрос `cursorRel`), на `true` — запускайте. Вместо опроса `cursorRel` можно слушать `pet-cursor` `{ x, y }` — Rust шлёт его ~60 Гц только пока питомец на столе.
