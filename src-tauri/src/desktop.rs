//! Только для ПК: питомец на рабочем столе, музыка Windows, настройки хуков Claude Code.

use std::path::PathBuf;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------- Питомец ----------

fn pet_pos_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("pet-position.txt"))
}

fn load_pet_pos(app: &AppHandle) -> Option<(i32, i32)> {
    let s = std::fs::read_to_string(pet_pos_file(app)?).ok()?;
    let (x, y) = s.trim().split_once(',')?;
    Some((x.parse().ok()?, y.parse().ok()?))
}

fn save_pet_pos(app: &AppHandle, x: i32, y: i32) {
    if let Some(f) = pet_pos_file(app) {
        let _ = std::fs::write(f, format!("{x},{y}"));
    }
}

pub fn pet_show(app: &AppHandle, show: bool) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("pet") {
        if show {
            w.show().map_err(err)?;
        } else {
            w.close().map_err(err)?;
        }
        return Ok(());
    }
    if !show {
        return Ok(());
    }
    let w = WebviewWindowBuilder::new(app, "pet", WebviewUrl::App("index.html".into()))
        .title("Тук")
        .inner_size(150.0, 170.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .visible(false)
        .build()
        .map_err(err)?;
    // место с прошлого раза или правый нижний угол основного экрана
    let pos = load_pet_pos(app).or_else(|| {
        let m = w.primary_monitor().ok()??;
        let s = m.scale_factor();
        Some((
            m.position().x + m.size().width as i32 - (220.0 * s) as i32,
            m.position().y + m.size().height as i32 - (260.0 * s) as i32,
        ))
    });
    if let Some((x, y)) = pos {
        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
    }
    let _ = w.show();
    let a2 = app.clone();
    w.on_window_event(move |e| {
        if let tauri::WindowEvent::Moved(p) = e {
            save_pet_pos(&a2, p.x, p.y);
        }
    });
    Ok(())
}

/// Курсор относительно окна (логические пиксели) — чтобы глаза питомца следили за мышью по всему экрану.
pub fn cursor_rel(w: &tauri::WebviewWindow) -> Result<(f64, f64), String> {
    let c = w.cursor_position().map_err(err)?;
    let p = w.outer_position().map_err(err)?;
    let s = w.scale_factor().map_err(err)?;
    Ok(((c.x - p.x as f64) / s, (c.y - p.y as f64) / s))
}

// ---------- Claude Code ----------

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

pub fn claude_settings_path() -> PathBuf {
    home().join(".claude").join("settings.json")
}

/// {"exe": путь к Tuk.exe, "settings": путь к settings.json, "exists": есть ли файл}
pub fn claude_info() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(err)?;
    let p = claude_settings_path();
    Ok(format!(
        "{{\"exe\":{},\"settings\":{},\"exists\":{}}}",
        crate::net::json_str(&exe.display().to_string()),
        crate::net::json_str(&p.display().to_string()),
        p.exists()
    ))
}

pub fn claude_read() -> Result<String, String> {
    match std::fs::read_to_string(claude_settings_path()) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Записать settings.json; перед первой записью кладём резервную копию рядом.
pub fn claude_write(json: &str) -> Result<String, String> {
    let p = claude_settings_path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    let backup = p.with_extension("json.tuk-backup");
    if p.exists() && !backup.exists() {
        std::fs::copy(&p, &backup).map_err(err)?;
    }
    std::fs::write(&p, json).map_err(err)?;
    Ok(p.display().to_string())
}

// ---------- Музыка (Windows: системные медиа-элементы управления) ----------

#[cfg(windows)]
pub mod media {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager as Manager, GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Storage::Streams::DataReader;

    fn e<E: std::fmt::Debug>(x: E) -> String {
        format!("{x:?}")
    }

    /// Что играет: JSON или "null", если ничего.
    pub fn info() -> Result<String, String> {
        let mgr = Manager::RequestAsync().map_err(e)?.get().map_err(e)?;
        let Ok(s) = mgr.GetCurrentSession() else { return Ok("null".into()) };
        let props = s.TryGetMediaPropertiesAsync().map_err(e)?.get().map_err(e)?;
        let title = props.Title().map(|h| h.to_string()).unwrap_or_default();
        let artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();
        let app = s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default();
        let playing = s
            .GetPlaybackInfo()
            .and_then(|i| i.PlaybackStatus())
            .map(|st| st == Status::Playing)
            .unwrap_or(false);
        if title.is_empty() && !playing {
            return Ok("null".into());
        }
        let j = crate::net::json_str;
        Ok(format!(
            "{{\"title\":{},\"artist\":{},\"app\":{},\"playing\":{}}}",
            j(&title),
            j(&artist),
            j(&app),
            playing
        ))
    }

    /// Обложка в base64 (или пустая строка).
    pub fn thumb() -> Result<String, String> {
        let mgr = Manager::RequestAsync().map_err(e)?.get().map_err(e)?;
        let Ok(s) = mgr.GetCurrentSession() else { return Ok(String::new()) };
        let props = s.TryGetMediaPropertiesAsync().map_err(e)?.get().map_err(e)?;
        let Ok(r) = props.Thumbnail() else { return Ok(String::new()) };
        let stream = r.OpenReadAsync().map_err(e)?.get().map_err(e)?;
        let size = stream.Size().map_err(e)? as u32;
        if size == 0 || size > 8_000_000 {
            return Ok(String::new());
        }
        let reader = DataReader::CreateDataReader(&stream).map_err(e)?;
        reader.LoadAsync(size).map_err(e)?.get().map_err(e)?;
        let mut buf = vec![0u8; size as usize];
        reader.ReadBytes(&mut buf).map_err(e)?;
        Ok(crate::net::b64encode(&buf))
    }

    pub fn control(action: &str) -> Result<(), String> {
        let mgr = Manager::RequestAsync().map_err(e)?.get().map_err(e)?;
        let s = mgr.GetCurrentSession().map_err(e)?;
        let op = match action {
            "next" => s.TrySkipNextAsync(),
            "prev" => s.TrySkipPreviousAsync(),
            _ => s.TryTogglePlayPauseAsync(),
        };
        op.map_err(e)?.get().map_err(e)?;
        Ok(())
    }
}
