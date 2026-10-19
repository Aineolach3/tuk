//! Остров Тука у верхнего края экрана (только ПК).
//!
//! По мотивам Coucou (MIT, Louis Raillé): src-tauri/src/island.rs.
//!
//! Окно «main» — прозрачное, без рамки, поверх всех, не в Alt-Tab и не
//! забирает фокус, пока остров не раскрыт. Видимую форму (капсулу или панель)
//! рисует только CSS (`#shell`), фон окна и WebView2 всегда прозрачный.
//!
//! Размер окна — по фазе острова (hidden → peek → home), с полями под тень
//! (styles.css: `#shell` отстоит от краёв на 3 px сверху и 5–10 px по бокам):
//! при раскрытии окно растёт сразу, при сворачивании — через SHRINK_DELAY_MS,
//! когда пружинная анимация капсулы уже закончилась.
//!
//! Click-through: поток опроса курсора (~60 Гц в peek/home, 20 Гц в hidden)
//! делает окно «прозрачным для мыши» везде, кроме прямоугольника `#shell`,
//! который присылает страница (команда island_set_rect). Пока кнопка мыши
//! зажата над окном (возможно, тащат файл) или над ним висит перетаскивание
//! файла — окно принимает мышь целиком, иначе Проводник не нашёл бы цель.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

pub const LABEL: &str = "main";

/// Поле вокруг острова, которое ещё считается «на острове» (логические px):
/// флаг click-through снимается чуть раньше, чем курсор дойдёт до кнопки.
const HIT_MARGIN: f64 = 6.0;
/// Свернуть окно после анимации сворачивания капсулы.
const SHRINK_DELAY_MS: u64 = 320;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    Hidden,
    Peek,
    Home,
}

impl Phase {
    pub fn parse(s: &str) -> Option<Phase> {
        match s {
            "hidden" | "collapsed" => Some(Phase::Hidden),
            "peek" | "compact" => Some(Phase::Peek),
            "home" | "expanded" => Some(Phase::Home),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Hidden => "hidden",
            Phase::Peek => "peek",
            Phase::Home => "home",
        }
    }

    /// Логический размер окна: капсула/панель из styles.css плюс поля под тень.
    pub fn window_size(self) -> (f64, f64) {
        match self {
            Phase::Hidden => (210.0, 56.0), // капсула ≈ 190×44
            Phase::Peek => (440.0, 96.0),   // строка ≈ 420×84
            Phase::Home => (460.0, 656.0),  // панель ≈ 440×640
        }
    }
}

/// Прямоугольник острова в логических координатах окна (присылает страница).
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn is_empty(&self) -> bool {
        self.w <= 0.0 || self.h <= 0.0
    }

    /// Попадает ли точка в прямоугольник с полем `margin`.
    pub fn hit(&self, x: f64, y: f64, margin: f64) -> bool {
        !self.is_empty() && x >= self.x - margin && x <= self.x + self.w + margin && y >= self.y - margin && y <= self.y + self.h + margin
    }
}

/// Принимает ли окно мышь в этой точке. Пока страница не прислала форму
/// острова — окно целиком (иначе свёрнутый остров нельзя было бы открыть).
pub fn accepts(rect: &Rect, x: f64, y: f64, window: (f64, f64), button_down: bool, file_drag: bool) -> bool {
    let over_window = x >= 0.0 && x <= window.0 && y >= 0.0 && y <= window.1;
    if rect.is_empty() {
        return over_window;
    }
    rect.hit(x, y, HIT_MARGIN) || (button_down && over_window) || file_drag
}

pub struct Island {
    phase: Mutex<Phase>,
    rect: Mutex<Rect>,
    /// «primary» — основной экран, «cursor» — экран под мышью.
    screen: Mutex<String>,
    /// Растёт при каждой смене фазы: отложенное сжатие окна старой фазы отменяется.
    generation: AtomicU64,
    /// Последнее применённое значение click-through (чтобы не дёргать ОС зря).
    ignoring: AtomicBool,
    /// Над окном тащат файл: окно принимает мышь целиком, пока не бросят или не уведут.
    pub file_drag: AtomicBool,
}

impl Island {
    pub fn new() -> Self {
        Self {
            phase: Mutex::new(Phase::Hidden),
            rect: Mutex::new(Rect::default()),
            screen: Mutex::new("primary".into()),
            generation: AtomicU64::new(0),
            ignoring: AtomicBool::new(false),
            file_drag: AtomicBool::new(false),
        }
    }

    pub fn phase(&self) -> Phase {
        *self.phase.lock().unwrap()
    }

    pub fn screen(&self) -> String {
        self.screen.lock().unwrap().clone()
    }
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

pub fn state(app: &AppHandle) -> Option<Arc<Island>> {
    app.try_state::<Arc<Island>>().map(|s| s.inner().clone())
}

fn monitor_contains(m: &Monitor, x: f64, y: f64) -> bool {
    let p = m.position();
    let s = m.size();
    x >= p.x as f64 && x < p.x as f64 + s.width as f64 && y >= p.y as f64 && y < p.y as f64 + s.height as f64
}

/// Курсор в физических пикселях экрана.
pub fn cursor(app: &AppHandle) -> Option<(f64, f64)> {
    let c = window(app)?.cursor_position().ok()?;
    Some((c.x, c.y))
}

/// Экран острова: под мышью (настройка «за мышью») или основной.
fn target_monitor(app: &AppHandle, pref: &str) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    if pref == "cursor" {
        if let Some((cx, cy)) = cursor(app) {
            if let Some(m) = monitors.iter().find(|m| monitor_contains(m, cx, cy)) {
                return Some(m.clone());
            }
        }
    }
    app.primary_monitor().ok().flatten().or_else(|| monitors.into_iter().next())
}

/// Ключ раскладки мониторов: любое изменение — остров надо поставить заново.
fn layout_key(app: &AppHandle) -> Vec<(i32, i32, u32, u32, u64)> {
    app.available_monitors()
        .map(|ms| ms.iter().map(|m| (m.position().x, m.position().y, m.size().width, m.size().height, m.scale_factor().to_bits())).collect())
        .unwrap_or_default()
}

/// Поставить окно по центру верхнего края нужного экрана, размер — для фазы `phase`.
pub fn place(app: &AppHandle, isl: &Island, phase: Phase) {
    let Some(win) = window(app) else { return };
    let Some(m) = target_monitor(app, &isl.screen()) else { return };
    let scale = m.scale_factor();
    let mp = *m.position();
    let ms = *m.size();
    let (lw, lh) = phase.window_size();
    let pw = (lw * scale).round().max(1.0) as u32;
    let ph = (lh * scale).round().max(1.0) as u32;
    let x = mp.x + (ms.width as i32 - pw as i32) / 2;
    let y = mp.y;
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_position(PhysicalPosition::new(x, y));
    // переход на экран с другим масштабом может пересчитать размер — повторяем
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    if let Ok(got) = win.inner_size() {
        if got.width != pw || got.height != ph {
            let _ = win.set_size(PhysicalSize::new(pw, ph));
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    }
    let _ = win.set_always_on_top(true);
    // после изменения размера флаг выставляем заново: окно берёт мышь,
    // следующий тик опроса решит по курсору
    isl.ignoring.store(false, Ordering::Relaxed);
    let _ = win.set_ignore_cursor_events(false);
}

/// Поставить окно для текущей фазы (смена экрана, раскладки мониторов).
pub fn apply_geometry(app: &AppHandle, isl: &Island) {
    place(app, isl, isl.phase());
}

/// Сменить фазу острова (её выбирает машина состояний на странице, src/island.ts).
/// Повторная отправка той же фазы ничего не делает (страница шлёт её и раз в
/// секунду — на случай, если вызов IPC потерялся).
pub fn set_phase(app: &AppHandle, isl: &Arc<Island>, phase: Phase) {
    let before = std::mem::replace(&mut *isl.phase.lock().unwrap(), phase);
    if before == phase {
        return;
    }
    let gen = isl.generation.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let (bw, bh) = before.window_size();
        let (nw, nh) = phase.window_size();
        if nw >= bw && nh >= bh {
            // растёт — сразу, чтобы раскрывающаяся капсула не обрезалась
            place(app, isl, phase);
        } else {
            // сжимается — после анимации; до тех пор лишняя часть окна прозрачна
            // и пропускает клики (опрос курсора)
            let (app2, isl2) = (app.clone(), isl.clone());
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(SHRINK_DELAY_MS));
                if isl2.generation.load(Ordering::SeqCst) != gen {
                    return;
                }
                let app3 = app2.clone();
                let _ = app2.run_on_main_thread(move || {
                    if isl2.generation.load(Ordering::SeqCst) == gen {
                        apply_geometry(&app3, &isl2);
                    }
                });
            });
        }
    }
    if let Some(win) = window(app) {
        // фокус — только раскрытому острову (там поле ввода); в остальных фазах
        // клик по Туку не отнимает фокус у программы, где человек печатает
        #[cfg(windows)]
        crate::win32::set_activating(&win, phase == Phase::Home);
        if phase == Phase::Home {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

pub fn set_rect(isl: &Island, r: Rect) {
    *isl.rect.lock().unwrap() = r;
}

pub fn set_screen(app: &AppHandle, isl: &Island, pref: &str) {
    let pref = if pref == "cursor" { "cursor" } else { "primary" };
    *isl.screen.lock().unwrap() = pref.to_string();
    apply_geometry(app, isl);
}

/// Коэффициент масштаба страницы, чтобы 1 CSS px = 1 логический px окна.
/// Если WebView2 сообщает devicePixelRatio, отличный от масштаба окна (крупный
/// текст в «Специальных возможностях», разные DPI мониторов), панель обрезается.
pub fn zoom_correction(current_zoom: f64, scale: f64, dpr: f64) -> Option<f64> {
    if dpr <= 0.0 || !dpr.is_finite() || scale <= 0.0 || !scale.is_finite() {
        return None;
    }
    if (dpr - scale).abs() / scale < 0.02 {
        return None;
    }
    Some((current_zoom * (scale / dpr)).clamp(0.25, 4.0))
}

static ZOOM: Mutex<f64> = Mutex::new(1.0);

pub fn fit_zoom(app: &AppHandle, dpr: f64) -> bool {
    let Some(win) = window(app) else { return false };
    let scale = win.scale_factor().unwrap_or(1.0);
    let mut zoom = ZOOM.lock().unwrap();
    match zoom_correction(*zoom, scale, dpr) {
        Some(z) => {
            *zoom = z;
            let _ = win.set_zoom(z);
            true
        }
        None => false,
    }
}

#[derive(Serialize, Clone)]
struct CursorPayload {
    x: f64,
    y: f64,
    inside: bool,
}

/// Поток опроса курсора (один на всё время работы).
/// События для страницы:
///   `island-cursor` { x, y, inside } — курсор в координатах окна; inside — над островом;
///   `island-outside` — нажата кнопка мыши вне острова (клик мимо — свернуть);
///   `island-screen` — остров переставлен (сменились мониторы / экран под мышью).
pub fn spawn_poll(app: AppHandle, isl: Arc<Island>) {
    std::thread::spawn(move || {
        let mut last_layout = layout_key(&app);
        let mut was_down = false;
        let mut last_inside: Option<bool> = None;
        let mut last_xy = (f64::MIN, f64::MIN);
        let mut ticks: u32 = 0;
        // поколение фазы на прошлой проверке: размер сверяем, только когда фаза
        // не менялась целую проверку (иначе помешали бы отложенному сжатию)
        let mut settled_gen = u64::MAX;
        loop {
            let phase = isl.phase();
            // спрятанный остров: 20 Гц; выглянул/раскрыт: ~60 Гц
            std::thread::sleep(Duration::from_millis(if phase == Phase::Hidden { 50 } else { 16 }));
            ticks = ticks.wrapping_add(1);

            // мониторы подключили/отключили/поменяли масштаб; «за мышью» — мышь ушла на другой экран;
            // размер окна не совпал с фазой (Windows иногда «съедает» resize при смене DPI) —
            // ставим заново. Это и есть защита от «большого тёмного прямоугольника».
            if ticks % 25 == 0 {
                let now = layout_key(&app);
                let changed = now != last_layout;
                last_layout = now;
                let follow = phase == Phase::Hidden && isl.screen() == "cursor" && moved_to_other_monitor(&app);
                let gen = isl.generation.load(Ordering::SeqCst);
                let settled = gen == settled_gen;
                settled_gen = gen;
                if changed || follow || (settled && size_wrong(&app, phase)) {
                    reapply(&app, &isl);
                }
            }

            let Some(win) = window(&app) else { continue };
            let Ok(origin) = win.outer_position() else { continue };
            let scale = win.scale_factor().unwrap_or(1.0);
            let Ok(c) = win.cursor_position() else { continue };
            let x = (c.x - origin.x as f64) / scale;
            let y = (c.y - origin.y as f64) / scale;
            let size = win.inner_size().map(|s| (s.width as f64 / scale, s.height as f64 / scale)).unwrap_or(phase.window_size());
            let r = *isl.rect.lock().unwrap();
            let inside = if r.is_empty() { x >= 0.0 && x <= size.0 && y >= 0.0 && y <= size.1 } else { r.hit(x, y, HIT_MARGIN) };

            let down = left_button_down();
            if down && !was_down {
                // нажатие — возможно, начало перетаскивания файла: заранее снимаем
                // лишнюю цель перетаскивания WebView2 (см. win32.rs)
                #[cfg(windows)]
                {
                    let h = app.clone();
                    let _ = app.run_on_main_thread(move || crate::win32::unblock_webview_drops(&h));
                }
                if !inside && phase != Phase::Hidden {
                    let _ = app.emit_to(LABEL, "island-outside", ());
                }
            }
            was_down = down;

            let accept = accepts(&r, x, y, size, down, isl.file_drag.load(Ordering::Relaxed));
            if isl.ignoring.load(Ordering::Relaxed) == accept {
                isl.ignoring.store(!accept, Ordering::Relaxed);
                let _ = win.set_ignore_cursor_events(!accept);
            }

            let moved = (x - last_xy.0).abs() >= 1.0 || (y - last_xy.1).abs() >= 1.0;
            // в hidden страница узнаёт только вход/выход (наведение → peek)
            if last_inside != Some(inside) || (moved && phase != Phase::Hidden) {
                last_xy = (x, y);
                last_inside = Some(inside);
                let _ = app.emit_to(LABEL, "island-cursor", CursorPayload { x, y, inside });
            }
        }
    });
}

/// Поставить остров заново (геометрия меняется в главном потоке) и сказать странице.
fn reapply(app: &AppHandle, isl: &Arc<Island>) {
    let h = app.clone();
    let i = isl.clone();
    let _ = app.run_on_main_thread(move || apply_geometry(&h, &i));
    let _ = app.emit_to(LABEL, "island-screen", ());
}

/// Окно не того размера, что нужен фазе (больше чем на 2 px).
fn size_wrong(app: &AppHandle, phase: Phase) -> bool {
    let Some(win) = window(app) else { return false };
    let (Ok(size), Ok(scale)) = (win.inner_size(), win.scale_factor()) else { return false };
    let (lw, lh) = phase.window_size();
    (size.width as f64 - lw * scale).abs() > 2.0 || (size.height as f64 - lh * scale).abs() > 2.0
}

/// Мышь ушла на другой монитор, чем тот, где сейчас остров.
fn moved_to_other_monitor(app: &AppHandle) -> bool {
    let (Some(win), Some((cx, cy))) = (window(app), cursor(app)) else { return false };
    let Ok(Some(cur)) = win.current_monitor() else { return false };
    if monitor_contains(&cur, cx, cy) {
        return false;
    }
    // курсор на каком-то мониторе (а не в «дыре» между ними)
    app.available_monitors().map(|ms| ms.iter().any(|m| monitor_contains(m, cx, cy))).unwrap_or(false)
}

/// Зажата ли левая кнопка мыши (Windows; на других системах данных нет).
pub fn left_button_down() -> bool {
    #[cfg(windows)]
    return crate::win32::left_button_down();
    #[cfg(not(windows))]
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_names_and_old_modes() {
        assert_eq!(Phase::parse("hidden"), Some(Phase::Hidden));
        assert_eq!(Phase::parse("collapsed"), Some(Phase::Hidden));
        assert_eq!(Phase::parse("compact"), Some(Phase::Peek));
        assert_eq!(Phase::parse("expanded"), Some(Phase::Home));
        assert_eq!(Phase::parse("что-то"), None);
        assert_eq!(Phase::Home.as_str(), "home");
    }

    #[test]
    fn windows_grow_with_phase() {
        let (h, p, o) = (Phase::Hidden.window_size(), Phase::Peek.window_size(), Phase::Home.window_size());
        assert!(h.0 < p.0 && p.0 < o.0 && h.1 < p.1 && p.1 < o.1);
    }

    #[test]
    fn rect_hit_with_margin() {
        let r = Rect { x: 10.0, y: 3.0, w: 440.0, h: 640.0 };
        assert!(r.hit(240.0, 300.0, 6.0));
        assert!(r.hit(5.0, 5.0, 6.0));
        assert!(!r.hit(1.0, 5.0, 6.0));
        assert!(!Rect::default().hit(0.0, 0.0, 6.0));
    }

    #[test]
    fn click_through_outside_island() {
        let r = Rect { x: 10.0, y: 3.0, w: 190.0, h: 44.0 };
        let win = (210.0, 56.0);
        assert!(accepts(&r, 100.0, 20.0, win, false, false));
        assert!(!accepts(&r, 205.0, 54.0, win, false, false), "угол тени пропускает клики");
        assert!(accepts(&r, 205.0, 54.0, win, true, false), "кнопка зажата над окном — может быть перетаскивание файла");
        assert!(!accepts(&r, 400.0, 300.0, win, true, false), "кнопка зажата далеко — не наше");
        assert!(accepts(&r, 400.0, 300.0, win, false, true), "над окном тащат файл");
        assert!(accepts(&Rect::default(), 100.0, 20.0, win, false, false), "форма ещё неизвестна — окно целиком");
    }

    #[test]
    fn zoom_correction_only_on_mismatch() {
        assert_eq!(zoom_correction(1.0, 1.25, 1.25), None);
        assert_eq!(zoom_correction(1.0, 1.0, 1.25), Some(0.8));
        assert_eq!(zoom_correction(1.0, 1.5, 1.0), Some(1.5));
        assert_eq!(zoom_correction(1.0, 0.0, 1.0), None);
    }
}
