//! Тук — Rust-часть. Здесь только то, чего не может веб-интерфейс:
//! файл с данными, остров у верхнего края экрана, питомец, трей, горячая клавиша,
//! файлы из Проводника, сеть между ПК и телефоном, запросы к локальному ИИ.
//! Вся логика помощника — в TypeScript (папка src).

#[cfg(desktop)]
mod desktop;
#[cfg(desktop)]
mod files;
#[cfg(desktop)]
mod island;
mod localhttp;
mod net;
#[cfg(windows)]
mod win32;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct AppState {
    server: Mutex<Option<Arc<net::Server>>>,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------- Данные ----------

fn data_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(err)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join("tuk-data.json"))
}

#[tauri::command]
fn load_data(app: AppHandle) -> Result<Option<String>, String> {
    let p = data_path(&app)?;
    match std::fs::read_to_string(&p) {
        Ok(s) if !s.trim().is_empty() => Ok(Some(s)),
        // основной файл пуст или пропал — пробуем резервную копию
        _ => Ok(std::fs::read_to_string(p.with_extension("json.bak")).ok()),
    }
}

#[tauri::command]
fn save_data(app: AppHandle, json: String) -> Result<(), String> {
    let p = data_path(&app)?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(err)?;
    if p.exists() {
        let _ = std::fs::copy(&p, p.with_extension("json.bak"));
    }
    // на Windows rename заменяет существующий файл
    std::fs::rename(&tmp, &p).map_err(err)
}

// ---------- Остров (только ПК) ----------
//
// Размер окна, click-through и фокус — в island.rs. Фазу выбирает машина
// состояний страницы (src/island.ts) и присылает с номером `seq`: вызовы IPC
// могут прийти не по порядку, и устаревший запрос больше не оставит окно
// большим, когда страница уже свернулась (так появлялся тёмный прямоугольник).

#[cfg(desktop)]
static PHASE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[tauri::command]
fn island_set_phase(app: AppHandle, window: tauri::WebviewWindow, phase: String, seq: Option<u64>) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use std::sync::atomic::Ordering;
        // только окно острова: питомец (то же index.html) не должен двигать остров
        if window.label() != island::LABEL {
            return Ok(());
        }
        let p = island::Phase::parse(&phase).ok_or("Неизвестная фаза острова")?;
        if let Some(seq) = seq {
            // fetch_max: применяем, только если номер не меньше последнего
            if PHASE_SEQ.fetch_max(seq, Ordering::SeqCst) > seq {
                return Ok(());
            }
        }
        if let Some(isl) = island::state(&app) {
            island::set_phase(&app, &isl, p);
        }
    }
    #[cfg(mobile)]
    let _ = (app, window, phase, seq);
    Ok(())
}

/// Старое имя (collapsed | compact | expanded) — для совместимости.
#[tauri::command]
fn set_mode(app: AppHandle, window: tauri::WebviewWindow, mode: String) -> Result<(), String> {
    island_set_phase(app, window, mode, None)
}

/// Где на странице остров (логические px окна): вне его клики проходят на рабочий стол.
#[tauri::command]
fn island_set_rect(app: AppHandle, window: tauri::WebviewWindow, x: f64, y: f64, width: f64, height: f64) {
    #[cfg(desktop)]
    {
        if window.label() == island::LABEL {
            if let Some(isl) = island::state(&app) {
                island::set_rect(&isl, island::Rect { x, y, w: width, h: height });
            }
        }
    }
    #[cfg(mobile)]
    let _ = (app, window, x, y, width, height);
}

/// Экран острова: "primary" — основной, "cursor" — где мышь.
#[tauri::command]
fn island_set_screen(app: AppHandle, screen: String) {
    #[cfg(desktop)]
    {
        if let Some(isl) = island::state(&app) {
            island::set_screen(&app, &isl, &screen);
        }
    }
    #[cfg(mobile)]
    let _ = (app, screen);
}

/// Страница сообщает свой devicePixelRatio; при расхождении с масштабом окна — поправка зума.
#[tauri::command]
fn island_fit_zoom(app: AppHandle, dpr: f64) -> bool {
    #[cfg(desktop)]
    return island::fit_zoom(&app, dpr);
    #[cfg(mobile)]
    {
        let _ = (app, dpr);
        false
    }
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let m = app.autolaunch();
        let on = m.is_enabled().unwrap_or(false);
        if enabled && !on {
            m.enable().map_err(err)?;
        } else if !enabled && on {
            m.disable().map_err(err)?;
        }
    }
    #[cfg(mobile)]
    let _ = (app, enabled);
    Ok(())
}

/// Сохранить картинку (base64 PNG): «Изображения», иначе «Загрузки», иначе папка приложения.
#[tauri::command]
fn save_image(app: AppHandle, name: String, base64: String) -> Result<String, String> {
    let bytes = net::b64decode(&base64).ok_or("Повреждённая картинка")?;
    let safe: String = name.chars().map(|c| if "/\\:*?\"<>|".contains(c) { '_' } else { c }).collect();
    let p = app.path();
    let dirs = [p.picture_dir().ok(), p.download_dir().ok(), p.app_data_dir().ok()];
    let mut last = String::from("нет подходящей папки");
    for dir in dirs.into_iter().flatten() {
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join(&safe);
        match std::fs::write(&file, &bytes) {
            Ok(_) => return Ok(file.display().to_string()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(last)
}

// ---------- Хуки Claude Code ----------

/// Режим «шлюза»: Claude Code запускает `Tuk.exe --hook`, передаёт событие в stdin.
/// Пересылаем его работающему Туку и печатаем его ответ (решение по разрешению).
pub fn hook_main() -> i32 {
    use std::io::{Read, Write};
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let blocking = input.contains("\"PermissionRequest\"");
    let read_secs = if blocking { 115 } else { 3 };
    if let Ok(body) = net::http_post_t("127.0.0.1", 47800, "/hook", &input, 1, read_secs) {
        let t = body.trim();
        if t.starts_with('{') {
            let mut out = std::io::stdout();
            let _ = out.write_all(t.as_bytes());
            let _ = out.flush();
        }
    }
    0
}

#[tauri::command]
fn claude_info() -> Result<String, String> {
    #[cfg(desktop)]
    return desktop::claude_info();
    #[cfg(mobile)]
    Err("Только на ПК".into())
}

#[tauri::command]
fn claude_read() -> Result<String, String> {
    #[cfg(desktop)]
    return desktop::claude_read();
    #[cfg(mobile)]
    Err("Только на ПК".into())
}

#[tauri::command]
fn claude_write(json: String) -> Result<String, String> {
    #[cfg(desktop)]
    return desktop::claude_write(&json);
    #[cfg(mobile)]
    {
        let _ = json;
        Err("Только на ПК".into())
    }
}

// ---------- Питомец на рабочем столе ----------

#[tauri::command]
fn pet_show(app: AppHandle, show: bool) -> Result<(), String> {
    #[cfg(desktop)]
    return desktop::pet_show(&app, show);
    #[cfg(mobile)]
    {
        let _ = (app, show);
        Ok(())
    }
}

#[tauri::command]
fn pet_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(desktop)]
    return window.start_dragging().map_err(err);
    #[cfg(mobile)]
    {
        let _ = window;
        Ok(())
    }
}

#[tauri::command]
fn cursor_rel(window: tauri::WebviewWindow) -> Result<(f64, f64), String> {
    #[cfg(desktop)]
    return desktop::cursor_rel(&window);
    #[cfg(mobile)]
    {
        let _ = window;
        Ok((0.0, 0.0))
    }
}

// ---------- Музыка ----------

#[tauri::command]
async fn media_info() -> Result<String, String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(desktop::media::info).await.map_err(err)?;
    #[cfg(not(windows))]
    Ok("null".into())
}

#[tauri::command]
async fn media_thumb() -> Result<String, String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(desktop::media::thumb).await.map_err(err)?;
    #[cfg(not(windows))]
    Ok(String::new())
}

#[tauri::command]
async fn media_control(action: String) -> Result<(), String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || desktop::media::control(&action))
        .await
        .map_err(err)?;
    #[cfg(not(windows))]
    {
        let _ = action;
        Err("Управление музыкой пока только на Windows".into())
    }
}

/// Открыть сайт, файл или программу (команды «открой блокнот», «найди в интернете …»).
#[tauri::command]
fn open_target(target: String) -> Result<(), String> {
    let t = target.trim();
    if t.is_empty() || t.contains('"') || t.contains('&') || t.contains('|') || t.contains('\n') {
        return Err("Не могу это открыть".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", t])
            .creation_flags(0x0800_0000) // без чёрного окна
            .spawn()
            .map(|_| ())
            .map_err(err)
    }
    #[cfg(all(not(windows), desktop))]
    {
        std::process::Command::new("xdg-open").arg(t).spawn().map(|_| ()).map_err(err)
    }
    #[cfg(mobile)]
    {
        Err("На телефоне — через плагин".into())
    }
}

// ---------- Файлы (команды — в files.rs; на телефоне — заглушки) ----------

#[cfg(mobile)]
mod files {
    #[tauri::command]
    pub fn reveal_path(path: String) -> Result<(), String> {
        let _ = path;
        Err("Только на ПК".into())
    }
    #[tauri::command]
    pub fn open_path(path: String) -> Result<(), String> {
        let _ = path;
        Err("Только на ПК".into())
    }
    #[tauri::command]
    pub fn dropped_paths() -> Vec<String> {
        Vec::new()
    }
    #[tauri::command]
    pub fn read_file(path: String, max_bytes: Option<u64>) -> Result<String, String> {
        let _ = (path, max_bytes);
        Err("Только на ПК".into())
    }
    #[tauri::command]
    pub fn read_text(path: String, max_chars: Option<usize>) -> Result<String, String> {
        let _ = (path, max_chars);
        Err("Только на ПК".into())
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// ---------- Сеть ----------

#[tauri::command]
fn local_ip() -> String {
    net::local_ip().unwrap_or_else(|| "127.0.0.1".into())
}

/// ПК: запустить сервер синхронизации и маяк. Каждый запрос уходит в интерфейс событием `sync-request`.
#[tauri::command]
fn server_start(app: AppHandle, state: State<'_, AppState>, port: u16, beacon: String) -> Result<(), String> {
    let mut slot = state.server.lock().unwrap();
    if slot.is_some() {
        return Ok(());
    }
    let handle = app.clone();
    let srv = net::start_server(port, move |id, path, body| {
        let payload = format!(
            "{{\"id\":{},\"path\":{},\"body\":{}}}",
            id,
            net::json_str(&path),
            net::json_str(&body)
        );
        // только в окно острова: питомец (тот же index.html) не должен отвечать на запросы
        let _ = handle.emit_to("main", "sync-request", payload);
    })
    .map_err(|e| format!("Порт {port} занят или закрыт: {e}"))?;
    net::start_beacon(beacon);
    *slot = Some(srv);
    Ok(())
}

/// Запросы, которые ещё ждут ответа интерфейса (тот же формат, что `sync-request`).
/// Страница после перезагрузки забирает их, и ни один запрос разрешения не теряется.
#[tauri::command]
fn server_inflight(state: State<'_, AppState>) -> Vec<String> {
    state
        .server
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| {
            s.inflight()
                .into_iter()
                .map(|(id, path, body)| format!("{{\"id\":{},\"path\":{},\"body\":{}}}", id, net::json_str(&path), net::json_str(&body)))
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
fn server_reply(state: State<'_, AppState>, id: u64, status: u16, body: String) {
    if let Some(s) = state.server.lock().unwrap().as_ref() {
        s.reply(id, status, body);
    }
}

/// Телефон: запрос к ПК. Выполняется в отдельном потоке, чтобы не тормозить интерфейс.
#[tauri::command]
async fn http_post(host: String, port: u16, path: String, body: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || net::http_post(&host, port, &path, &body))
        .await
        .map_err(err)?
}

#[tauri::command]
async fn discover(ms: u64) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || net::discover(ms.min(10_000)))
        .await
        .map_err(err)?
}

// ---------- Запуск ----------

/// Показать раскрытый остров (трей, хоткей, второй запуск).
#[cfg(desktop)]
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
    }
}

/// Полностью прозрачный фон окна и WebView2 (на случай, если `transparent` из
/// tauri.conf.json не дошёл до WebView2: тогда он заливает окно своим цветом).
#[cfg(desktop)]
fn make_transparent(w: &tauri::WebviewWindow) {
    let clear = Some(tauri::utils::config::Color(0, 0, 0, 0));
    let _ = w.set_background_color(clear);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // Второй запуск (ярлык, автозапуск, двойной клик по Tuk.exe) не создаёт
        // второй экземпляр с вторым островом и вторым сервером на порту 47800,
        // а открывает остров уже работающего Тука. Плагин должен быть первым.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if argv.iter().any(|a| a == "--autostart") {
                return;
            }
            show_main(app);
            let _ = app.emit_to("main", "toggle", "open");
        }));
    }

    builder = builder.manage(AppState::default()).plugin(tauri_plugin_notification::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ));
    }
    #[cfg(mobile)]
    {
        builder = builder.plugin(tauri_plugin_barcode_scanner::init()).plugin(tauri_plugin_biometric::init()).plugin(tauri_plugin_tuk::init());
    }

    builder
        .invoke_handler(tauri::generate_handler![
            load_data,
            save_data,
            set_mode,
            island_set_phase,
            island_set_rect,
            island_set_screen,
            island_fit_zoom,
            set_autostart,
            quit_app,
            save_image,
            local_ip,
            server_start,
            server_inflight,
            server_reply,
            http_post,
            discover,
            claude_info,
            claude_read,
            claude_write,
            pet_show,
            pet_drag,
            cursor_rel,
            media_info,
            media_thumb,
            media_control,
            open_target,
            files::reveal_path,
            files::open_path,
            files::dropped_paths,
            files::read_file,
            files::read_text,
            localhttp::local_http,
            localhttp::local_http_stream,
            localhttp::local_http_cancel
        ])
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::TrayIconBuilder;
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

                let handle = app.handle().clone();

                // Остров: прозрачное окно у верхнего края, не крадёт фокус, click-through вне капсулы
                let isl = Arc::new(island::Island::new());
                app.manage(isl.clone());
                if let Some(w) = island::window(&handle) {
                    make_transparent(&w);
                    #[cfg(windows)]
                    win32::make_non_activating(&w);
                    files::install(&handle, &w);
                    island::apply_geometry(&handle, &isl);
                    let _ = w.show();
                }
                island::spawn_poll(handle.clone(), isl);

                // Питомец: описан в tauri.conf.json с "create": false — создаём только на ПК,
                // иначе Android открывает это окно вместо приложения (Тук во весь экран)
                if app.get_webview_window(desktop::PET).is_none() {
                    if let Some(cfg) = app.config().app.windows.iter().find(|c| c.label == desktop::PET).cloned() {
                        let _ = tauri::WebviewWindowBuilder::from_config(app, &cfg).and_then(|b| b.build());
                    }
                }
                if let Some(w) = app.get_webview_window(desktop::PET) {
                    make_transparent(&w);
                }
                desktop::setup_pet(&handle);

                // Трей
                let open = MenuItem::with_id(app, "open", "Открыть Тук", true, None::<&str>)?;
                let link = MenuItem::with_id(app, "link", "Связь с телефоном", true, None::<&str>)?;
                let pet = MenuItem::with_id(app, "pet", "Тук на рабочем столе", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open, &link, &pet, &quit])?;
                let mut tray = TrayIconBuilder::with_id("main")
                    .tooltip("Тук")
                    .menu(&menu)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "open" => {
                            show_main(app);
                            let _ = app.emit_to("main", "toggle", "open");
                        }
                        "link" => {
                            show_main(app);
                            let _ = app.emit_to("main", "open-link", ());
                        }
                        "pet" => {
                            let show = !desktop::pet_visible();
                            let _ = desktop::pet_show(app, show);
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    });
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                tray.build(app)?;

                // Ctrl+Alt+Пробел — открыть/свернуть остров (страница решает по своей фазе)
                let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
                let toggle_for_handler = toggle.clone();
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            if shortcut == &toggle_for_handler && event.state() == ShortcutState::Pressed {
                                show_main(app);
                                let _ = app.emit_to("main", "toggle", "toggle");
                            }
                        })
                        .build(),
                )?;
                if let Err(e) = app.global_shortcut().register(toggle) {
                    eprintln!("Горячая клавиша занята другой программой: {e}");
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("не удалось запустить Тук");
}
