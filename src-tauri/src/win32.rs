//! Windows: немного Win32 для острова и питомца — состояние левой кнопки мыши,
//! «окно не забирает фокус», снятие лишней цели перетаскивания у WebView2
//! и переход в окно терминала сессии агента (по цепочке родительских процессов хука).
//!
//! По мотивам Coucou (MIT, Louis Raillé): src-tauri/src/platform/windows.rs.
//!
//! Функции объявлены вручную по их документированным C-сигнатурам, а не через
//! крейт `windows`: у него сигнатуры меняются от версии к версии (у Тука 0.58,
//! у Tauri — своя), а ABI самих функций Windows неизменен. HWND здесь — isize.

#![allow(non_snake_case)]

use tauri::{AppHandle, Manager, WebviewWindow};

const GWL_EXSTYLE: i32 = -20;
const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
const WS_EX_NOACTIVATE: isize = 0x0800_0000;
const VK_LBUTTON: i32 = 0x01;

#[link(name = "user32")]
extern "system" {
    fn GetAsyncKeyState(vk: i32) -> i16;
    #[cfg(target_pointer_width = "64")]
    fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
    #[cfg(target_pointer_width = "64")]
    fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
    #[cfg(target_pointer_width = "32")]
    fn GetWindowLongW(hwnd: isize, index: i32) -> i32;
    #[cfg(target_pointer_width = "32")]
    fn SetWindowLongW(hwnd: isize, index: i32, value: i32) -> i32;
    fn EnumChildWindows(parent: isize, cb: Option<unsafe extern "system" fn(isize, isize) -> i32>, lparam: isize) -> i32;
    fn GetClassNameW(hwnd: isize, buf: *mut u16, max: i32) -> i32;
    fn EnumWindows(cb: Option<unsafe extern "system" fn(isize, isize) -> i32>, lparam: isize) -> i32;
    fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
    fn IsWindowVisible(hwnd: isize) -> i32;
    fn IsWindow(hwnd: isize) -> i32;
    fn IsIconic(hwnd: isize) -> i32;
    fn GetWindow(hwnd: isize, cmd: u32) -> isize;
    fn GetWindowTextW(hwnd: isize, buf: *mut u16, max: i32) -> i32;
    fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
    fn SetForegroundWindow(hwnd: isize) -> i32;
    fn GetForegroundWindow() -> isize;
    fn keybd_event(vk: u8, scan: u8, flags: u32, extra: usize);
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> isize;
    fn Process32FirstW(snap: isize, entry: *mut ProcessEntry) -> i32;
    fn Process32NextW(snap: isize, entry: *mut ProcessEntry) -> i32;
    fn CloseHandle(h: isize) -> i32;
    fn GetCurrentProcessId() -> u32;
    fn AttachConsole(pid: u32) -> i32;
    fn FreeConsole() -> i32;
    fn GetConsoleWindow() -> isize;
    fn GetStdHandle(which: u32) -> isize;
    fn SetStdHandle(which: u32, h: isize) -> i32;
}

/// PROCESSENTRY32W
#[repr(C)]
struct ProcessEntry {
    size: u32,
    usage: u32,
    pid: u32,
    heap: usize,
    module: u32,
    threads: u32,
    parent: u32,
    pri: i32,
    flags: u32,
    exe: [u16; 260],
}

#[link(name = "ole32")]
extern "system" {
    fn RevokeDragDrop(hwnd: isize) -> i32;
}

unsafe fn get_ex(hwnd: isize) -> isize {
    #[cfg(target_pointer_width = "64")]
    return GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    #[cfg(target_pointer_width = "32")]
    return GetWindowLongW(hwnd, GWL_EXSTYLE) as isize;
}

unsafe fn set_ex(hwnd: isize, v: isize) {
    #[cfg(target_pointer_width = "64")]
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, v);
    #[cfg(target_pointer_width = "32")]
    SetWindowLongW(hwnd, GWL_EXSTYLE, v as i32);
}

fn hwnd_of(win: &WebviewWindow) -> Option<isize> {
    // `.0` — указатель (windows ≥ 0.58) или isize (старые версии); `as isize` подходит к обоим
    let raw = win.hwnd().ok()?.0 as isize;
    (raw != 0).then_some(raw)
}

/// Зажата ли левая кнопка мыши — единственный признак, что начинается
/// перетаскивание файла, ещё до того, как оно дошло до окна.
pub fn left_button_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_LBUTTON) as u16 & 0x8000) != 0 }
}

/// WS_EX_NOACTIVATE: клик по окну не отнимает фокус у того, где человек печатает;
/// WS_EX_TOOLWINDOW: окна нет в Alt-Tab.
pub fn make_non_activating(win: &WebviewWindow) {
    let Some(h) = hwnd_of(win) else { return };
    unsafe { set_ex(h, get_ex(h) | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW) }
}

/// Разрешить окну получать фокус (раскрытый остров с полем ввода) или снова запретить.
pub fn set_activating(win: &WebviewWindow, activating: bool) {
    let Some(h) = hwnd_of(win) else { return };
    unsafe {
        let ex = get_ex(h);
        let want = if activating { ex & !WS_EX_NOACTIVATE } else { ex | WS_EX_NOACTIVATE };
        if want != ex {
            set_ex(h, want);
        }
    }
}

unsafe extern "system" fn revoke_render_widget(hwnd: isize, _: isize) -> i32 {
    let mut name = [0u16; 64];
    let len = GetClassNameW(hwnd, name.as_mut_ptr(), name.len() as i32);
    if len > 0 && String::from_utf16_lossy(&name[..len as usize]) == "Chrome_RenderWidgetHostHWND" {
        let _ = RevokeDragDrop(hwnd);
    }
    1
}

/// Файлы из «классического» Проводника (Загрузки, Документы…) показывали курсор «нельзя».
/// wry ставит свою цель перетаскивания один раз, при создании окна; WebView2 позже
/// создаёт Chrome_RenderWidgetHostHWND со своей целью, и та перехватывает перетаскивание.
/// Снимаем её — OLE доходит до цели wry, и Tauri присылает DragDrop с путями.
/// Дёшево и повторяемо, поэтому вызывается при каждом нажатии кнопки мыши.
/// Вызывать только в главном потоке (там, где цель была зарегистрирована).
pub fn unblock_webview_drops(app: &AppHandle) {
    for label in ["main", "pet"] {
        let Some(win) = app.get_webview_window(label) else { continue };
        let Some(h) = hwnd_of(&win) else { continue };
        unsafe {
            EnumChildWindows(h, Some(revoke_render_widget), 0);
        }
    }
}

// ---------- Окно терминала сессии ----------

/// Логика без Win32 — проверяется тестами на любой ОС.
pub mod tree {
    use std::collections::HashMap;

    /// Вершины дерева процессов: дальше идти незачем — окно сессии не здесь.
    const TOPS: &[&str] = &[
        "explorer.exe", "services.exe", "wininit.exe", "winlogon.exe", "svchost.exe",
        "smss.exe", "csrss.exe", "system", "sihost.exe", "userinit.exe",
    ];
    pub const MAX_DEPTH: usize = 12;

    /// Предки процесса (ближайший первым), ниже рабочего стола. procs: pid → (родитель, имя exe).
    pub fn ancestors(procs: &HashMap<u32, (u32, String)>, start: u32) -> Vec<u32> {
        let mut out = Vec::new();
        let mut cur = start;
        while out.len() < MAX_DEPTH {
            let Some((parent, _)) = procs.get(&cur) else { break };
            let parent = *parent;
            if parent == 0 || parent == start || out.contains(&parent) {
                break;
            }
            let Some((_, exe)) = procs.get(&parent) else { break };
            if TOPS.contains(&exe.to_ascii_lowercase().as_str()) {
                break;
            }
            out.push(parent);
            cur = parent;
        }
        out
    }

    /// Какое окно поднять: окна ближайшего предка, у которого они есть; среди них —
    /// то, в заголовке которого имя папки проекта (редактор с несколькими проектами).
    pub fn choose(pids: &[u32], windows: &[(isize, u32, String)], folder: &str) -> Option<isize> {
        let folder = folder.to_lowercase();
        pids.iter().find_map(|pid| {
            let mine: Vec<&(isize, u32, String)> = windows.iter().filter(|w| w.1 == *pid).collect();
            let named = (!folder.is_empty()).then(|| mine.iter().find(|w| w.2.to_lowercase().contains(&folder))).flatten();
            named.or(mine.first()).map(|w| w.0)
        })
    }

    /// Последняя папка пути (оба разделителя).
    pub fn folder_name(path: &str) -> &str {
        path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or_default()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn t(e: &[(u32, u32, &str)]) -> HashMap<u32, (u32, String)> {
            e.iter().map(|(p, par, n)| (*p, (*par, n.to_string()))).collect()
        }

        #[test]
        fn windows_terminal_above_shells() {
            let procs = t(&[(1, 0, "System"), (10, 1, "explorer.exe"), (20, 10, "WindowsTerminal.exe"), (30, 20, "pwsh.exe"), (40, 30, "claude.exe"), (50, 40, "cmd.exe"), (60, 50, "Tuk.exe")]);
            assert_eq!(ancestors(&procs, 60), vec![50, 40, 30, 20]);
            let wins = vec![(0x100, 20, "pwsh — shield-thermal".to_string()), (0x200, 99, "Другое".to_string())];
            assert_eq!(choose(&ancestors(&procs, 60), &wins, "shield-thermal"), Some(0x100));
        }

        #[test]
        fn editor_window_named_after_project_wins() {
            let wins = vec![(1, 7, "a.ts — wire-marking — VS Code".to_string()), (2, 7, "calc.ts — shield-thermal — VS Code".to_string())];
            assert_eq!(choose(&[5, 7], &wins, "Shield-Thermal"), Some(2));
            assert_eq!(choose(&[5, 7], &wins, "нет-такого"), Some(1));
            assert_eq!(choose(&[5], &wins, ""), None);
        }

        #[test]
        fn loops_and_missing_parents_end_the_walk() {
            assert_eq!(ancestors(&t(&[(5, 6, "a.exe"), (6, 5, "b.exe")]), 5), vec![6]);
            assert_eq!(ancestors(&t(&[(5, 77, "a.exe")]), 5), Vec::<u32>::new());
            assert_eq!(ancestors(&HashMap::new(), 5), Vec::<u32>::new());
            assert_eq!(folder_name("C:\\Проекты\\tuk\\"), "tuk");
            assert_eq!(folder_name("/home/me/tuk"), "tuk");
        }
    }
}

fn process_table() -> std::collections::HashMap<u32, (u32, String)> {
    const TH32CS_SNAPPROCESS: u32 = 0x2;
    let mut out = std::collections::HashMap::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == -1 || snap == 0 {
            return out;
        }
        let mut e: ProcessEntry = std::mem::zeroed();
        e.size = std::mem::size_of::<ProcessEntry>() as u32;
        let mut ok = Process32FirstW(snap, &mut e);
        while ok != 0 {
            let len = e.exe.iter().position(|&c| c == 0).unwrap_or(e.exe.len());
            out.insert(e.pid, (e.parent, String::from_utf16_lossy(&e.exe[..len])));
            ok = Process32NextW(snap, &mut e);
        }
        CloseHandle(snap);
    }
    out
}

/// Видимые окна верхнего уровня с заголовком, не диалоги: (окно, процесс, заголовок).
fn top_windows() -> Vec<(isize, u32, String)> {
    unsafe extern "system" fn collect(hwnd: isize, lparam: isize) -> i32 {
        const GW_OWNER: u32 = 4;
        let list = &mut *(lparam as *mut Vec<(isize, u32, String)>);
        if IsWindowVisible(hwnd) == 0 || GetWindow(hwnd, GW_OWNER) != 0 {
            return 1;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        let mut text = [0u16; 512];
        let len = GetWindowTextW(hwnd, text.as_mut_ptr(), text.len() as i32);
        if len > 0 {
            list.push((hwnd, pid, String::from_utf16_lossy(&text[..len as usize])));
        }
        1
    }
    let mut list: Vec<(isize, u32, String)> = Vec::new();
    unsafe {
        EnumWindows(Some(collect), &mut list as *mut _ as isize);
    }
    list
}

/// Для шлюза хука (`Tuk.exe --hook`): предки этого процесса (ближайший первым) и
/// окно консоли, в которой запущен агент (классическая консоль принадлежит conhost,
/// он не предок — его находит AttachConsole). Вызывать после чтения stdin.
pub fn hook_origin() -> (Vec<u32>, isize) {
    let pids = tree::ancestors(&process_table(), unsafe { GetCurrentProcessId() });
    let console = unsafe {
        const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
        // stdin/stdout хука — каналы агента; подключение к консоли не должно их подменить
        const STD: [u32; 3] = [-10i32 as u32, -11i32 as u32, -12i32 as u32];
        let saved = STD.map(|w| GetStdHandle(w));
        if AttachConsole(ATTACH_PARENT_PROCESS) != 0 {
            let h = GetConsoleWindow();
            FreeConsole();
            for (w, old) in STD.iter().zip(saved) {
                SetStdHandle(*w, old);
            }
            h
        } else {
            0
        }
    };
    (pids, console)
}

fn bring_forward(hwnd: isize) -> bool {
    const SW_RESTORE: i32 = 9;
    const VK_MENU: u8 = 0x12;
    const KEYEVENTF_KEYUP: u32 = 0x2;
    unsafe {
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        }
        if SetForegroundWindow(hwnd) != 0 {
            return true;
        }
        // Windows отказывает, если последний ввод был не у нас: короткое нажатие Alt
        // снимает запрет (тот же приём используют переключатели окон)
        keybd_event(VK_MENU, 0, 0, 0);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
        SetForegroundWindow(hwnd) != 0 || GetForegroundWindow() == hwnd
    }
}

/// Поднять окно терминала сессии. `console` — окно консоли из хука (если живо и видно),
/// иначе окно ближайшего живого предка; среди окон — с именем папки в заголовке.
/// false — не нашли (вызывающий откроет папку проекта).
pub fn focus_terminal(pids: &[u32], console: isize, cwd: &str) -> bool {
    unsafe {
        if console != 0 && IsWindow(console) != 0 && IsWindowVisible(console) != 0 && bring_forward(console) {
            return true;
        }
    }
    if pids.is_empty() {
        return false;
    }
    // процессы могли завершиться, а их номера — достаться другим: проверяем, что
    // процесс с этим номером всё ещё потомок цепочки (родитель совпадает с записанным)
    let table = process_table();
    let alive: Vec<u32> = pids
        .iter()
        .enumerate()
        .filter(|(i, pid)| match (table.get(pid), pids.get(i + 1)) {
            (Some((parent, _)), Some(up)) => parent == up,
            (Some(_), None) => true,
            _ => false,
        })
        .map(|(_, p)| *p)
        .collect();
    let wins = top_windows();
    tree::choose(&alive, &wins, tree::folder_name(cwd)).is_some_and(bring_forward)
}
