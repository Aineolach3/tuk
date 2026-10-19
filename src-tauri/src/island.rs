//! Остров Тука у верхнего края экрана (только ПК).
//!
//! По мотивам Coucou (MIT, Louis Raillé): src-tauri/src/island.rs.
//!
//! Окно «main» — прозрачное, без рамки, поверх всех, не забирает фокус в
//! свёрнутом виде. Видимую форму (капсулу или панель) рисует только CSS,
//! фон самого окна и WebView2 всегда прозрачный. Размер окна меняется лишь
//! между двумя значениями:
//!   * hidden — окно ровно по капсуле (CAPSULE_*), принимает мышь целиком,
//!     опрос курсора спит;
//!   * peek / home — окно размером с самую большую панель (PANEL_*), а
//!     опрос курсора (~60 Гц) делает его «прозрачным для кликов» везде,
//!     кроме прямоугольника острова, который присылает страница.
//!
//! Так окно и CSS не могут разойтись: даже если размер окна «отстал» от
//! состояния страницы, лишняя часть окна прозрачна и пропускает клики.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

pub const LABEL: &str = "main";

/// Окно раскрытого острова, логические пиксели: панель 440×640 плюс поля под тень.
pub const PANEL_W: f64 = 480.0;
pub const PANEL_H: f64 = 680.0;
/// Окно свёрнутого острова: капсула 190×44 плюс чуть-чуть.
pub const CAPSULE_W: f64 = 200.0;
pub const CAPSULE_H: f64 = 48.0;

/// Поле вокруг острова, которое ещё считается «на острове» (логические px):
/// флаг click-through снимается чуть раньше, чем курсор дойдёт до кнопки.
const HIT_MARGIN: f64 = 10.0;

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
    /// Попадает ли точка в прямоугольник с полем `margin`.
    pub fn hit(&self, x: f64, y: f64, margin: f64) -> bool {
        self.w > 0.0 && self.h > 0.0 && x >= self.x - margin && x <= self.x + self.w + margin && y >= self.y - margin && y <= self.y + self.h + margin
    }
}

/// Будит и усыпляет поток опроса курсора: спрятанный остров почти ничего не стоит.
pub struct Gate {
    active: Mutex<bool>,
    cv: Condvar,
}

impl Gate {
    pub fn new() -> Self {
        Self { active: Mutex::new(false), cv: Condvar::new() }
    }

    pub fn set_active(&self, on: bool) {
        let mut g = self.active.lock().unwrap();
        *g = on;
        self.cv.notify_all();
    }

    pub fn is_active(&self) -> bool {
        *self.active.lock().unwrap()
    }

    /// Ждать включения не дольше `timeout`. Возвращает, включён ли опрос.
    pub fn wait_active(&self, timeout: Duration) -> bool {
        let g = self.active.lock().unwrap();
        if *g {
            return true;
        }
        let (g, _) = self.cv.wait_timeout(g, timeout).unwrap();
        *g
    }

    /// Ждать включения без ограничения.
    pub fn wait_forever(&self) {
        let mut g = self.active.lock().unwrap();
        while !*g {
            g = self.cv.wait(g).unwrap();
        }
    }
}

pub struct Island {
    pub gate: Gate,
    phase: Mutex<Phase>,
    rect: Mutex<Rect>,
    /// «primary» — основной экран, «cursor» — экран под мышью.
    screen: Mutex<String>,
    /// Последнее применённое значение click-through (чтобы не дёргать ОС зря).
    ignoring: AtomicBool,
    /// Над окном тащат файл: окно принимает мышь целиком, пока не бросят или не уведут.
    pub file_drag: AtomicBool,
}

impl Island {
    pub fn new() -> Self {
        Self {
            gate: Gate::new(),
            phase: Mutex::new(Phase::Hidden),
            rect: Mutex::new(Rect::default()),
            screen: Mutex::new("primary".into()),
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
    let w = window(app)?;
    let c = w.cursor_position().ok()?;
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
        .map(|ms| {
            ms.iter()
                .map(|m| (m.position().x, m.position().y, m.size().width, m.size().height, m.scale_factor().to_bits()))
                .collect()
        })
        .unwrap_or_default()
}

/// Поставить окно по центру верхнего края нужного экрана и задать размер по фазе.
pub fn apply_geometry(app: &AppHandle, isl: &Island) {
    let Some(win) = window(app) else { return };
    let pref = isl.screen();
    let Some(m) = target_monitor(app, &pref) else { return };
    let scale = m.scale_factor();
    let mp = *m.position();
    let ms = *m.size();
    let (lw, lh) = if isl.phase() == Phase::Hidden { (CAPSULE_W, CAPSULE_H) } else { (PANEL_W, PANEL_H) };
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
    // после изменения размера флаг надо выставить заново: окно берёт мышь,
    // следующий тик опроса решит по курсору
    isl.ignoring.store(false, Ordering::Relaxed);
    let _ = win.set_ignore_cursor_events(false);
}

/// Сменить фазу острова (её выбирает машина состояний на странице, src/island.ts).
pub fn set_phase(app: &AppHandle, isl: &Island, phase: Phase) {
    let before = {
        let mut p = isl.phase.lock().unwrap();
        let b = *p;
        *p = phase;
        b
    };
    if before != phase {
        apply_geometry(app, isl);
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
    isl.gate.set_active(phase != Phase::Hidden);
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

/// Поток опроса курсора. Пока остров раскрыт или выглядывает — 60 Гц:
/// click-through вне острова, событие `island-cursor` для страницы.
/// Пока спрятан — раз в 0,4 с смотрит только на мониторы (и на мышь при «за мышью»).
pub fn spawn_poll(app: AppHandle, isl: Arc<Island>) {
    std::thread::spawn(move || {
        let mut last_layout = layout_key(&app);
        let mut was_down = false;
        let mut last_inside: Option<bool> = None;
        let mut last_xy = (f64::MIN, f64::MIN);
        let mut ticks: u32 = 0;
        loop {
            if !isl.gate.wait_active(Duration::from_millis(400)) {
                last_inside = None;
                // спрятан: раскладка мониторов и экран под мышью
                let now = layout_key(&app);
                let layout_changed = now != last_layout;
                last_layout = now;
                let follow = isl.screen() == "cursor" && moved_to_other_monitor(&app);
                if layout_changed || follow {
                    reapply(&app, &isl);
                }
                continue;
            }
            std::thread::sleep(Duration::from_millis(16));
            ticks = ticks.wrapping_add(1);
            if ticks % 30 == 0 {
                let now = layout_key(&app);
                if now != last_layout {
                    last_layout = now;
                    reapply(&app, &isl);
                }
            }
            let Some(win) = window(&app) else { continue };
            let Ok(origin) = win.outer_position() else { continue };
            let scale = win.scale_factor().unwrap_or(1.0);
            let Ok(c) = win.cursor_position() else { continue };
            let x = (c.x - origin.x as f64) / scale;
            let y = (c.y - origin.y as f64) / scale;
            let (ww, wh) = win.inner_size().map(|s| (s.width as f64 / scale, s.height as f64 / scale)).unwrap_or((PANEL_W, PANEL_H));
            let r = *isl.rect.lock().unwrap();
            let inside = r.hit(x, y, HIT_MARGIN);

            // Нажатая кнопка над окном — возможно, начало перетаскивания файла.
            // Click-through (WS_EX_TRANSPARENT) прячет окно от WindowFromPoint, и
            // OLE не нашёл бы цель: пока кнопка зажата над окном, окно берёт мышь целиком.
            let down = left_button_down();
            if down && !was_down {
                #[cfg(windows)]
                {
                    let h = app.clone();
                    let _ = app.run_on_main_thread(move || crate::win32::unblock_webview_drops(&h));
                }
            }
            was_down = down;
            let over_window = x >= 0.0 && x <= ww && y >= 0.0 && y <= wh;
            let accept = inside || (down && over_window) || isl.file_drag.load(Ordering::Relaxed);
            if isl.ignoring.load(Ordering::Relaxed) == accept {
                isl.ignoring.store(!accept, Ordering::Relaxed);
                let _ = win.set_ignore_cursor_events(!accept);
            }

            let moved = (x - last_xy.0).abs() >= 1.0 || (y - last_xy.1).abs() >= 1.0;
            if moved || last_inside != Some(inside) {
                last_xy = (x, y);
                last_inside = Some(inside);
                let _ = app.emit_to(LABEL, "island-cursor", CursorPayload { x, y, inside });
            }
        }
    });
}

fn reapply(app: &AppHandle, isl: &Island) {
    let h = app.clone();
    let i = state(app);
    let _ = app.run_on_main_thread(move || {
        if let Some(i) = i {
            apply_geometry(&h, &i);
        }
    });
    let _ = isl; // сама геометрия меняется в главном потоке
    let _ = app.emit_to(LABEL, "island-screen", ());
}

/// Мышь ушла на другой монитор, чем тот, где сейчас остров.
fn moved_to_other_monitor(app: &AppHandle) -> bool {
    let (Some(win), Some((cx, cy))) = (window(app), cursor(app)) else { return false };
    let Ok(Some(cur)) = win.current_monitor() else { return false };
    if monitor_contains(&cur, cx, cy) {
        return false;
    }
    // курсор вообще на каком-то мониторе (а не в «дыре» между ними)
    app.available_monitors().map(|ms| ms.iter().any(|m| monitor_contains(m, cx, cy))).unwrap_or(false)
}

/// Зажата ли левая кнопка мыши (на Windows; на других системах — нет данных).
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
    fn rect_hit_with_margin() {
        let r = Rect { x: 20.0, y: 0.0, w: 440.0, h: 640.0 };
        assert!(r.hit(240.0, 300.0, 10.0));
        assert!(r.hit(12.0, 5.0, 10.0));
        assert!(!r.hit(5.0, 5.0, 10.0));
        assert!(!r.hit(240.0, 660.0, 10.0));
        assert!(!Rect::default().hit(0.0, 0.0, 10.0), "ничего не нарисовано — ничего не ловим");
    }

    #[test]
    fn zoom_correction_only_on_mismatch() {
        assert_eq!(zoom_correction(1.0, 1.25, 1.25), None);
        assert_eq!(zoom_correction(1.0, 1.0, 1.25), Some(0.8));
        assert_eq!(zoom_correction(1.0, 1.5, 1.0), Some(1.5));
        assert_eq!(zoom_correction(1.0, 0.0, 1.0), None);
    }
}
