// В релизной сборке на Windows не показывать консольное окно
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `Tuk.exe --hook` — шлюз для хуков Claude Code, без окна
    if std::env::args().any(|a| a == "--hook") {
        std::process::exit(tuk_lib::hook_main());
    }
    tuk_lib::run()
}
