// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

//! #147: challenge-verify an agent already listening on 127.0.0.1:4301 before reusing it.
//!
//! The shell sends a fresh 32-byte random nonce to `POST /local/attest`; the agent answers with
//! `HMAC-SHA256(ADMIN_API_TOKEN, "edgecoder-local-attest.v1." + nonce)` (src/trust/local-attest.ts).
//! Only an agent started with our admin token can answer, so a squatter on the port never gets
//! the inference token. The comparison is constant-time, and an answer is only accepted for the
//! nonce sent in this exchange, so a recorded answer can't be replayed.
//!
//! For a leftover agent from an earlier launch to prove anything, the tokens it was started with
//! must outlive that launch: they are kept in ~/.edgecoder/desktop-agent-tokens.json (0600, like
//! ~/.edgecoder/ide-token) and replaced whenever this app spawns a new agent.
//! std + sha2 only (no new crates), so it is unit-tested standalone.

use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const ATTEST_PATH: &str = "/local/attest";
pub const ATTEST_DOMAIN: &str = "edgecoder-local-attest.v1.";
const IO_TIMEOUT: Duration = Duration::from_millis(1500);
const MAX_RESPONSE: u64 = 16 * 1024;

/// HMAC-SHA256 (RFC 2104).
pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let inner = Sha256::new().chain_update(ipad).chain_update(msg).finalize();
    Sha256::new().chain_update(opad).chain_update(inner).finalize().into()
}

/// Constant-time equality for equal-length inputs (length itself is not secret).
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The answer the agent must give for `nonce`, hex-encoded.
pub fn expected_mac(admin_token: &str, nonce: &str) -> String {
    hex::encode(hmac_sha256(admin_token.as_bytes(), format!("{ATTEST_DOMAIN}{nonce}").as_bytes()))
}

pub fn new_nonce() -> String {
    crate::token::generate_local_token()
}

/// True when `body` (the agent's JSON answer) echoes `nonce` and carries the right MAC.
pub fn verify_answer(admin_token: &str, nonce: &str, body: &str) -> bool {
    if admin_token.is_empty() {
        return false;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    let (Some(n), Some(mac)) = (v.get("nonce").and_then(|x| x.as_str()), v.get("mac").and_then(|x| x.as_str())) else {
        return false;
    };
    if !ct_eq(n.as_bytes(), nonce.as_bytes()) {
        return false;
    }
    let Ok(got) = hex::decode(mac) else {
        return false;
    };
    let want = hmac_sha256(admin_token.as_bytes(), format!("{ATTEST_DOMAIN}{nonce}").as_bytes());
    ct_eq(&got, &want)
}

/// One HTTP/1.1 POST to the loopback agent; returns (status, body).
fn post_json(addr: &str, path: &str, body: &str) -> Option<(u16, String)> {
    let sa: SocketAddr = addr.parse().ok()?;
    if !sa.ip().is_loopback() {
        return None;
    }
    let mut s = TcpStream::connect_timeout(&sa, IO_TIMEOUT).ok()?;
    s.set_read_timeout(Some(IO_TIMEOUT)).ok()?;
    s.set_write_timeout(Some(IO_TIMEOUT)).ok()?;
    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).ok()?;
    let mut raw = Vec::new();
    s.take(MAX_RESPONSE).read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw);
    let (head, rest) = text.split_once("\r\n\r\n")?;
    let status: u16 = head.lines().next()?.split_whitespace().nth(1)?.parse().ok()?;
    let chunked = head.lines().any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    let body = if chunked { dechunk(rest)? } else { rest.to_string() };
    Some((status, body))
}

fn dechunk(mut s: &str) -> Option<String> {
    let mut out = String::new();
    loop {
        let (size_line, rest) = s.split_once("\r\n")?;
        let size = usize::from_str_radix(size_line.split(';').next()?.trim(), 16).ok()?;
        if size == 0 {
            return Some(out);
        }
        out.push_str(rest.get(..size)?);
        s = rest.get(size..)?.strip_prefix("\r\n")?;
    }
}

/// Challenge whatever listens on `addr` with a fresh nonce; true only for a correct answer.
pub fn challenge(addr: &str, admin_token: &str) -> bool {
    if admin_token.is_empty() {
        return false;
    }
    let nonce = new_nonce();
    let body = serde_json::json!({ "nonce": nonce }).to_string();
    match post_json(addr, ATTEST_PATH, &body) {
        Some((200, answer)) => verify_answer(admin_token, &nonce, &answer),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Tokens kept across launches
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct StoredTokens {
    pub inference: String,
    pub admin: String,
}

pub fn tokens_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".edgecoder").join("desktop-agent-tokens.json"))
}

fn plausible(t: &str) -> bool {
    t.len() == 64 && t.bytes().all(|c| c.is_ascii_hexdigit())
}

pub fn load_tokens(p: &Path) -> Option<StoredTokens> {
    let t: StoredTokens = serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()?;
    (plausible(&t.inference) && plausible(&t.admin)).then_some(t)
}

/// Write the tokens readable by this user only.
pub fn save_tokens(p: &Path, t: &StoredTokens) -> Result<(), String> {
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(t).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp).map_err(|e| e.to_string())?;
    f.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
    drop(f);
    std::fs::rename(&tmp, p).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn hmac_matches_rfc4231_case_2() {
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(hex::encode(mac), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    }

    #[test]
    fn hmac_long_key_rfc4231_case_6() {
        let key = [0xaau8; 131];
        let mac = hmac_sha256(&key, b"Test Using Larger Than Block-Size Key - Hash Key First");
        assert_eq!(hex::encode(mac), "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
    }

    #[test]
    fn ct_eq_basics() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
        assert!(ct_eq(b"", b""));
    }

    #[test]
    fn verify_answer_checks_nonce_and_mac() {
        let admin = "a".repeat(64);
        let nonce = "0".repeat(64);
        let mac = expected_mac(&admin, &nonce);
        assert!(verify_answer(&admin, &nonce, &format!(r#"{{"nonce":"{nonce}","mac":"{mac}"}}"#)));
        // Wrong MAC, wrong key, missing fields, garbage.
        let bad = expected_mac(&"b".repeat(64), &nonce);
        assert!(!verify_answer(&admin, &nonce, &format!(r#"{{"nonce":"{nonce}","mac":"{bad}"}}"#)));
        assert!(!verify_answer(&admin, &nonce, &format!(r#"{{"nonce":"{nonce}"}}"#)));
        assert!(!verify_answer(&admin, &nonce, r#"{"mac":"00"}"#));
        assert!(!verify_answer(&admin, &nonce, "not json"));
        assert!(!verify_answer("", &nonce, &format!(r#"{{"nonce":"{nonce}","mac":"{mac}"}}"#)));
        // A recorded answer for an earlier nonce is no good for this one (replay).
        let other = "1".repeat(64);
        let old_mac = expected_mac(&admin, &other);
        assert!(!verify_answer(&admin, &nonce, &format!(r#"{{"nonce":"{other}","mac":"{old_mac}"}}"#)));
        assert!(!verify_answer(&admin, &nonce, &format!(r#"{{"nonce":"{nonce}","mac":"{old_mac}"}}"#)));
    }

    #[test]
    fn same_vector_as_the_agent_side() {
        // tests/trust/local-attest.test.ts computes the same HMAC with node:crypto.
        let mac = expected_mac(&"k".repeat(64), &"0".repeat(64));
        assert_eq!(mac.len(), 64);
        assert_eq!(mac, hex::encode(hmac_sha256("k".repeat(64).as_bytes(), format!("edgecoder-local-attest.v1.{}", "0".repeat(64)).as_bytes())));
    }

    /// A fake :4301 listener that answers one request with whatever `respond` builds from the nonce.
    fn fake_agent(respond: impl Fn(&str) -> String + Send + 'static) -> (String, thread::JoinHandle<String>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap().to_string();
        let h = thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut buf = vec![0u8; 4096];
            let mut req = String::new();
            loop {
                let n = s.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                req.push_str(&String::from_utf8_lossy(&buf[..n]));
                if let Some((_, body)) = req.split_once("\r\n\r\n") {
                    if body.ends_with('}') {
                        break;
                    }
                }
            }
            let body = req.split_once("\r\n\r\n").map(|x| x.1.to_string()).unwrap_or_default();
            let nonce = serde_json::from_str::<serde_json::Value>(&body).ok().and_then(|v| v["nonce"].as_str().map(str::to_string)).unwrap_or_default();
            let resp = respond(&nonce);
            let _ = s.write_all(resp.as_bytes());
            req
        });
        (addr, h)
    }

    fn ok_response(body: &str) -> String {
        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
    }

    #[test]
    fn correct_answer_verifies() {
        let admin = "c".repeat(64);
        let a2 = admin.clone();
        let (addr, h) = fake_agent(move |n| ok_response(&format!(r#"{{"nonce":"{n}","mac":"{}"}}"#, expected_mac(&a2, n))));
        assert!(challenge(&addr, &admin));
        let req = h.join().unwrap();
        assert!(req.starts_with("POST /local/attest HTTP/1.1"));
        // The request carries only the nonce, never a token.
        assert!(!req.contains(&admin));
    }

    #[test]
    fn chunked_answer_verifies() {
        let admin = "c".repeat(64);
        let a2 = admin.clone();
        let (addr, h) = fake_agent(move |n| {
            let body = format!(r#"{{"nonce":"{n}","mac":"{}"}}"#, expected_mac(&a2, n));
            format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n", body.len())
        });
        assert!(challenge(&addr, &admin));
        h.join().unwrap();
    }

    #[test]
    fn wrong_or_missing_answer_fails() {
        let admin = "c".repeat(64);
        let (addr, h) = fake_agent(|n| ok_response(&format!(r#"{{"nonce":"{n}","mac":"{}"}}"#, expected_mac(&"d".repeat(64), n))));
        assert!(!challenge(&addr, &admin));
        h.join().unwrap();
        let (addr, h) = fake_agent(|_| "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_string());
        assert!(!challenge(&addr, &admin));
        h.join().unwrap();
        let (addr, h) = fake_agent(|_| ok_response("{}"));
        assert!(!challenge(&addr, &admin));
        h.join().unwrap();
        // Status must be 200 even with a correct-looking body.
        let a2 = admin.clone();
        let (addr, h) = fake_agent(move |n| {
            let b = format!(r#"{{"nonce":"{n}","mac":"{}"}}"#, expected_mac(&a2, n));
            format!("HTTP/1.1 500 Oops\r\nContent-Length: {}\r\n\r\n{b}", b.len())
        });
        assert!(!challenge(&addr, &admin));
        h.join().unwrap();
    }

    #[test]
    fn replayed_answer_fails() {
        // A squatter that recorded a real answer replays it for every challenge.
        let admin = "c".repeat(64);
        let old = "e".repeat(64);
        let recorded = format!(r#"{{"nonce":"{old}","mac":"{}"}}"#, expected_mac(&admin, &old));
        let (addr, h) = fake_agent(move |_| ok_response(&recorded));
        assert!(!challenge(&addr, &admin));
        h.join().unwrap();
    }

    #[test]
    fn nothing_listening_or_non_loopback_fails() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap().to_string();
        drop(l);
        assert!(!challenge(&addr, &"c".repeat(64)));
        assert!(!challenge("192.0.2.1:4301", &"c".repeat(64)));
        assert!(!challenge("127.0.0.1:1", ""));
    }

    #[test]
    fn tokens_round_trip_with_private_permissions() {
        let dir = std::env::temp_dir().join(format!("ec-attest-{}", std::process::id()));
        let p = dir.join("desktop-agent-tokens.json");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(load_tokens(&p).is_none());
        let t = StoredTokens { inference: "1".repeat(64), admin: "2".repeat(64) };
        save_tokens(&p, &t).unwrap();
        assert_eq!(load_tokens(&p), Some(t.clone()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // Overwrite works; junk is ignored.
        let t2 = StoredTokens { inference: "3".repeat(64), admin: "4".repeat(64) };
        save_tokens(&p, &t2).unwrap();
        assert_eq!(load_tokens(&p), Some(t2));
        std::fs::write(&p, r#"{"inference":"short","admin":"x"}"#).unwrap();
        assert!(load_tokens(&p).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
