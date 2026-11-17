// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

//! Self-healing for EdgeCoder's local service: the agent this app spawns (:4301) and the IDE
//! provider it forks (:4304, the service every page calls).
//!
//! The app never asks the user whether its own service is running. The monitor thread (main.rs
//! `monitor_agent`) feeds `Supervisor::observe` every couple of seconds with whether the agent
//! process is alive and whether `GET /health` on :4304 answers, and does what it says:
//!  - the process is gone: start it again after a backoff (1 s, 2 s, 5 s, 10 s, then every 30 s,
//!    forever; a service that stays healthy for a minute starts the backoff over);
//!  - the process runs but the service hasn't answered for `UNHEALTHY_LIMIT` (after the
//!    `START_GRACE` a fresh start gets): stop it, so it is started again on the same backoff.
//! Every restart is written to ~/.edgecoder/agent.log (`log_line`). std-only, so it is unit-tested
//! standalone.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The IDE provider the webview calls; its /health is public (no token).
pub const SERVICE_HEALTH_ADDR: &str = "127.0.0.1:4304";

/// Waits before each restart attempt; the last one repeats.
pub const BACKOFF: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(30),
];
/// A freshly started agent gets this long to bring the service up (it boots three servers, the
/// coordinator and then forks the provider) before missing /health counts against it.
pub const START_GRACE: Duration = Duration::from_secs(45);
/// A running agent whose service doesn't answer this long (past the grace) is restarted. The agent
/// restarts a crashed provider itself within about 5 s, so this only catches a stuck one.
pub const UNHEALTHY_LIMIT: Duration = Duration::from_secs(20);
/// Healthy this long: the next failure starts the backoff from 1 s again.
pub const STABLE_AFTER: Duration = Duration::from_secs(60);

/// Wait before restart attempt `attempt` (0-based).
pub fn backoff(attempt: u32) -> Duration {
    BACKOFF[(attempt as usize).min(BACKOFF.len() - 1)]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// Nothing to do now.
    Wait,
    /// The agent isn't running and its backoff is over: start it.
    Start,
    /// The agent runs but its service is stuck: stop it (it is started again on the backoff).
    Stop,
}

#[derive(Debug, Default)]
pub struct Supervisor {
    /// Restart attempts since the service was last stable; picks the backoff.
    attempts: u32,
    started_at: Option<Instant>,
    down_since: Option<Instant>,
    unhealthy_since: Option<Instant>,
    healthy_since: Option<Instant>,
    /// Set while the app stops the service on purpose (an update installing): no restarts.
    paused: bool,
}

impl Supervisor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Restart attempts since the service was last stable.
    pub fn attempts(&self) -> u32 {
        self.attempts
    }

    #[cfg(test)]
    pub fn paused(&self) -> bool {
        self.paused
    }

    /// The first start at launch (not a restart: the backoff isn't touched).
    pub fn launched(&mut self, now: Instant, ok: bool) {
        self.started_at = Some(now);
        self.unhealthy_since = None;
        self.healthy_since = None;
        self.down_since = if ok { None } else { Some(now) };
    }

    /// One observation: is the agent process alive, does the service answer /health.
    pub fn observe(&mut self, now: Instant, alive: bool, healthy: bool) -> Action {
        if self.paused {
            return Action::Wait;
        }
        if alive && healthy {
            self.down_since = None;
            self.unhealthy_since = None;
            let since = *self.healthy_since.get_or_insert(now);
            if now.duration_since(since) >= STABLE_AFTER {
                self.attempts = 0;
            }
            return Action::Wait;
        }
        self.healthy_since = None;
        if !alive {
            self.unhealthy_since = None;
            let since = *self.down_since.get_or_insert(now);
            return if now.duration_since(since) >= backoff(self.attempts) { Action::Start } else { Action::Wait };
        }
        self.down_since = None;
        if self.started_at.is_some_and(|t| now.duration_since(t) < START_GRACE) {
            return Action::Wait;
        }
        let since = *self.unhealthy_since.get_or_insert(now);
        if now.duration_since(since) >= UNHEALTHY_LIMIT { Action::Stop } else { Action::Wait }
    }

    /// A restart attempt was made (`ok`: the process started). Failed starts back off too.
    pub fn restarted(&mut self, now: Instant, ok: bool) {
        self.attempts = self.attempts.saturating_add(1);
        self.started_at = Some(now);
        self.unhealthy_since = None;
        self.healthy_since = None;
        self.down_since = if ok { None } else { Some(now) };
    }

    /// The stuck process was stopped: the next start waits out the backoff from now.
    pub fn stopped(&mut self, now: Instant) {
        self.unhealthy_since = None;
        self.healthy_since = None;
        self.down_since = Some(now);
    }

    /// "Restart now" from the app: a fresh start with the backoff from the beginning.
    pub fn manual_restart(&mut self, now: Instant, ok: bool) {
        self.paused = false;
        self.attempts = 0;
        self.launched(now, ok);
    }

    /// Stop restarting (the app is stopping the service on purpose, e.g. to install an update).
    pub fn pause(&mut self) {
        self.paused = true;
    }
}

/// True when `GET <path>` on `addr` answers 200 within `timeout`.
pub fn http_ok(addr: &str, path: &str, timeout: Duration) -> bool {
    let Ok(sa) = addr.parse::<SocketAddr>() else { return false };
    let Ok(mut s) = TcpStream::connect_timeout(&sa, timeout) else { return false };
    let _ = s.set_read_timeout(Some(timeout));
    let _ = s.set_write_timeout(Some(timeout));
    let req = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    let mut got = 0;
    while got < buf.len() {
        match s.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => {
                got += n;
                if buf[..got].contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    status_is_ok(&String::from_utf8_lossy(&buf[..got]))
}

/// "HTTP/1.1 200 OK…" → true.
pub fn status_is_ok(head: &str) -> bool {
    let mut parts = head.split_whitespace();
    matches!((parts.next(), parts.next()), (Some(v), Some("200")) if v.starts_with("HTTP/"))
}

/// Whether the local service answers right now.
pub fn service_healthy() -> bool {
    http_ok(SERVICE_HEALTH_ADDR, "/health", Duration::from_secs(2))
}

/// A pino-style line (level 40: a warning) for ~/.edgecoder/agent.log, so Settings → Logs and
/// "View log" show the restarts next to the service's own output.
pub fn log_line(msg: &str) -> String {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let msg = serde_json_escape(msg);
    format!("{{\"level\":40,\"time\":{ms},\"service\":\"desktop\",\"msg\":\"{msg}\"}}")
}

fn serde_json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// ~/.edgecoder/desktop-agent-version: the app version that started the agent on :4301.
pub fn agent_version_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(std::path::PathBuf::from(home).join(".edgecoder").join("desktop-agent-version"))
}

/// An agent left on :4301 by an earlier launch is reused (#147) only when that launch was this
/// same app version: after an update the old agent (old code) is replaced, never kept.
pub fn may_reuse_agent(saved_version: Option<&str>, current_version: &str) -> bool {
    matches!(saved_version, Some(v) if v.trim() == current_version && !current_version.is_empty())
}

/// The last `max_lines` lines of `text` (for "View log").
pub fn tail_lines(text: &str, max_lines: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn backoff_is_1_2_5_10_then_every_30_seconds() {
        let got: Vec<u64> = (0..8).map(|a| backoff(a).as_secs()).collect();
        assert_eq!(got, vec![1, 2, 5, 10, 30, 30, 30, 30]);
    }

    #[test]
    fn a_dead_agent_is_restarted_on_the_backoff_and_never_given_up_on() {
        let t0 = Instant::now();
        let mut s = Supervisor::new();
        s.launched(t0, true);
        let mut now = t0 + secs(10);
        let mut waits = Vec::new();
        for _ in 0..7 {
            // It died (or the start failed): wait out the backoff, then start it again.
            let down = now;
            assert_eq!(s.observe(now, false, false), Action::Wait);
            loop {
                now += Duration::from_millis(500);
                if s.observe(now, false, false) == Action::Start {
                    break;
                }
            }
            waits.push((now - down).as_secs_f32().ceil() as u64);
            s.restarted(now, false);
        }
        assert_eq!(waits, vec![1, 2, 5, 10, 30, 30, 30]);
        assert_eq!(s.attempts(), 7);
    }

    #[test]
    fn healthy_for_a_minute_starts_the_backoff_over() {
        let t0 = Instant::now();
        let mut s = Supervisor::new();
        s.launched(t0, true);
        s.restarted(t0, true);
        s.restarted(t0, true);
        assert_eq!(s.attempts(), 2);
        assert_eq!(s.observe(t0 + secs(1), true, true), Action::Wait);
        assert_eq!(s.observe(t0 + secs(30), true, true), Action::Wait);
        assert_eq!(s.attempts(), 2, "not stable yet");
        assert_eq!(s.observe(t0 + secs(62), true, true), Action::Wait);
        assert_eq!(s.attempts(), 0);
    }

    #[test]
    fn a_stuck_service_is_stopped_only_after_the_grace_and_the_limit() {
        let t0 = Instant::now();
        let mut s = Supervisor::new();
        s.launched(t0, true);
        // Booting: no /health yet, but within the start grace.
        assert_eq!(s.observe(t0 + secs(5), true, false), Action::Wait);
        assert_eq!(s.observe(t0 + secs(44), true, false), Action::Wait);
        // Past the grace the clock starts; stopped after UNHEALTHY_LIMIT of no answer.
        assert_eq!(s.observe(t0 + secs(46), true, false), Action::Wait);
        assert_eq!(s.observe(t0 + secs(60), true, false), Action::Wait);
        assert_eq!(s.observe(t0 + secs(66), true, false), Action::Stop);
        s.stopped(t0 + secs(66));
        // Then it is down: started again after the first backoff step.
        assert_eq!(s.observe(t0 + secs(66), false, false), Action::Wait);
        assert_eq!(s.observe(t0 + secs(67), false, false), Action::Start);
    }

    #[test]
    fn one_answer_clears_the_unhealthy_clock() {
        let t0 = Instant::now();
        let mut s = Supervisor::new();
        s.launched(t0, true);
        assert_eq!(s.observe(t0 + secs(50), true, false), Action::Wait);
        assert_eq!(s.observe(t0 + secs(60), true, true), Action::Wait);
        assert_eq!(s.observe(t0 + secs(75), true, false), Action::Wait);
        assert_eq!(s.observe(t0 + secs(90), true, false), Action::Wait);
        assert_eq!(s.observe(t0 + secs(95), true, false), Action::Stop);
    }

    #[test]
    fn paused_while_an_update_installs_then_restart_now_starts_over() {
        let t0 = Instant::now();
        let mut s = Supervisor::new();
        s.launched(t0, true);
        s.restarted(t0, true);
        s.pause();
        assert_eq!(s.observe(t0 + secs(100), false, false), Action::Wait);
        s.manual_restart(t0 + secs(101), true);
        assert!(!s.paused());
        assert_eq!(s.attempts(), 0);
        // A failed manual start backs off from 1 s.
        s.manual_restart(t0 + secs(102), false);
        assert_eq!(s.observe(t0 + secs(102), false, false), Action::Wait);
        assert_eq!(s.observe(t0 + secs(103), false, false), Action::Start);
    }

    #[test]
    fn parses_the_status_line() {
        assert!(status_is_ok("HTTP/1.1 200 OK\r\n"));
        assert!(!status_is_ok("HTTP/1.1 503 Service Unavailable\r\n"));
        assert!(!status_is_ok(""));
        assert!(!status_is_ok("garbage 200"));
    }

    fn serve_once(reply: &'static str) -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap().to_string();
        thread::spawn(move || {
            if let Ok((mut c, _)) = l.accept() {
                let mut buf = [0u8; 512];
                let _ = c.read(&mut buf);
                let _ = c.write_all(reply.as_bytes());
            }
        });
        addr
    }

    #[test]
    fn health_check_needs_a_200() {
        let ok = serve_once("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
        assert!(http_ok(&ok, "/health", Duration::from_secs(2)));
        let bad = serve_once("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        assert!(!http_ok(&bad, "/health", Duration::from_secs(2)));
        // Nothing listening.
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let closed = l.local_addr().unwrap().to_string();
        drop(l);
        assert!(!http_ok(&closed, "/health", Duration::from_millis(300)));
    }

    #[test]
    fn log_lines_are_pino_json_and_escaped() {
        let line = log_line("restart \"1\"\nnext");
        assert!(line.starts_with("{\"level\":40,\"time\":"));
        assert!(line.contains("\"service\":\"desktop\""));
        assert!(line.contains("restart \\\"1\\\"\\nnext"));
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["msg"], "restart \"1\"\nnext");
    }

    #[test]
    fn an_agent_from_another_version_is_never_reused() {
        assert!(may_reuse_agent(Some("1.4.50\n"), "1.4.50"));
        assert!(!may_reuse_agent(Some("1.4.49"), "1.4.50"));
        assert!(!may_reuse_agent(None, "1.4.50"), "no record: an agent from before this check");
        assert!(!may_reuse_agent(Some(""), ""));
    }

    #[test]
    fn tails_the_last_lines() {
        assert_eq!(tail_lines("a\nb\nc\nd", 2), "c\nd");
        assert_eq!(tail_lines("a", 5), "a");
        assert_eq!(tail_lines("", 5), "");
    }
}
