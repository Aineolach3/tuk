//! Запросы к локальному ИИ (Ollama, LM Studio) из Rust, а не из WebView.
//!
//! Страница Тука отдаётся с заголовками COOP/COEP (нужны мозгу wllama), и
//! WebView2 к тому же считает http://192.168.x.x «смешанным содержимым» для
//! https://tauri.localhost. Поэтому `fetch` к серверу на этом ПК или в домашней
//! сети ненадёжен. Здесь — простой HTTP/1.1 клиент без внешних библиотек.
//!
//! Безопасность: только http://, только адреса этого компьютера и частных сетей
//! (127/8, ::1, 10/8, 172.16/12, 192.168/16, 169.254/16, fc00::/7, fe80::/10).
//! Проверяется адрес, к которому реально подключаемся (после DNS), так что
//! имя, ведущее в интернет, не пройдёт.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::collections::HashSet;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

const MAX_RESPONSE: usize = 64 * 1024 * 1024;

pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            v.is_loopback() || v.is_private() || v.is_link_local() || (o[0] == 100 && (64..128).contains(&o[1]))
        }
        IpAddr::V6(v) => {
            let s = v.segments();
            v.is_loopback() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80 || v.to_ipv4_mapped().map(|m| is_private(IpAddr::V4(m))).unwrap_or(false)
        }
    }
}

/// http://хост[:порт]/путь → (хост, порт, путь). Только http.
pub fn parse_url(url: &str) -> Result<(String, u16, String), String> {
    let rest = url.trim().strip_prefix("http://").ok_or("Нужен адрес вида http://127.0.0.1:11434")?;
    let (hostport, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    if hostport.is_empty() || hostport.contains('@') {
        return Err("Неверный адрес".into());
    }
    let (host, port) = if let Some(h) = hostport.strip_prefix('[') {
        // [::1]:11434
        let (h, p) = h.split_once(']').ok_or("Неверный адрес")?;
        let port = p.strip_prefix(':').map(|p| p.parse::<u16>().map_err(|_| "Неверный порт")).transpose()?.unwrap_or(80);
        (h.to_string(), port)
    } else {
        match hostport.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.parse::<u16>().map_err(|_| "Неверный порт")?),
            None => (hostport.to_string(), 80),
        }
    };
    if path.contains(['\r', '\n', ' ']) || host.contains(['\r', '\n', ' ', '/']) {
        return Err("Неверный адрес".into());
    }
    Ok((host, port, path.to_string()))
}

fn connect(host: &str, port: u16) -> Result<TcpStream, String> {
    let addrs: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("Не нашёл {host}: {e}"))?
        .collect();
    let addr = addrs
        .into_iter()
        .find(|a| is_private(a.ip()))
        .ok_or("Можно обращаться только к этому компьютеру или к домашней сети")?;
    let s = TcpStream::connect_timeout(&addr, Duration::from_secs(4)).map_err(|e| format!("Сервер {host}:{port} не отвечает ({e})"))?;
    s.set_write_timeout(Some(Duration::from_secs(30))).ok();
    Ok(s)
}

struct Head {
    status: u16,
    chunked: bool,
    length: Option<usize>,
}

fn send(method: &str, url: &str, body: &str, read_secs: u64) -> Result<(BufReader<TcpStream>, Head), String> {
    let method = match method.to_ascii_uppercase().as_str() {
        "GET" => "GET",
        "POST" => "POST",
        "DELETE" => "DELETE",
        _ => return Err("Только GET, POST, DELETE".into()),
    };
    let (host, port, path) = parse_url(url)?;
    let mut s = connect(&host, port)?;
    s.set_read_timeout(Some(Duration::from_secs(read_secs))).ok();
    let host_hdr = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {host_hdr}\r\nAccept: */*\r\nConnection: close\r\n");
    if method != "GET" {
        req.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", body.len()));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).map_err(|e| format!("Ошибка отправки: {e}"))?;
    if method != "GET" {
        s.write_all(body.as_bytes()).map_err(|e| format!("Ошибка отправки: {e}"))?;
    }
    let mut r = BufReader::new(s);
    let mut line = String::new();
    r.read_line(&mut line).map_err(|e| format!("Ошибка ответа: {e}"))?;
    let status = line.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    let mut head = Head { status, chunked: false, length: None };
    loop {
        line.clear();
        if r.read_line(&mut line).map_err(|e| format!("Ошибка ответа: {e}"))? == 0 {
            break;
        }
        let l = line.trim_end();
        if l.is_empty() {
            break;
        }
        if let Some((k, v)) = l.split_once(':') {
            let (k, v) = (k.trim(), v.trim());
            if k.eq_ignore_ascii_case("transfer-encoding") && v.to_ascii_lowercase().contains("chunked") {
                head.chunked = true;
            } else if k.eq_ignore_ascii_case("content-length") {
                head.length = v.parse().ok();
            }
        }
    }
    Ok((r, head))
}

/// Читать тело, отдавая куски в `on_piece`. Понимает chunked, Content-Length и «до закрытия».
fn read_body(r: &mut BufReader<TcpStream>, head: &Head, cancel: &dyn Fn() -> bool, on_piece: &mut dyn FnMut(&[u8])) -> Result<(), String> {
    let e = |e: std::io::Error| format!("Ошибка ответа: {e}");
    let mut total = 0usize;
    if head.chunked {
        let mut line = String::new();
        loop {
            if cancel() {
                return Ok(());
            }
            line.clear();
            if r.read_line(&mut line).map_err(e)? == 0 {
                return Ok(());
            }
            let size = usize::from_str_radix(line.trim().split(';').next().unwrap_or("0"), 16).map_err(|_| "Битый ответ сервера")?;
            if size == 0 {
                return Ok(());
            }
            total += size;
            if total > MAX_RESPONSE {
                return Err("Слишком большой ответ".into());
            }
            let mut buf = vec![0u8; size];
            r.read_exact(&mut buf).map_err(e)?;
            on_piece(&buf);
            let mut crlf = [0u8; 2];
            let _ = r.read_exact(&mut crlf);
        }
    }
    let mut left = head.length;
    let mut buf = [0u8; 16 * 1024];
    loop {
        if cancel() || left == Some(0) {
            return Ok(());
        }
        let want = left.map(|l| l.min(buf.len())).unwrap_or(buf.len());
        let n = r.read(&mut buf[..want]).map_err(e)?;
        if n == 0 {
            return Ok(());
        }
        total += n;
        if total > MAX_RESPONSE {
            return Err("Слишком большой ответ".into());
        }
        if let Some(l) = left.as_mut() {
            *l -= n;
        }
        on_piece(&buf[..n]);
    }
}

#[derive(Serialize)]
pub struct HttpOut {
    pub status: u16,
    pub body: String,
}

/// Обычный запрос: весь ответ разом (список моделей и т. п.).
#[tauri::command]
pub async fn local_http(method: String, url: String, body: Option<String>) -> Result<HttpOut, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (mut r, head) = send(&method, &url, body.as_deref().unwrap_or(""), 60)?;
        let mut out = Vec::new();
        read_body(&mut r, &head, &|| false, &mut |p| out.extend_from_slice(p))?;
        Ok(HttpOut { status: head.status, body: String::from_utf8_lossy(&out).into_owned() })
    })
    .await
    .map_err(|e| e.to_string())?
}

static NEXT: AtomicU64 = AtomicU64::new(1);
static CANCELLED: Mutex<Option<HashSet<u64>>> = Mutex::new(None);

#[derive(Serialize, Clone)]
struct Chunk {
    id: u64,
    /// Кусок текста ответа (UTF-8; разрезанный посередине символ доклеивается к следующему куску).
    text: String,
}

#[derive(Serialize, Clone)]
struct Done {
    id: u64,
    status: u16,
    error: Option<String>,
}

/// Потоковый запрос (ответ модели по мере генерации). Возвращает id сразу;
/// куски приходят событием `local-http-chunk` { id, text }, конец — `local-http-done`
/// { id, status, error }. События идут только в окно, которое спросило.
#[tauri::command]
pub fn local_http_stream(app: AppHandle, window: tauri::WebviewWindow, method: String, url: String, body: Option<String>) -> u64 {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let label = window.label().to_string();
    std::thread::spawn(move || {
        let stopped = AtomicBool::new(false);
        let cancel = || {
            if stopped.load(Ordering::Relaxed) {
                return true;
            }
            let hit = CANCELLED.lock().unwrap().as_mut().map(|s| s.remove(&id)).unwrap_or(false);
            if hit {
                stopped.store(true, Ordering::Relaxed);
            }
            hit
        };
        let result = send(&method, &url, body.as_deref().unwrap_or(""), 300).and_then(|(mut r, head)| {
            let mut carry: Vec<u8> = Vec::new();
            read_body(&mut r, &head, &cancel, &mut |p| {
                carry.extend_from_slice(p);
                // отдать только целые символы UTF-8
                let cut = match std::str::from_utf8(&carry) {
                    Ok(_) => carry.len(),
                    Err(e) => e.valid_up_to(),
                };
                if cut > 0 {
                    let text = String::from_utf8_lossy(&carry[..cut]).into_owned();
                    carry.drain(..cut);
                    let _ = app.emit_to(label.as_str(), "local-http-chunk", Chunk { id, text });
                }
            })?;
            if !carry.is_empty() {
                let _ = app.emit_to(label.as_str(), "local-http-chunk", Chunk { id, text: String::from_utf8_lossy(&carry).into_owned() });
            }
            Ok(head.status)
        });
        let done = match result {
            Ok(status) => Done { id, status, error: None },
            Err(e) => Done { id, status: 0, error: Some(e) },
        };
        let _ = app.emit_to(label.as_str(), "local-http-done", done);
    });
    id
}

/// Остановить потоковый запрос (кнопка «Стоп»).
#[tauri::command]
pub fn local_http_cancel(id: u64) {
    CANCELLED.lock().unwrap().get_or_insert_with(HashSet::new).insert(id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn only_private_addresses() {
        for ok in ["127.0.0.1", "10.1.2.3", "192.168.1.5", "172.20.0.1", "169.254.1.1", "::1", "fd00::1", "fe80::1", "100.64.0.1"] {
            assert!(is_private(ok.parse().unwrap()), "{ok}");
        }
        for bad in ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2001:4860::8888"] {
            assert!(!is_private(bad.parse().unwrap()), "{bad}");
        }
    }

    #[test]
    fn url_parsing() {
        assert_eq!(parse_url("http://127.0.0.1:11434/v1/models").unwrap(), ("127.0.0.1".into(), 11434, "/v1/models".into()));
        assert_eq!(parse_url("http://localhost").unwrap(), ("localhost".into(), 80, "/".into()));
        assert_eq!(parse_url("http://[::1]:1234/x").unwrap(), ("::1".into(), 1234, "/x".into()));
        assert!(parse_url("https://127.0.0.1").is_err());
        assert!(parse_url("http://user@127.0.0.1/").is_err());
        assert!(parse_url("http://127.0.0.1/a b").is_err());
    }

    #[test]
    fn chunked_body_is_decoded() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf);
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n6\r\n\xd0\xbf\xd1\x80\xd0\xb8\r\n4\r\n\xd0\xb2!\n\r\n0\r\n\r\n");
        });
        let (mut r, head) = send("POST", &format!("http://127.0.0.1:{port}/v1/chat"), "{}", 5).unwrap();
        assert_eq!(head.status, 200);
        let mut out = Vec::new();
        read_body(&mut r, &head, &|| false, &mut |p| out.extend_from_slice(p)).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), "прив!\n");
    }

    #[test]
    fn internet_host_is_refused() {
        assert!(send("GET", "http://8.8.8.8:80/", "", 1).is_err());
    }
}
