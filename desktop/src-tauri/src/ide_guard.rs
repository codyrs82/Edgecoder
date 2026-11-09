//! Only hand the IDE token (~/.edgecoder/ide-token) to an IDE provider this app started.
//!
//! The webview sends the token to 127.0.0.1:4304. The provider there is forked by the agent this
//! app spawned (src/index.ts startIdeProvider), so it is ours only while that agent is ours and,
//! where the OS lets us check, every process listening on :4304 is a direct child of it. Any
//! other listener (a process that took the port first) must not receive the token.

pub const IDE_PORT: u16 = 4304;

/// A process listening on the IDE port and its parent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Listener {
    pub pid: u32,
    pub ppid: u32,
}

/// Ok when there is at least one listener and every listener is a child of `agent_pid`.
pub fn listeners_owned_by(listeners: &[Listener], agent_pid: u32) -> Result<(), String> {
    if listeners.is_empty() {
        return Err("not_ready: the IDE provider is not listening yet".to_string());
    }
    if let Some(l) = listeners.iter().find(|l| l.ppid != agent_pid) {
        return Err(format!(
            "port_occupied: process {} on port {IDE_PORT} was not started by EdgeCoder's agent; the IDE token is not sent to it. Stop that process, then retry.",
            l.pid
        ));
    }
    Ok(())
}

/// Processes listening on the IDE port (any address), or None when this platform can't tell.
#[cfg(target_os = "macos")]
pub fn ide_listeners() -> Option<Vec<Listener>> {
    use std::process::Command;
    let out = Command::new("/usr/sbin/lsof")
        .args(["-nP", "-t", &format!("-iTCP:{IDE_PORT}"), "-sTCP:LISTEN"])
        .output()
        .ok()?;
    let mut listeners = Vec::new();
    for pid in String::from_utf8_lossy(&out.stdout).split_whitespace() {
        let pid: u32 = pid.parse().ok()?;
        let ps = Command::new("/bin/ps").args(["-o", "ppid=", "-p", &pid.to_string()]).output().ok()?;
        let ppid: u32 = String::from_utf8_lossy(&ps.stdout).trim().parse().ok()?;
        listeners.push(Listener { pid, ppid });
    }
    Some(listeners)
}

#[cfg(not(target_os = "macos"))]
pub fn ide_listeners() -> Option<Vec<Listener>> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn our_agents_child_is_trusted() {
        assert!(listeners_owned_by(&[Listener { pid: 20, ppid: 10 }], 10).is_ok());
    }

    #[test]
    fn a_foreign_listener_is_refused() {
        let err = listeners_owned_by(&[Listener { pid: 66, ppid: 1 }], 10).unwrap_err();
        assert!(err.starts_with("port_occupied"));
        // One of ours plus a squatter on another address: still refused.
        assert!(listeners_owned_by(&[Listener { pid: 20, ppid: 10 }, Listener { pid: 66, ppid: 1 }], 10).is_err());
    }

    #[test]
    fn nothing_listening_is_not_ready() {
        assert!(listeners_owned_by(&[], 10).unwrap_err().starts_with("not_ready"));
    }
}
