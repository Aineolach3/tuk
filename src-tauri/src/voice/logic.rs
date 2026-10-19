//! «Тук Тук» без платформы: поиск слова-активатора, разбор JSON от Vosk,
//! машина состояний «ждёт → слушает команду → передаёт», писк и разбивка ответа на фразы.
//! Здесь нет ни Windows, ни Tauri — файл проверяется `rustc --test` отдельно.
//! Логика повторяет Android (Wake.kt), чтобы Тук вёл себя одинаково.

/// Как Vosk small-ru слышит «тук»: иногда «тут» или «тюк».
const WAKE_WORDS: [&str; 3] = ["тук", "тут", "тюк"];
/// Сколько ждать команду после «Тук Тук», мс.
pub const COMMAND_MS: u64 = 8000;
/// Пока человек говорит, продлеваем ожидание на столько, мс.
pub const SPEAKING_MS: u64 = 4000;

/// Нижний регистр, «ё» → «е», дефисы и знаки — пробелы.
pub fn normalize(t: &str) -> String {
    let low: String = t
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'ё' => 'е',
            c if c.is_alphanumeric() => c,
            _ => ' ',
        })
        .collect();
    low.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Где кончается «тук тук» (индекс слова после него), если оно есть.
fn wake_end(words: &[&str]) -> Option<usize> {
    (1..words.len()).find(|&i| WAKE_WORDS.contains(&words[i - 1]) && WAKE_WORDS.contains(&words[i])).map(|i| i + 1)
}

/// Есть ли во фразе «тук тук».
pub fn has_wake(t: &str) -> bool {
    let n = normalize(t);
    let w: Vec<&str> = n.split(' ').collect();
    wake_end(&w).is_some()
}

/// Что сказано после «тук тук» (или вся фраза, если его нет).
pub fn after_wake(t: &str) -> String {
    let n = normalize(t);
    let w: Vec<&str> = n.split(' ').filter(|s| !s.is_empty()).collect();
    match wake_end(&w) {
        Some(i) => w[i..].join(" "),
        None => w.join(" "),
    }
}

/// Строковое поле из JSON Vosk: `{"text" : "…"}` или `{"partial" : "…"}`.
pub fn json_field(json: &str, key: &str) -> String {
    let pat = format!("\"{key}\"");
    let Some(p) = json.find(&pat) else { return String::new() };
    let rest = &json[p + pat.len()..];
    let Some(colon) = rest.find(':') else { return String::new() };
    let rest = rest[colon + 1..].trim_start();
    let mut it = rest.chars();
    if it.next() != Some('"') {
        return String::new();
    }
    let mut out = String::new();
    while let Some(c) = it.next() {
        match c {
            '"' => return out,
            '\\' => match it.next() {
                Some('n') => out.push(' '),
                Some('t') => out.push(' '),
                Some('u') => {
                    let hex: String = it.by_ref().take(4).collect();
                    if let Some(ch) = u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                        out.push(ch);
                    }
                }
                Some(o) => out.push(o),
                None => break,
            },
            c => out.push(c),
        }
    }
    out
}

/// Что сообщить наружу.
#[derive(Debug, Clone, PartialEq)]
pub enum Ev {
    /// Услышал «Тук Тук» — пискнуть и показать «слушаю».
    Listen,
    /// Человек говорит команду — промежуточный текст.
    Partial(String),
    /// Команда готова. `beep` — пискнуть (команда пришла вместе с «Тук Тук»).
    Command { text: String, beep: bool },
    /// Команды не дождались — снова ждём «Тук Тук».
    Idle,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum St {
    Wait,
    Command { until: u64 },
}

/// Машина состояний «Тук Тук». Время — миллисекунды от любого начала отсчёта.
#[derive(Debug)]
pub struct Wake {
    st: St,
    partial: String,
}

impl Default for Wake {
    fn default() -> Self {
        Self::new()
    }
}

impl Wake {
    pub const fn new() -> Self {
        Wake { st: St::Wait, partial: String::new() }
    }

    pub fn listening(&self) -> bool {
        matches!(self.st, St::Command { .. })
    }

    /// Что уже сказано в команде (для строки ввода, пока говорят).
    pub fn partial(&self) -> &str {
        &self.partial
    }

    /// Сразу слушать команду, без «Тук Тук» (кнопка 🎤).
    pub fn force_command(&mut self, now: u64) {
        self.st = St::Command { until: now + COMMAND_MS };
        self.partial.clear();
    }

    /// Вернуться к ожиданию «Тук Тук».
    pub fn reset(&mut self) {
        self.st = St::Wait;
        self.partial.clear();
    }

    fn enter_command(&mut self, now: u64) -> Ev {
        self.force_command(now);
        Ev::Listen
    }

    fn deliver(&mut self, text: String, beep: bool) -> Ev {
        self.reset();
        Ev::Command { text, beep }
    }

    /// Промежуточный результат распознавания.
    pub fn on_partial(&mut self, t: &str, now: u64) -> Option<Ev> {
        if t.trim().is_empty() {
            return None;
        }
        match self.st {
            St::Wait if has_wake(t) => Some(self.enter_command(now)),
            St::Wait => None,
            St::Command { until } => {
                let rest = after_wake(t);
                if rest.is_empty() || rest == self.partial {
                    return None;
                }
                self.partial = rest.clone();
                self.st = St::Command { until: until.max(now + SPEAKING_MS) };
                Some(Ev::Partial(rest))
            }
        }
    }

    /// Законченная фраза (Vosk услышал паузу).
    pub fn on_final(&mut self, t: &str, now: u64) -> Option<Ev> {
        match self.st {
            St::Wait if has_wake(t) => {
                let rest = after_wake(t);
                if rest.chars().count() > 2 {
                    Some(self.deliver(rest, true))
                } else {
                    Some(self.enter_command(now))
                }
            }
            St::Wait => None,
            St::Command { .. } => {
                let rest = after_wake(t);
                if rest.chars().count() > 1 {
                    Some(self.deliver(rest, false))
                } else {
                    None
                }
            }
        }
    }

    /// Каждые ~100 мс: не истекло ли ожидание команды.
    pub fn tick(&mut self, now: u64) -> Option<Ev> {
        match self.st {
            St::Command { until } if now >= until => {
                self.reset();
                Some(Ev::Idle)
            }
            _ => None,
        }
    }

    /// Кнопка «Закончить»: отдать то, что успели сказать.
    pub fn finish(&mut self) -> Ev {
        let text = std::mem::take(&mut self.partial);
        if text.is_empty() {
            self.reset();
            Ev::Idle
        } else {
            self.deliver(text, false)
        }
    }
}

// ---------------- Звук ----------------

/// Float [-1; 1] → PCM 16 бит.
pub fn to_i16(samples: &[f32]) -> Vec<i16> {
    samples.iter().map(|&x| (x.clamp(-1.0, 1.0) * 32767.0) as i16).collect()
}

/// Писк «слушаю»: два коротких тона вверх, с мягкими краями.
pub fn beep_samples(rate: u32) -> Vec<i16> {
    let mut out = Vec::new();
    for (freq, ms) in [(880.0f32, 70u32), (1320.0, 90)] {
        let n = (rate * ms / 1000) as usize;
        let fade = (rate / 200) as usize; // 5 мс
        for i in 0..n {
            let edge = (i.min(n - 1 - i) as f32 / fade as f32).min(1.0);
            let x = (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin() * 0.3 * edge;
            out.push((x * 32767.0) as i16);
        }
    }
    out
}

/// Разбить ответ на фразы: первая звучит почти сразу, следующие готовятся, пока играет предыдущая.
pub fn sentences(text: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    let mut chars = text.trim().chars().peekable();
    while let Some(c) = chars.next() {
        cur.push(c);
        let end = matches!(c, '.' | '!' | '?' | '…' | ';' | ':');
        if end && chars.peek().map_or(true, |n| n.is_whitespace()) {
            parts.push(std::mem::take(&mut cur));
        }
    }
    parts.push(cur);
    let mut out = Vec::new();
    for p in parts {
        let p = p.trim();
        if p.is_empty() {
            continue;
        }
        let ch: Vec<char> = p.chars().collect();
        if ch.len() <= 220 {
            out.push(p.to_string());
        } else {
            for c in ch.chunks(200) {
                let s: String = c.iter().collect();
                if !s.trim().is_empty() {
                    out.push(s.trim().to_string());
                }
            }
        }
    }
    out
}

/// Ускорить звук в `factor` раз (линейная интерполяция): голос выше и быстрее.
/// Как на Android, где голос играет с частотой `rate * pitch`, а синтез идёт с `length_scale = pitch`:
/// темп остаётся прежним, а голос становится звонче.
pub fn speed_up(samples: &[f32], factor: f32) -> Vec<f32> {
    if samples.is_empty() || !(factor > 0.0) || (factor - 1.0).abs() < 1e-3 {
        return samples.to_vec();
    }
    let n = ((samples.len() - 1) as f32 / factor) as usize + 1;
    (0..n)
        .map(|i| {
            let x = i as f32 * factor;
            let j = (x as usize).min(samples.len() - 1);
            let k = (j + 1).min(samples.len() - 1);
            let f = x - j as f32;
            samples[j] * (1.0 - f) + samples[k] * f
        })
        .collect()
}

/// Голоса Тука (как на Android): модель piper и «высота» (скорость воспроизведения).
#[derive(Debug, Clone, Copy)]
pub struct Preset {
    pub model: &'static str,
    pub pitch: f32,
    pub noise: f32,
}

pub fn preset(id: &str) -> Preset {
    match id {
        "bright" => Preset { model: "irina", pitch: 1.18, noise: 0.72 },
        "boy" => Preset { model: "denis", pitch: 1.3, noise: 0.72 },
        "calm" => Preset { model: "dmitri", pitch: 1.0, noise: 0.6 },
        _ => Preset { model: "dmitri", pitch: 1.22, noise: 0.72 },
    }
}

/// Общий прогресс скачивания: модель распознавания и голос по их размерам, 0..=99.
pub fn progress(done: u64, total: u64) -> u8 {
    if total == 0 {
        return 0;
    }
    ((done.min(total) * 99) / total) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wake_word() {
        assert!(has_wake("тук тук"));
        assert!(has_wake("ну тук-тук напомни"));
        assert!(has_wake("Тут тук"));
        assert!(!has_wake("тук"));
        assert!(!has_wake("тукан тук"));
        assert_eq!(after_wake("тук тук напомни через час позвонить"), "напомни через час позвонить");
        assert_eq!(after_wake("эй тюк тук, который час?"), "который час");
        assert_eq!(after_wake("который час"), "который час");
        assert_eq!(after_wake("тук тук"), "");
        assert_eq!(normalize("Ёлка  —  ёж"), "елка еж");
    }

    #[test]
    fn vosk_json() {
        assert_eq!(json_field("{\n  \"partial\" : \"тук тук\"\n}", "partial"), "тук тук");
        assert_eq!(json_field("{\n  \"text\" : \"\"\n}", "text"), "");
        assert_eq!(json_field("{\"text\":\"a\\\"b\\u0436\"}", "text"), "a\"bж");
        assert_eq!(json_field("{\"partial\":\"x\"}", "text"), "");
    }

    #[test]
    fn command_in_same_phrase() {
        let mut w = Wake::new();
        assert_eq!(w.on_final("тук тук напомни позвонить", 0), Some(Ev::Command { text: "напомни позвонить".into(), beep: true }));
        assert!(!w.listening());
    }

    #[test]
    fn command_after_pause() {
        let mut w = Wake::new();
        assert_eq!(w.on_partial("тук", 0), None);
        assert_eq!(w.on_partial("тук тук", 100), Some(Ev::Listen));
        assert!(w.listening());
        // конец той же фразы без команды — продолжаем слушать
        assert_eq!(w.on_final("тук тук", 600), None);
        assert_eq!(w.on_partial("который", 1500), Some(Ev::Partial("который".into())));
        assert_eq!(w.on_partial("который", 1600), None);
        assert_eq!(w.partial(), "который");
        assert_eq!(w.on_final("который час", 2500), Some(Ev::Command { text: "который час".into(), beep: false }));
        assert!(!w.listening());
    }

    #[test]
    fn timeout_and_extension() {
        let mut w = Wake::new();
        w.on_partial("тук тук", 0);
        assert_eq!(w.tick(7000), None);
        // говорит в 7 с — ждём до 11 с
        w.on_partial("поставь", 7000);
        assert_eq!(w.tick(9000), None);
        assert_eq!(w.tick(11_000), Some(Ev::Idle));
        assert_eq!(w.tick(12_000), None);
    }

    #[test]
    fn button_and_finish() {
        let mut w = Wake::new();
        w.force_command(0);
        w.on_partial("таймер на пять", 500);
        assert_eq!(w.finish(), Ev::Command { text: "таймер на пять".into(), beep: false });
        w.force_command(0);
        assert_eq!(w.finish(), Ev::Idle);
        // без «Тук Тук» в режиме ожидания ничего не происходит
        assert_eq!(w.on_final("включи свет", 0), None);
    }

    #[test]
    fn pcm_and_beep() {
        assert_eq!(to_i16(&[2.0, -2.0, 0.0]), vec![32767, -32767, 0]);
        let b = beep_samples(16000);
        assert_eq!(b.len(), 16000 * 160 / 1000);
        assert_eq!(b[0], 0);
    }

    #[test]
    fn split_sentences() {
        assert_eq!(sentences("Привет! Как дела? 3.5 часа"), vec!["Привет!", "Как дела?", "3.5 часа"]);
        let long = "а".repeat(450);
        let s = sentences(&long);
        assert_eq!(s.len(), 3);
        assert_eq!(s[0].chars().count(), 200);
        assert!(sentences("  ").is_empty());
    }

    #[test]
    fn speed() {
        assert_eq!(speed_up(&[0.0, 1.0, 2.0, 3.0, 4.0], 2.0), vec![0.0, 2.0, 4.0]);
        assert_eq!(speed_up(&[0.0, 1.0], 1.0), vec![0.0, 1.0]);
        let v: Vec<f32> = (0..100).map(|i| i as f32).collect();
        let o = speed_up(&v, 1.25);
        assert_eq!(o.len(), 80);
        assert!((o[1] - 1.25).abs() < 1e-6);
        assert!(speed_up(&[], 1.3).is_empty());
    }

    #[test]
    fn presets_and_progress() {
        assert_eq!(preset("").model, "dmitri");
        assert_eq!(preset("bright").model, "irina");
        assert_eq!(progress(50, 100), 49);
        assert_eq!(progress(200, 100), 99);
        assert_eq!(progress(1, 0), 0);
    }
}
