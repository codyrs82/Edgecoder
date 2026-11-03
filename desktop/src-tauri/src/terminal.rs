// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

//! Integrated terminal: the user's login shell in a pseudo-terminal, started in the open project.
//! Output streams to the webview as `term-data` events (base64 bytes, so a multi-byte character
//! split across reads arrives intact); `term-exit` when the shell ends.

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

struct Term {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals {
    terms: Mutex<HashMap<u32, Term>>,
    next: AtomicU32,
}

#[derive(Clone, Serialize)]
struct TermData {
    id: u32,
    data: String,
}

#[derive(Clone, Serialize)]
struct TermExit {
    id: u32,
}

/// The shell to start: $SHELL when it exists, else zsh, else sh.
fn user_shell() -> String {
    if let Ok(s) = std::env::var("SHELL") {
        if PathBuf::from(&s).exists() {
            return s;
        }
    }
    for s in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if PathBuf::from(s).exists() {
            return s.to_string();
        }
    }
    "sh".to_string()
}

/// Start a terminal; returns its id. `cwd` is the open project (home when missing or not a folder).
#[tauri::command]
pub fn term_spawn(
    app: AppHandle,
    state: tauri::State<'_, Terminals>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let pty = native_pty_system()
        .openpty(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("cannot open a terminal: {e}"))?;
    let mut cmd = CommandBuilder::new(user_shell());
    cmd.arg("-l");
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let dir = cwd.filter(|d| PathBuf::from(d).is_dir()).unwrap_or(home);
    cmd.cwd(dir);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let child = pty.slave.spawn_command(cmd).map_err(|e| format!("cannot start the shell: {e}"))?;
    drop(pty.slave);
    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pty.master.take_writer().map_err(|e| e.to_string())?;
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    state
        .terms
        .lock()
        .map_err(|_| "terminal state poisoned".to_string())?
        .insert(id, Term { writer, master: pty.master, child });

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app.emit("term-data", TermData { id, data });
                }
            }
        }
        let _ = app.emit("term-exit", TermExit { id });
    });
    Ok(id)
}

#[tauri::command]
pub fn term_write(state: tauri::State<'_, Terminals>, id: u32, data: String) -> Result<(), String> {
    let mut terms = state.terms.lock().map_err(|_| "terminal state poisoned".to_string())?;
    let t = terms.get_mut(&id).ok_or("no such terminal")?;
    t.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    t.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_resize(state: tauri::State<'_, Terminals>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let terms = state.terms.lock().map_err(|_| "terminal state poisoned".to_string())?;
    let t = terms.get(&id).ok_or("no such terminal")?;
    t.master
        .resize(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_kill(state: tauri::State<'_, Terminals>, id: u32) -> Result<(), String> {
    let mut terms = state.terms.lock().map_err(|_| "terminal state poisoned".to_string())?;
    if let Some(mut t) = terms.remove(&id) {
        let _ = t.child.kill();
    }
    Ok(())
}

/// Stop every terminal (app exit).
pub fn kill_all(state: &Terminals) {
    if let Ok(mut terms) = state.terms.lock() {
        for (_, mut t) in terms.drain() {
            let _ = t.child.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::user_shell;

    #[test]
    fn finds_a_shell() {
        assert!(!user_shell().is_empty());
    }

    #[test]
    fn login_shell_starts_in_the_given_folder() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;
        let dir = std::env::temp_dir().join("ec-pty-cwd-test");
        let _ = std::fs::create_dir_all(&dir);
        let pty = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        // Same as term_spawn (login shell, cwd), but non-interactive so the test ends.
        let mut cmd = CommandBuilder::new(super::user_shell());
        cmd.args(["-l", "-c", "echo CWD=$(pwd -P)"]);
        cmd.cwd(&dir);
        let mut child = pty.slave.spawn_command(cmd).unwrap();
        drop(pty.slave);
        let mut reader = pty.master.try_clone_reader().unwrap();
        let real = std::fs::canonicalize(&dir).unwrap();
        let want = format!("CWD={}", real.display());
        let mut out = String::new();
        let mut buf = [0u8; 4096];
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while std::time::Instant::now() < deadline {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => out.push_str(&String::from_utf8_lossy(&buf[..n])),
            }
            if out.contains(&want) { break; }
        }
        let _ = child.kill();
        assert!(out.contains(&want), "got {out:?}");
    }

    #[test]
    fn runs_a_command_in_a_pty_and_reads_its_output() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;
        let pty = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "printf 'pty-ok %s' \"$(tput cols 2>/dev/null || echo 80)\""]);
        cmd.env("TERM", "xterm-256color");
        let mut child = pty.slave.spawn_command(cmd).unwrap();
        drop(pty.slave);
        let mut reader = pty.master.try_clone_reader().unwrap();
        let mut out = String::new();
        let mut buf = [0u8; 1024];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 { break; }
            out.push_str(&String::from_utf8_lossy(&buf[..n]));
            if out.contains("pty-ok") && out.trim_end().ends_with("80") { break; }
        }
        let _ = child.wait();
        assert!(out.contains("pty-ok 80"), "got {out:?}");
    }
}
