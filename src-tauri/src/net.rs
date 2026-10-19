//! Сеть без внешних библиотек: маленький HTTP-сервер (на ПК), HTTP-клиент (на телефоне)
//! и UDP-маяк, по которому телефон находит ПК в локальной сети.
//! Содержимое запросов уже зашифровано на стороне интерфейса (AES-GCM).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const BEACON_PORT: u16 = 47801;
/// Сколько сервер ждёт ответа интерфейса (ответ мозга может идти долго).
pub static REPLY_TIMEOUT_SECS: AtomicU64 = AtomicU64::new(180);
const MAX_HEADER: usize = 64 * 1024;
const MAX_BODY: usize = 32 * 1024 * 1024;

type Reply = (u16, String);

/// Сколько хук Claude Code ждёт решения по разрешению. Чуть меньше, чем ждёт
/// сам `Tuk.exe --hook` (115 с), — чтобы ответ «нет решения» успел дойти.
const HOOK_WAIT_SECS: u64 = 112;

/// Сервер: каждый входящий запрос передаётся наружу (в интерфейс) и ждёт ответа через `reply`.
pub struct Server {
    pending: Mutex<HashMap<u64, Sender<Reply>>>,
    /// Запросы, которые ещё ждут ответа интерфейса: (путь, тело). Если страница
    /// перезагрузилась, `resend` присылает их заново — ни один не теряется.
    inflight: Mutex<HashMap<u64, (String, String)>>,
    next: AtomicU64,
    pub port: u16,
}

impl Server {
    pub fn reply(&self, id: u64, status: u16, body: String) {
        self.inflight.lock().unwrap().remove(&id);
        if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
            let _ = tx.send((status, body));
        }
    }

    /// Запросы, ждущие ответа, по порядку прихода.
    pub fn inflight(&self) -> Vec<(u64, String, String)> {
        let mut v: Vec<(u64, String, String)> = self.inflight.lock().unwrap().iter().map(|(id, (p, b))| (*id, p.clone(), b.clone())).collect();
        v.sort_by_key(|x| x.0);
        v
    }
}

/// Нужен ли этому событию хука ответ интерфейса (решение человека).
/// Ждут только PermissionRequest (в т. ч. AskUserQuestion); остальные события
/// Claude Code получают пустой ответ сразу, а интерфейс узнаёт о них событием.
pub fn hook_blocks(body: &str) -> bool {
    hook_field(body, "hook_event_name") == "PermissionRequest"
}

/// Строковое поле верхнего уровня JSON-объекта (session_id, hook_event_name …).
/// Ключи во вложенных объектах (tool_input) и внутри строк не учитываются.
pub fn hook_field(body: &str, key: &str) -> String {
    let b = body.as_bytes();
    let mut i = 0;
    let mut depth = 0i32;
    // ожидаем ключ: после '{' или ',' на уровне 1
    let mut expect_key = false;
    while i < b.len() {
        match b[i] {
            b'{' | b'[' => {
                depth += 1;
                expect_key = depth == 1 && b[i] == b'{';
                i += 1;
            }
            b'}' | b']' => {
                depth -= 1;
                i += 1;
            }
            b',' => {
                expect_key = depth == 1;
                i += 1;
            }
            b'"' => {
                let Some((text, end)) = json_string(b, i) else { return String::new() };
                i = end;
                if depth == 1 && expect_key {
                    expect_key = false;
                    if text == key {
                        // пропустить пробелы и двоеточие, взять строковое значение
                        while i < b.len() && (b[i] == b' ' || b[i] == b':' || b[i] == b'\n' || b[i] == b'\r' || b[i] == b'\t') {
                            i += 1;
                        }
                        if i < b.len() && b[i] == b'"' {
                            return json_string(b, i).map(|(t, _)| t).unwrap_or_default();
                        }
                        return String::new();
                    }
                }
            }
            _ => i += 1,
        }
    }
    String::new()
}

/// Строка JSON с позиции открывающей кавычки: (текст, позиция после закрывающей).
fn json_string(b: &[u8], start: usize) -> Option<(String, usize)> {
    let mut out: Vec<u8> = Vec::new();
    let mut i = start + 1;
    while i < b.len() {
        match b[i] {
            b'"' => return Some((String::from_utf8_lossy(&out).into_owned(), i + 1)),
            b'\\' => {
                let c = *b.get(i + 1)?;
                match c {
                    b'n' => out.push(b'\n'),
                    b't' => out.push(b'\t'),
                    b'r' => out.push(b'\r'),
                    b'u' => {
                        let hex = std::str::from_utf8(b.get(i + 2..i + 6)?).ok()?;
                        let cp = u32::from_str_radix(hex, 16).ok()?;
                        let ch = char::from_u32(cp).unwrap_or('\u{fffd}');
                        let mut buf = [0u8; 4];
                        out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                        i += 4;
                    }
                    other => out.push(other),
                }
                i += 2;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    None
}

pub fn start_server<F>(port: u16, on_request: F) -> std::io::Result<Arc<Server>>
where
    F: Fn(u64, String, String) + Send + Sync + 'static,
{
    let listener = TcpListener::bind(("0.0.0.0", port))?;
    let real_port = listener.local_addr()?.port();
    let server = Arc::new(Server {
        pending: Mutex::new(HashMap::new()),
        inflight: Mutex::new(HashMap::new()),
        next: AtomicU64::new(1),
        port: real_port,
    });
    let handler = Arc::new(on_request);
    let srv = server.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let srv = srv.clone();
            let handler = handler.clone();
            thread::spawn(move || {
                let _ = handle_conn(stream, &srv, &*handler);
            });
        }
    });
    Ok(server)
}

fn handle_conn<F>(mut stream: TcpStream, srv: &Server, on_request: &F) -> std::io::Result<()>
where
    F: Fn(u64, String, String),
{
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    let (head, mut body) = read_head(&mut stream)?;
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or("/").to_string();
    let len = content_length(lines);
    if len > MAX_BODY {
        return write_response(&mut stream, 413, "Слишком большой запрос");
    }
    while body.len() < len {
        let mut buf = vec![0u8; (len - body.len()).min(64 * 1024)];
        let n = stream.read(&mut buf)?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&buf[..n]);
    }
    body.truncate(len);
    // хуки Claude Code принимаем только с этого же компьютера
    let local = stream.peer_addr().map(|a| a.ip().is_loopback()).unwrap_or(false);
    if path.starts_with("/hook") && !local {
        return write_response(&mut stream, 403, "Только с этого компьютера");
    }
    if method != "POST" && method != "GET" {
        return write_response(&mut stream, 405, "Только POST");
    }
    let id = srv.next.fetch_add(1, Ordering::Relaxed);
    let body = String::from_utf8_lossy(&body).into_owned();
    let hook = path.starts_with("/hook");
    // Событие хука без решения: Claude Code не ждёт интерфейс (раньше каждое событие
    // каждой сессии держало Claude Code до ответа страницы). Порядок событий одной
    // сессии сохраняется: Claude Code шлёт следующее, только дождавшись этого ответа.
    if hook && !hook_blocks(&body) {
        on_request(id, path, body);
        return write_response(&mut stream, 200, "");
    }
    let (tx, rx) = channel();
    srv.pending.lock().unwrap().insert(id, tx);
    srv.inflight.lock().unwrap().insert(id, (path.clone(), body.clone()));
    on_request(id, path, body);
    let wait = if hook { HOOK_WAIT_SECS } else { REPLY_TIMEOUT_SECS.load(Ordering::Relaxed) };
    let (status, text) = match rx.recv_timeout(Duration::from_secs(wait)) {
        Ok(r) => r,
        Err(_) => {
            srv.pending.lock().unwrap().remove(&id);
            srv.inflight.lock().unwrap().remove(&id);
            // хук: пустой ответ — Claude Code спросит в терминале как обычно
            if hook { (200, String::new()) } else { (503, "Приложение не ответило".to_string()) }
        }
    };
    write_response(&mut stream, status, &text)
}

/// Читает заголовки до пустой строки; возвращает их и уже прочитанный кусок тела.
fn read_head(stream: &mut TcpStream) -> std::io::Result<(String, Vec<u8>)> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(pos) = find(&buf, b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..pos]).into_owned();
            return Ok((head, buf[pos + 4..].to_vec()));
        }
        if buf.len() > MAX_HEADER {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "заголовки слишком большие"));
        }
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "соединение закрыто"));
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn content_length<'a>(lines: impl Iterator<Item = &'a str>) -> usize {
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                return v.trim().parse().unwrap_or(0);
            }
        }
    }
    0
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

fn write_response(stream: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status,
        reason(status),
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

/// HTTP POST. Ошибка — строка, понятная человеку (её показывает интерфейс).
pub fn http_post(host: &str, port: u16, path: &str, body: &str) -> Result<String, String> {
    http_post_t(host, port, path, body, 4, 200)
}

/// То же с тайм-аутами: подключение и ожидание ответа (секунды).
pub fn http_post_t(host: &str, port: u16, path: &str, body: &str, connect_secs: u64, read_secs: u64) -> Result<String, String> {
    let addr: SocketAddr = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("Неверный адрес {host}: {e}"))?
        .next()
        .ok_or_else(|| format!("Неверный адрес {host}"))?;
    let mut s =
        TcpStream::connect_timeout(&addr, Duration::from_secs(connect_secs)).map_err(|e| format!("Нет связи с {host}:{port} ({e})"))?;
    s.set_read_timeout(Some(Duration::from_secs(read_secs))).ok();
    s.set_write_timeout(Some(Duration::from_secs(15))).ok();
    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    s.write_all(req.as_bytes())
        .and_then(|_| s.write_all(body.as_bytes()))
        .map_err(|e| format!("Ошибка отправки: {e}"))?;
    let (head, mut rest) = read_head(&mut s).map_err(|e| format!("Ошибка ответа: {e}"))?;
    let mut lines = head.split("\r\n");
    let status: u16 = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let len = content_length(lines);
    while rest.len() < len {
        let mut buf = vec![0u8; (len - rest.len()).min(64 * 1024)];
        match s.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => rest.extend_from_slice(&buf[..n]),
            Err(e) => return Err(format!("Ошибка ответа: {e}")),
        }
    }
    rest.truncate(len);
    let text = String::from_utf8_lossy(&rest).into_owned();
    if status == 200 {
        Ok(text)
    } else {
        Err(format!("{status}: {text}"))
    }
}

/// IP этого устройства в локальной сети. Пакеты не отправляются — UDP-«подключение» только выбирает маршрут.
pub fn local_ip() -> Option<String> {
    for target in ["8.8.8.8:80", "192.168.0.1:80", "10.0.0.1:80"] {
        if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
            if sock.connect(target).is_ok() {
                if let Ok(addr) = sock.local_addr() {
                    let ip = addr.ip();
                    if !ip.is_unspecified() && !ip.is_loopback() {
                        return Some(ip.to_string());
                    }
                }
            }
        }
    }
    None
}

/// ПК раз в 3 секунды кричит в сеть «я здесь».
pub fn start_beacon(payload: String) {
    thread::spawn(move || {
        let Ok(sock) = UdpSocket::bind("0.0.0.0:0") else { return };
        let _ = sock.set_broadcast(true);
        loop {
            let _ = sock.send_to(payload.as_bytes(), ("255.255.255.255", BEACON_PORT));
            thread::sleep(Duration::from_secs(3));
        }
    });
}

/// Телефон слушает маяки `ms` миллисекунд. Результат — строки «ip|содержимое маяка».
pub fn discover(ms: u64) -> Result<Vec<String>, String> {
    discover_on(BEACON_PORT, ms)
}

pub fn discover_on(port: u16, ms: u64) -> Result<Vec<String>, String> {
    let sock = UdpSocket::bind(("0.0.0.0", port)).map_err(|e| format!("Не удалось слушать сеть: {e}"))?;
    let deadline = Instant::now() + Duration::from_millis(ms);
    let mut out: Vec<String> = Vec::new();
    let mut buf = [0u8; 1024];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        sock.set_read_timeout(Some(left.max(Duration::from_millis(10)))).ok();
        match sock.recv_from(&mut buf) {
            Ok((n, from)) => {
                let text = String::from_utf8_lossy(&buf[..n]);
                if text.starts_with("TUK1|") {
                    let line = format!("{}|{}", from.ip(), text);
                    if !out.contains(&line) {
                        out.push(line);
                    }
                }
            }
            Err(_) => continue,
        }
    }
    Ok(out)
}

/// Кодирование в base64 (стандартный алфавит).
pub fn b64encode(data: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { A[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { A[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Декодирование base64 (стандартный алфавит, с «=» или без).
pub fn b64decode(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    }
    let clean: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace() && *c != b'=').collect();
    let mut out = Vec::with_capacity(clean.len() * 3 / 4);
    for chunk in clean.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= val(c)? << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
        if chunk.len() == 1 {
            return None;
        }
    }
    Some(out)
}

/// Строка в JSON (без serde).
pub fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Три сессии Claude Code одновременно: обычные события не ждут интерфейс,
    /// запросы разрешений ждут каждый своего ответа и не путаются.
    #[test]
    fn hooks_from_many_sessions() {
        let holder: Arc<Mutex<Option<Arc<Server>>>> = Arc::new(Mutex::new(None));
        let seen: Arc<Mutex<Vec<(u64, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let (h2, s2) = (holder.clone(), seen.clone());
        let srv = start_server(0, move |id, _path, body| {
            let sid = hook_field(&body, "session_id");
            s2.lock().unwrap().push((id, sid.clone()));
            if hook_blocks(&body) {
                // решение приходит позже и в обратном порядке
                let h = h2.clone();
                thread::spawn(move || {
                    let wait = match sid.as_str() { "a" => 300, "b" => 200, _ => 100 };
                    thread::sleep(Duration::from_millis(wait));
                    let s = h.lock().unwrap().clone().unwrap();
                    s.reply(id, 200, format!("{{\"for\":\"{sid}\"}}"));
                });
            }
        })
        .unwrap();
        *holder.lock().unwrap() = Some(srv.clone());
        let port = srv.port;
        // обычное событие — ответ сразу, без интерфейса
        let t = Instant::now();
        let r = http_post_t("127.0.0.1", port, "/hook", r#"{"hook_event_name":"PreToolUse","session_id":"a"}"#, 1, 5).unwrap();
        assert_eq!(r, "");
        assert!(t.elapsed() < Duration::from_millis(500));
        let joins: Vec<_> = ["a", "b", "c"]
            .into_iter()
            .map(|sid| {
                thread::spawn(move || {
                    let body = format!(r#"{{"hook_event_name":"PermissionRequest","session_id":"{sid}"}}"#);
                    (sid, http_post_t("127.0.0.1", port, "/hook", &body, 1, 5).unwrap())
                })
            })
            .collect();
        thread::sleep(Duration::from_millis(50));
        assert_eq!(srv.inflight().len(), 3, "все три ждут и видны для повторной отправки");
        for j in joins {
            let (sid, r) = j.join().unwrap();
            assert_eq!(r, format!("{{\"for\":\"{sid}\"}}"));
        }
        assert!(srv.inflight().is_empty());
        assert_eq!(seen.lock().unwrap().len(), 4);
    }

    #[test]
    fn hook_kinds() {
        assert!(hook_blocks(r#"{"hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion"}"#));
        assert!(!hook_blocks(r#"{"hook_event_name":"Stop"}"#));
        assert!(!hook_blocks("не json"));
        assert_eq!(hook_field(r#"{"session_id":"x1"}"#, "session_id"), "x1");
        // ключ во вложенном объекте и внутри строки не считается
        let tricky = r#"{"tool_input":{"session_id":"чужой","t":"\"session_id\":\"z\""}, "session_id" : "моя\u0020сессия", "hook_event_name":"Stop"}"#;
        assert_eq!(hook_field(tricky, "session_id"), "моя сессия");
        assert!(!hook_blocks(r#"{"tool_input":{"hook_event_name":"PermissionRequest"},"hook_event_name":"PreToolUse"}"#));
    }

    #[test]
    fn roundtrip_post() {
        let holder: Arc<Mutex<Option<Arc<Server>>>> = Arc::new(Mutex::new(None));
        let h2 = holder.clone();
        let srv = start_server(0, move |id, path, body| {
            let h = h2.clone();
            // ответ из другого потока, как это делает интерфейс
            thread::spawn(move || {
                let s = h.lock().unwrap().clone().unwrap();
                s.reply(
                    id,
                    if path == "/sync" { 200 } else { 404 },
                    format!("{{\"echo\":{}}}", json_str(&body)),
                );
            });
        })
        .unwrap();
        *holder.lock().unwrap() = Some(srv.clone());
        let big = "Привет ".repeat(50_000);
        let r = http_post("127.0.0.1", srv.port, "/sync", &big).unwrap();
        assert!(r.starts_with("{\"echo\":\"Привет"));
        assert_eq!(r.len(), big.len() + 11);
        let e = http_post("127.0.0.1", srv.port, "/nope", "{}").unwrap_err();
        assert!(e.starts_with("404"), "{e}");
    }

    #[test]
    fn server_timeout_gives_503() {
        // никто не отвечает — клиент получает 503, а не зависает навсегда
        REPLY_TIMEOUT_SECS.store(2, Ordering::Relaxed);
        let srv = start_server(0, |_, _, _| {}).unwrap();
        let t = Instant::now();
        let e = http_post("127.0.0.1", srv.port, "/sync", "{}").unwrap_err();
        assert!(e.starts_with("503"), "{e}");
        assert!(t.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn no_server_is_error() {
        let e = http_post("127.0.0.1", 1, "/sync", "{}").unwrap_err();
        assert!(e.contains("Нет связи"), "{e}");
    }

    #[test]
    fn discover_hears_beacon() {
        let port = 47911;
        let h = thread::spawn(move || discover_on(port, 800).unwrap());
        thread::sleep(Duration::from_millis(150));
        let s = UdpSocket::bind("127.0.0.1:0").unwrap();
        s.send_to(b"TUK1|abc|47800|PC", ("127.0.0.1", port)).unwrap();
        s.send_to(b"garbage", ("127.0.0.1", port)).unwrap();
        let found = h.join().unwrap();
        assert_eq!(found, vec!["127.0.0.1|TUK1|abc|47800|PC".to_string()]);
    }

    #[test]
    fn base64() {
        assert_eq!(b64decode("SGVsbG8=").unwrap(), b"Hello");
        assert_eq!(b64decode("SGVsbG8").unwrap(), b"Hello");
        assert_eq!(b64decode("0J/RgNC40LLQtdGC").unwrap(), "Привет".as_bytes());
        assert!(b64decode("@@@").is_none());
        for v in [&b""[..], b"a", b"ab", b"abc", "Тук".as_bytes()] {
            assert_eq!(b64decode(&b64encode(v)).unwrap(), v);
        }
        assert_eq!(b64encode(b"Hello"), "SGVsbG8=");
    }

    #[test]
    fn json_escape() {
        assert_eq!(json_str("a\"b\\c\nd"), "\"a\\\"b\\\\c\\nd\"");
    }
}
