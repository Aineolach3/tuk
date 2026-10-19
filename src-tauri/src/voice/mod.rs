//! Голос на ПК: «Тук Тук», кнопка 🎤 и живой голос — офлайн, как на Android.
//! Сама работа — в win.rs (только Windows); на других системах команды
//! честно отвечают «недоступно». Логика без платформы — в logic.rs.
//!
//! Распознанная команда приходит в WebView событием `voice-wake`
//! { state: listen | partial | command | idle | error, text, manual },
//! а дальше её разбирает тот же парсер, что и на телефоне (app.ts → handleInput).

#[allow(dead_code)]
mod logic;
#[cfg(windows)]
mod ffi;
#[cfg(windows)]
mod win;

use serde::Serialize;
use tauri::AppHandle;

/// Что показать в ⚙ → «Компьютер» → «Тук Тук».
#[derive(Serialize)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct Status {
    /// есть ли в сборке libvosk.dll
    pub libs: bool,
    /// модель распознавания: none | downloading | ready | error
    pub model: String,
    /// голос выбранного пресета: none | downloading | ready | error
    pub voice: String,
    pub progress: u8,
    pub error: Option<String>,
    pub wake: bool,
    pub listening: bool,
}

#[cfg(not(windows))]
const NO: &str = "Голос на ПК пока есть только в Windows";

/// Состояние: есть ли библиотеки, скачаны ли модель и голос, слушает ли Тук.
#[tauri::command]
pub fn voice_status(app: AppHandle, preset: Option<String>) -> Option<Status> {
    #[cfg(windows)]
    return Some(win::status(&app, preset.as_deref().unwrap_or("tuk")));
    #[cfg(not(windows))]
    {
        let _ = (app, preset);
        None
    }
}

/// Скачать модель распознавания (`what = "model"`) или голос (`what = "voice"`, `preset`).
#[tauri::command]
pub fn voice_download(app: AppHandle, what: String, preset: Option<String>) -> Result<(), String> {
    #[cfg(windows)]
    {
        let id = if what == "model" { "model".to_string() } else { logic::preset(preset.as_deref().unwrap_or("tuk")).model.to_string() };
        return win::download(&app, &id);
    }
    #[cfg(not(windows))]
    {
        let _ = (app, what, preset);
        Err(NO.into())
    }
}

/// Включить или выключить постоянное слушание «Тук Тук».
#[tauri::command]
pub fn voice_wake(app: AppHandle, on: bool) -> Result<(), String> {
    #[cfg(windows)]
    return win::set_wake(&app, on);
    #[cfg(not(windows))]
    {
        let _ = (app, on);
        Err(NO.into())
    }
}

/// Кнопка 🎤: start | stop | cancel. Результат приходит событием `voice-wake`.
#[tauri::command]
pub fn voice_listen(app: AppHandle, action: String) -> Result<(), String> {
    #[cfg(windows)]
    return win::listen(&app, &action);
    #[cfg(not(windows))]
    {
        let _ = (app, action);
        Err(NO.into())
    }
}

/// Произнести текст живым голосом; false — голос не скачан (говорит WebView).
/// Промис завершается, когда Тук договорил.
#[tauri::command]
pub async fn voice_speak(app: AppHandle, text: String, preset: Option<String>) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let p = preset.unwrap_or_else(|| "tuk".into());
        return tauri::async_runtime::spawn_blocking(move || win::speak(&app, &text, &p)).await.map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let _ = (app, text, preset);
        Ok(false)
    }
}

#[tauri::command]
pub fn voice_speak_stop() {
    #[cfg(windows)]
    win::speak_stop();
}
