const COMMANDS: &[&str] = &["island", "listen", "speak", "voice", "llm", "act"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
