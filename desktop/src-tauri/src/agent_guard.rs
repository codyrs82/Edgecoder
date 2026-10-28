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

    /// The inference token, but only while the agent on :4301 is the one this app spawned.
    pub fn token_for_webview(&self, token: &str) -> Result<String, String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn token_only_for_spawned_agent() {
        let g = AgentGuard::new();
        assert!(g.token_for_webview("t").is_err());
        g.set(AgentOwnership::PortOccupied);
        let err = g.token_for_webview("secret-token").unwrap_err();
        assert!(err.starts_with("port_occupied"));
        assert!(!err.contains("secret-token"));
        g.set(AgentOwnership::Spawned);
        assert_eq!(g.token_for_webview("t").unwrap(), "t");
        g.set(AgentOwnership::PortOccupied);
        assert!(g.token_for_webview("t").is_err());
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
