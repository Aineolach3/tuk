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

/// Сервер: каждый входящий запрос передаётся наружу (в интерфейс) и ждёт ответа через `reply`.
pub struct Server {
    pending: Mutex<HashMap<u64, Sender<Reply>>>,
    next: AtomicU64,
    pub port: u16,
}

impl Server {
    pub fn reply(&self, id: u64, status: u16, body: String) {
        if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
            let _ = tx.send((status, body));
        }
    }
}

pub fn start_server<F>(port: u16, on_request: F) -> std::io::Result<Arc<Server>>
where
    F: Fn(u64, String, String) + Send + Sync + 'static,
{
    let listener = TcpListener::bind(("0.0.0.0", port))?;
    let real_port = listener.local_addr()?.port();
    let server = Arc::new(Server {
        pending: Mutex::new(HashMap::new()),
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
    if method != "POST" && method != "GET" {
        return write_response(&mut stream, 405, "Только POST");
    }
    let id = srv.next.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = channel();
    srv.pending.lock().unwrap().insert(id, tx);
    on_request(id, path, String::from_utf8_lossy(&body).into_owned());
    let (status, text) = match rx.recv_timeout(Duration::from_secs(REPLY_TIMEOUT_SECS.load(Ordering::Relaxed))) {
        Ok(r) => r,
        Err(_) => {
            srv.pending.lock().unwrap().remove(&id);
            (503, "Приложение не ответило".to_string())
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
    let addr: SocketAddr = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("Неверный адрес {host}: {e}"))?
        .next()
        .ok_or_else(|| format!("Неверный адрес {host}"))?;
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(4)).map_err(|e| format!("Нет связи с {host}:{port} ({e})"))?;
    s.set_read_timeout(Some(Duration::from_secs(200))).ok();
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
    fn json_escape() {
        assert_eq!(json_str("a\"b\\c\nd"), "\"a\\\"b\\\\c\\nd\"");
    }
}
