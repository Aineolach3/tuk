//! Windows: немного Win32 для острова и питомца — состояние левой кнопки мыши,
//! «окно не забирает фокус» и снятие лишней цели перетаскивания у WebView2.
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
