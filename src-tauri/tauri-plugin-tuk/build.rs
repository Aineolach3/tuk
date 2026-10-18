const COMMANDS: &[&str] = &["island", "listen", "speak"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
