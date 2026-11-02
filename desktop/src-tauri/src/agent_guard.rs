// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

//! #72: only hand the per-launch inference token to an agent this app spawned.
//!
//! When something is already listening on 127.0.0.1:4301 at launch (a leftover agent from an
//! earlier launch, or any other local process), the app does not spawn its own agent. That
//! listener never received this launch's tokens, so the webview must not send it the inference
//! token. The status is shown in the UI with a retry once the port is free.
//! std-only so it is unit-tested standalone in CI (desktop-token-test).

use std::net::{SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::Duration;

pub const AGENT_ADDR: &str = "127.0.0.1:4301";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentOwnership {
    /// No agent yet (not started, or the bundled agent / node was not found).
    NotStarted,
    /// This app spawned the agent with this launch's tokens.
    Spawned,
    /// Something this app did not start is listening on the agent port.
    PortOccupied,
}

impl AgentOwnership {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentOwnership::NotStarted => "not_started",
            AgentOwnership::Spawned => "spawned",
            AgentOwnership::PortOccupied => "port_occupied",
        }
    }
}

/// Things that happen to the agent slot; `transition` is the whole state machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentEvent {
    /// Before a spawn: something already listens on the agent port.
    PortBusy,
    /// We spawned the agent with this launch's tokens.
    SpawnOk,
    /// Spawning failed (no bundled agent, no node, ...).
    SpawnFailed,
    /// The child we spawned has exited (or can no longer be checked).
    Exited,
}

/// Next ownership state. Only `SpawnOk` can lead to `Spawned`; an exit always revokes it.
pub fn transition(state: AgentOwnership, event: AgentEvent) -> AgentOwnership {
    match event {
        AgentEvent::PortBusy => AgentOwnership::PortOccupied,
        AgentEvent::SpawnOk => AgentOwnership::Spawned,
        AgentEvent::SpawnFailed => AgentOwnership::NotStarted,
        AgentEvent::Exited => match state {
            AgentOwnership::Spawned => AgentOwnership::NotStarted,
            other => other,
        },
    }
}

pub struct AgentGuard {
    state: Mutex<AgentOwnership>,
}

impl AgentGuard {
    pub fn new() -> Self {
        AgentGuard { state: Mutex::new(AgentOwnership::NotStarted) }
    }

    pub fn get(&self) -> AgentOwnership {
        self.state.lock().map(|g| *g).unwrap_or(AgentOwnership::NotStarted)
    }

    pub fn set(&self, next: AgentOwnership) {
        if let Ok(mut g) = self.state.lock() {
            *g = next;
        }
    }

    pub fn apply(&self, event: AgentEvent) -> AgentOwnership {
        match self.state.lock() {
            Ok(mut g) => {
                *g = transition(*g, event);
                *g
            }
            Err(_) => AgentOwnership::NotStarted,
        }
    }

    /// The inference token, but only while the agent on :4301 is the one this app spawned and
    /// `child_alive` (checked by the caller right now) says it is still running.
    pub fn token_for_webview(&self, token: &str, child_alive: bool) -> Result<String, String> {
        if !child_alive {
            self.apply(AgentEvent::Exited);
        }
        match self.get() {
            AgentOwnership::Spawned => Ok(token.to_string()),
            AgentOwnership::PortOccupied => Err(format!(
                "port_occupied: another process is already listening on {AGENT_ADDR}; the inference token is not sent to it. Stop that process, then retry."
            )),
            AgentOwnership::NotStarted => Err("not_started: the local agent is not running".to_string()),
        }
    }
}

impl Default for AgentGuard {
    fn default() -> Self {
        Self::new()
    }
}

/// True when something accepts TCP connections on `addr`.
pub fn port_in_use(addr: &str) -> bool {
    match addr.parse::<SocketAddr>() {
        Ok(sa) => TcpStream::connect_timeout(&sa, Duration::from_millis(500)).is_ok(),
        Err(_) => false,
    }
}

/// True for the command line of an agent this app spawned: the bundled Node running the bundled
/// `dist/index.js` (spawn_agent_process runs `<app>/Contents/Resources/agent/node/node dist/index.js`).
pub fn is_bundled_agent_command(cmd: &str) -> bool {
    cmd.contains(".app/Contents/Resources/agent/node/node") && cmd.trim_end().ends_with("dist/index.js")
}

/// An agent left running by an earlier launch of this app (the updater's relaunch and some quits
/// skip our cleanup) holds the port and never got this launch's tokens. Stop it so this launch can
/// start its own. Anything else on the port is left alone. Returns true when the port came free.
#[cfg(target_os = "macos")]
pub fn reclaim_stale_agent(addr: &str) -> bool {
    use std::process::Command;
    let port = addr.rsplit(':').next().unwrap_or("4301");
    let Ok(out) = Command::new("/usr/sbin/lsof").args(["-nP", "-t", &format!("-iTCP:{port}"), "-sTCP:LISTEN"]).output() else {
        return false;
    };
    let pids: Vec<String> = String::from_utf8_lossy(&out.stdout).split_whitespace().map(str::to_string).collect();
    if pids.is_empty() {
        return false;
    }
    for pid in &pids {
        let Ok(ps) = Command::new("/bin/ps").args(["-o", "command=", "-p", pid]).output() else {
            return false;
        };
        if !is_bundled_agent_command(&String::from_utf8_lossy(&ps.stdout)) {
            return false;
        }
    }
    for pid in &pids {
        eprintln!("Stopping agent left by an earlier launch (pid {pid})");
        let _ = Command::new("/bin/kill").args(["-TERM", pid]).status();
    }
    for i in 0..50 {
        if !port_in_use(addr) {
            return true;
        }
        if i == 30 {
            for pid in &pids {
                let _ = Command::new("/bin/kill").args(["-KILL", pid]).status();
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    !port_in_use(addr)
}

#[cfg(not(target_os = "macos"))]
pub fn reclaim_stale_agent(_addr: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_only_the_bundled_agent() {
        assert!(is_bundled_agent_command("/Applications/EdgeCoder.app/Contents/Resources/agent/node/node dist/index.js\n"));
        assert!(!is_bundled_agent_command("/Applications/EdgeCoder.app/Contents/Resources/agent/node/node /Applications/EdgeCoder.app/Contents/Resources/agent/dist/apps/ide/provider-server.js"));
        assert!(!is_bundled_agent_command("/opt/homebrew/bin/node dist/index.js"));
        assert!(!is_bundled_agent_command("/usr/local/bin/ollama serve"));
    }
    use std::net::TcpListener;

    #[test]
    fn token_only_for_spawned_agent() {
        let g = AgentGuard::new();
        assert!(g.token_for_webview("t", true).is_err());
        g.set(AgentOwnership::PortOccupied);
        let err = g.token_for_webview("secret-token", true).unwrap_err();
        assert!(err.starts_with("port_occupied"));
        assert!(!err.contains("secret-token"));
        g.set(AgentOwnership::Spawned);
        assert_eq!(g.token_for_webview("t", true).unwrap(), "t");
        g.set(AgentOwnership::PortOccupied);
        assert!(g.token_for_webview("t", true).is_err());
    }

    #[test]
    fn dead_child_revokes_the_token_immediately() {
        let g = AgentGuard::new();
        g.apply(AgentEvent::SpawnOk);
        assert!(g.token_for_webview("t", true).is_ok());
        let err = g.token_for_webview("secret", false).unwrap_err();
        assert!(err.starts_with("not_started"));
        assert!(!err.contains("secret"));
        assert_eq!(g.get(), AgentOwnership::NotStarted);
        // Stays revoked even if a later caller thinks it's alive, until a new spawn.
        assert!(g.token_for_webview("t", true).is_err());
        g.apply(AgentEvent::SpawnOk);
        assert!(g.token_for_webview("t", true).is_ok());
    }

    #[test]
    fn state_transitions() {
        use AgentEvent::*;
        use AgentOwnership::*;
        let cases = [
            (NotStarted, SpawnOk, Spawned),
            (NotStarted, SpawnFailed, NotStarted),
            (NotStarted, PortBusy, PortOccupied),
            (NotStarted, Exited, NotStarted),
            (Spawned, Exited, NotStarted),
            (Spawned, PortBusy, PortOccupied),
            (Spawned, SpawnFailed, NotStarted),
            (PortOccupied, Exited, PortOccupied),
            (PortOccupied, SpawnOk, Spawned),
            (PortOccupied, SpawnFailed, NotStarted),
        ];
        for (from, ev, to) in cases {
            assert_eq!(transition(from, ev), to, "{from:?} + {ev:?}");
        }
    }

    #[test]
    fn retry_lifecycle() {
        // Launch with :4301 taken -> user frees it -> Retry spawns -> that agent dies -> revoked.
        let g = AgentGuard::new();
        g.apply(AgentEvent::PortBusy);
        assert!(g.token_for_webview("t", false).is_err());
        assert_eq!(g.get(), AgentOwnership::PortOccupied);
        g.apply(AgentEvent::SpawnOk);
        assert!(g.token_for_webview("t", true).is_ok());
        g.apply(AgentEvent::Exited);
        assert!(g.token_for_webview("t", true).is_err());
    }

    #[test]
    fn status_strings() {
        assert_eq!(AgentOwnership::NotStarted.as_str(), "not_started");
        assert_eq!(AgentOwnership::Spawned.as_str(), "spawned");
        assert_eq!(AgentOwnership::PortOccupied.as_str(), "port_occupied");
    }

    #[test]
    fn detects_an_occupied_port() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap().to_string();
        assert!(port_in_use(&addr));
        drop(l);
        assert!(!port_in_use(&addr));
        assert!(!port_in_use("not-an-addr"));
    }
}
