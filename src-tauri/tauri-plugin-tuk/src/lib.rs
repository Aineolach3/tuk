//! Нативная часть Тука для Android. Вся работа — в Kotlin (android/), команды из JS
//! (`plugin:tuk|island`, `plugin:tuk|listen`, `plugin:tuk|speak`) Tauri передаёт туда напрямую.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
struct Handle<R: Runtime>(#[allow(dead_code)] tauri::plugin::PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("tuk")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let h = _api.register_android_plugin("ru.tuk.plugin", "TukPlugin")?;
                _app.manage(Handle(h));
            }
            Ok(())
        })
        .build()
}
