//! Файлы: нативный drag & drop Tauri на остров и питомца, чтение брошенных
//! файлов, «Открыть» и «Показать в папке».
//!
//! Перетаскивание из Проводника приходит как WindowEvent::DragDrop (Tauri 2).
//! Брошенный файл попадает в белый список: читать с диска страница может
//! только то, что человек сам бросил на Тука (как allow_dropped в Coucou —
//! по мотивам Coucou (MIT, Louis Raillé), src-tauri/src/files.rs).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, DragDropEvent, Emitter, WebviewWindow};

/// Больше этого содержимое в событие не кладём — только карточка «имя, размер, путь».
pub const MAX_EMBED: u64 = 50 * 1024 * 1024;
/// Всего в одном броске (чтобы 20 файлов по 40 МБ не повесили окно).
pub const MAX_EMBED_TOTAL: u64 = 120 * 1024 * 1024;
/// Сколько файлов из одного броска берём.
pub const MAX_FILES: usize = 20;

static ALLOWED: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);
static LAST: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn allow(paths: &[PathBuf]) {
    let mut g = ALLOWED.lock().unwrap();
    let set = g.get_or_insert_with(HashSet::new);
    for p in paths {
        set.insert(p.clone());
    }
    *LAST.lock().unwrap() = paths.iter().map(|p| p.display().to_string()).collect();
}

fn is_allowed(p: &Path) -> bool {
    ALLOWED.lock().unwrap().as_ref().map(|s| s.contains(p)).unwrap_or(false)
}

#[derive(Serialize, Clone)]
pub struct DroppedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    /// Содержимое base64; нет — файл слишком большой, это папка или его не прочитать.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct FilesDrop {
    /// "main" или "pet" — куда бросили.
    pub target: String,
    pub files: Vec<DroppedFile>,
}

#[derive(Serialize, Clone)]
struct FilesHover {
    target: String,
    /// "enter" | "over" | "leave" | "drop"
    state: &'static str,
    count: usize,
}

/// Описать файлы броска, прочитав содержимое тех, что помещаются в лимиты.
pub fn describe(paths: &[PathBuf]) -> Vec<DroppedFile> {
    let mut total = 0u64;
    paths
        .iter()
        .take(MAX_FILES)
        .map(|p| {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string());
            let mut f = DroppedFile { name, path: p.display().to_string(), size: 0, data: None, dir: false, error: None };
            match std::fs::metadata(p) {
                Ok(m) if m.is_dir() => f.dir = true,
                Ok(m) => {
                    f.size = m.len();
                    if f.size <= MAX_EMBED && total + f.size <= MAX_EMBED_TOTAL {
                        match std::fs::read(p) {
                            Ok(bytes) => {
                                total += bytes.len() as u64;
                                f.data = Some(crate::net::b64encode(&bytes));
                            }
                            Err(e) => f.error = Some(e.to_string()),
                        }
                    }
                }
                Err(e) => f.error = Some(e.to_string()),
            }
            f
        })
        .collect()
}

/// Подписать окно на нативный drag & drop. `target` — "main" или "pet".
/// Во время перетаскивания окно принимает мышь целиком (иначе click-through
/// спрятал бы его от Проводника), после — снова решает опрос курсора.
pub fn install(app: &AppHandle, win: &WebviewWindow) {
    let app = app.clone();
    let target = win.label().to_string();
    win.on_window_event(move |e| {
        let tauri::WindowEvent::DragDrop(ev) = e else { return };
        let (state, count) = match ev {
            DragDropEvent::Enter { paths, .. } => ("enter", paths.len()),
            DragDropEvent::Over { .. } => ("over", 0),
            DragDropEvent::Drop { paths, .. } => ("drop", paths.len()),
            DragDropEvent::Leave => ("leave", 0),
            _ => return,
        };
        set_file_drag(&app, &target, state == "enter" || state == "over");
        let hover = FilesHover { target: target.clone(), state, count };
        let _ = app.emit_to("main", "files-hover", hover.clone());
        if target != "main" {
            let _ = app.emit_to(target.as_str(), "files-hover", hover);
        }
        if let DragDropEvent::Drop { paths, .. } = ev {
            allow(paths);
            let paths = paths.clone();
            let app2 = app.clone();
            let target2 = target.clone();
            // чтение с диска — не в главном потоке
            std::thread::spawn(move || {
                let files = describe(&paths);
                let _ = app2.emit_to("main", "files-drop", FilesDrop { target: target2, files });
            });
        }
    });
}

fn set_file_drag(app: &AppHandle, target: &str, on: bool) {
    use std::sync::atomic::Ordering;
    if target == "main" {
        if let Some(isl) = crate::island::state(app) {
            isl.file_drag.store(on, Ordering::Relaxed);
        }
    } else if target == "pet" {
        crate::desktop::PET_FILE_DRAG.store(on, Ordering::Relaxed);
    }
}

// ---------- Команды ----------

/// Пути последнего броска (на случай, если страница перезагрузилась и событие пропустила).
#[tauri::command]
pub fn dropped_paths() -> Vec<String> {
    LAST.lock().unwrap().clone()
}

/// Прочитать брошенный файл: байты base64, не больше `max_bytes` (по умолчанию 50 МБ).
#[tauri::command]
pub async fn read_file(path: String, max_bytes: Option<u64>) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !is_allowed(&p) {
        return Err("Этот файл не бросали на Тука".into());
    }
    let limit = max_bytes.unwrap_or(MAX_EMBED).min(MAX_EMBED);
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        let f = std::fs::File::open(&p).map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        f.take(limit).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        Ok(crate::net::b64encode(&buf))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct TextOut {
    pub text: String,
    pub truncated: bool,
    pub size: u64,
}

/// Прочитать брошенный файл как текст (UTF-8, иначе с заменой битых байтов), не больше `max_chars`.
#[tauri::command]
pub async fn read_text(path: String, max_chars: Option<usize>) -> Result<TextOut, String> {
    let p = PathBuf::from(&path);
    if !is_allowed(&p) {
        return Err("Этот файл не бросали на Тука".into());
    }
    let max = max_chars.unwrap_or(200_000).min(5_000_000);
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        let size = std::fs::metadata(&p).map_err(|e| e.to_string())?.len();
        let f = std::fs::File::open(&p).map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        // символ UTF-8 — до 4 байт
        f.take((max as u64) * 4 + 4).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        let s = String::from_utf8_lossy(&buf);
        let mut text: String = s.chars().take(max).collect();
        // обрезано: символов больше лимита или прочитали не весь файл
        let read_all = (buf.len() as u64) >= size;
        let truncated = s.chars().count() > max || !read_all;
        if text.starts_with('\u{feff}') {
            text.remove(0);
        }
        Ok(TextOut { text, truncated, size })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn checked_path(path: &str) -> Result<PathBuf, String> {
    let t = path.trim();
    if t.is_empty() || t.contains('"') || t.contains('\n') || t.contains('\r') {
        return Err("Неверный путь".into());
    }
    let p = PathBuf::from(t);
    if !p.is_absolute() || !p.exists() {
        return Err("Файл не найден".into());
    }
    Ok(p)
}

/// «Показать в папке»: Проводник с выделенным файлом.
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let p = checked_path(&path)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", p.display()))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let dir = if p.is_dir() { p } else { p.parent().map(Path::to_path_buf).unwrap_or(p) };
        std::process::Command::new("xdg-open").arg(dir).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

/// «Открыть»: файл в программе по умолчанию.
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let p = checked_path(&path)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .raw_arg(format!("\"{}\"", p.display()))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open").arg(p).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describe_reads_small_and_marks_dirs() {
        let dir = std::env::temp_dir().join(format!("tuk-files-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("а б.txt");
        std::fs::write(&f, "привет").unwrap();
        let out = describe(&[f.clone(), dir.clone(), dir.join("нет.txt")]);
        assert_eq!(out[0].name, "а б.txt");
        assert_eq!(out[0].size, "привет".len() as u64);
        assert_eq!(crate::net::b64decode(out[0].data.as_deref().unwrap()).unwrap(), "привет".as_bytes());
        assert!(out[1].dir && out[1].data.is_none());
        assert!(out[2].error.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_dropped_files_are_readable() {
        let p = PathBuf::from("/точно/не/брошен.txt");
        assert!(!is_allowed(&p));
        allow(&[p.clone()]);
        assert!(is_allowed(&p));
        assert_eq!(dropped_paths(), vec![p.display().to_string()]);
    }
}
