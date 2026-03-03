// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

use std::fs;
use std::io::Write as IoWrite;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Command, Child};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;
use sysinfo::{System, Disks};
use serde::Serialize;
use glob::glob;

struct AgentProcess(Arc<Mutex<Option<Child>>>);
struct LocalToken(String);
struct ProjectRoot(Arc<Mutex<Option<PathBuf>>>);

#[derive(Serialize)]
struct SystemMetrics {
    cpu_usage_percent: f32,
    memory_used_mb: u64,
    memory_total_mb: u64,
    disk_used_gb: f64,
    disk_total_gb: f64,
}

#[derive(Serialize, Clone)]
struct DirEntry {
    name: String,
    entry_type: String,
    size: u64,
}

#[derive(Serialize, Clone)]
struct SearchMatch {
    file: String,
    line: usize,
    content: String,
}

#[derive(Serialize, Clone)]
struct ShellResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

fn resolve_project_path(root: &PathBuf, relative: &str) -> Result<PathBuf, String> {
    let candidate = root.join(relative);
    let resolved = candidate.canonicalize().map_err(|e| format!("Cannot resolve path '{}': {}", relative, e))?;
    let canonical_root = root.canonicalize().map_err(|e| format!("Cannot canonicalize project root: {}", e))?;
    if !resolved.starts_with(&canonical_root) {
        return Err("Path escapes project root".to_string());
    }
    Ok(resolved)
}

#[tauri::command]
fn get_system_metrics() -> SystemMetrics {
    let mut sys = System::new_all();
    sys.refresh_all();

    let cpu_count = sys.cpus().len() as f32;
    let cpu_usage_percent = if cpu_count > 0.0 {
        sys.cpus().iter().map(|c| c.cpu_usage()).sum::<f32>() / cpu_count
    } else {
        0.0
    };

    let memory_used_mb = sys.used_memory() / 1_048_576;
    let memory_total_mb = sys.total_memory() / 1_048_576;

    let disks = Disks::new_with_refreshed_list();
    let disk_total_bytes: u64 = disks.iter().map(|d| d.total_space()).sum();
    let disk_available_bytes: u64 = disks.iter().map(|d| d.available_space()).sum();
    let disk_used_bytes = disk_total_bytes.saturating_sub(disk_available_bytes);

    let disk_total_gb = disk_total_bytes as f64 / 1_073_741_824.0;
    let disk_used_gb = disk_used_bytes as f64 / 1_073_741_824.0;

    SystemMetrics {
        cpu_usage_percent,
        memory_used_mb,
        memory_total_mb,
        disk_used_gb,
        disk_total_gb,
    }
}

#[tauri::command]
fn get_local_token(state: tauri::State<'_, LocalToken>) -> String {
    state.0.clone()
}

#[tauri::command]
fn set_project_root(path: String, state: tauri::State<'_, ProjectRoot>) -> Result<String, String> {
    let pb = PathBuf::from(&path);
    if !pb.is_dir() {
        return Err(format!("'{}' is not a valid directory", path));
    }
    let canonical = pb.canonicalize().map_err(|e| format!("Cannot canonicalize path: {}", e))?;
    let display = canonical.display().to_string();
    let mut guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    *guard = Some(canonical);
    Ok(display)
}

#[tauri::command]
fn get_project_root(state: tauri::State<'_, ProjectRoot>) -> Result<String, String> {
    let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    match guard.as_ref() {
        Some(p) => Ok(p.display().to_string()),
        None => Err("No project root set".to_string()),
    }
}

#[tauri::command]
fn project_read_file(
    path: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
    state: tauri::State<'_, ProjectRoot>,
) -> Result<String, String> {
    let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    let root = guard.as_ref().ok_or("No project root set")?;
    let resolved = resolve_project_path(root, &path)?;

    let content = fs::read_to_string(&resolved)
        .map_err(|e| format!("Cannot read file '{}': {}", path, e))?;

    match (start_line, end_line) {
        (Some(start), Some(end)) => {
            let lines: Vec<&str> = content.lines().collect();
            let start_idx = if start > 0 { start - 1 } else { 0 };
            let end_idx = end.min(lines.len());
            if start_idx >= lines.len() {
                return Ok(String::new());
            }
            Ok(lines[start_idx..end_idx].join("\n"))
        }
        (Some(start), None) => {
            let lines: Vec<&str> = content.lines().collect();
            let start_idx = if start > 0 { start - 1 } else { 0 };
            if start_idx >= lines.len() {
                return Ok(String::new());
            }
            Ok(lines[start_idx..].join("\n"))
        }
        (None, Some(end)) => {
            let lines: Vec<&str> = content.lines().collect();
            let end_idx = end.min(lines.len());
            Ok(lines[..end_idx].join("\n"))
        }
        (None, None) => Ok(content),
    }
}

#[tauri::command]
fn project_write_file(
    path: String,
    content: String,
    state: tauri::State<'_, ProjectRoot>,
) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    let root = guard.as_ref().ok_or("No project root set")?;

    // For new files, resolve the parent directory to ensure it's within the project root,
    // then construct the target path.
    let candidate = root.join(&path);
    if let Some(parent) = candidate.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create parent dirs for '{}': {}", path, e))?;
        }
    }

    // Now resolve the parent to ensure it's within the project root
    let parent = candidate.parent().ok_or("Invalid path")?;
    let canonical_parent = parent.canonicalize().map_err(|e| format!("Cannot canonicalize parent: {}", e))?;
    let canonical_root = root.canonicalize().map_err(|e| format!("Cannot canonicalize root: {}", e))?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err("Path escapes project root".to_string());
    }

    let target = canonical_parent.join(candidate.file_name().ok_or("Invalid file name")?);

    let mut file = fs::File::create(&target)
        .map_err(|e| format!("Cannot create file '{}': {}", path, e))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("Cannot write file '{}': {}", path, e))?;
    Ok(())
}

#[tauri::command]
fn project_list_dir(
    path: Option<String>,
    pattern: Option<String>,
    state: tauri::State<'_, ProjectRoot>,
) -> Result<Vec<DirEntry>, String> {
    let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    let root = guard.as_ref().ok_or("No project root set")?;

    let dir = match path.as_deref() {
        Some(p) if !p.is_empty() => resolve_project_path(root, p)?,
        _ => root.canonicalize().map_err(|e| format!("Cannot canonicalize root: {}", e))?,
    };

    if let Some(pat) = pattern {
        let glob_pattern = dir.join(&pat).display().to_string();
        let mut entries = Vec::new();
        for entry in glob(&glob_pattern).map_err(|e| format!("Invalid glob pattern: {}", e))? {
            match entry {
                Ok(p) => {
                    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
                    if let Ok(cp) = p.canonicalize() {
                        if !cp.starts_with(&canonical_root) {
                            continue;
                        }
                    }
                    let meta = fs::metadata(&p);
                    let name = p.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let (entry_type, size) = match meta {
                        Ok(m) => {
                            let t = if m.is_dir() { "directory" } else { "file" };
                            (t.to_string(), m.len())
                        }
                        Err(_) => ("unknown".to_string(), 0),
                    };
                    entries.push(DirEntry { name, entry_type, size });
                }
                Err(_) => continue,
            }
        }
        return Ok(entries);
    }

    let read_dir = fs::read_dir(&dir)
        .map_err(|e| format!("Cannot read directory '{}': {}", dir.display(), e))?;

    let mut entries = Vec::new();
    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Error reading entry: {}", e))?;
        let meta = entry.metadata().map_err(|e| format!("Error reading metadata: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let entry_type = if meta.is_dir() {
            "directory".to_string()
        } else if meta.is_symlink() {
            "symlink".to_string()
        } else {
            "file".to_string()
        };
        let size = meta.len();
        entries.push(DirEntry { name, entry_type, size });
    }

    Ok(entries)
}

#[tauri::command]
fn project_search(
    pattern: String,
    path: Option<String>,
    include: Option<String>,
    state: tauri::State<'_, ProjectRoot>,
) -> Result<Vec<SearchMatch>, String> {
    let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    let root = guard.as_ref().ok_or("No project root set")?;
    let canonical_root = root.canonicalize().map_err(|e| format!("Cannot canonicalize root: {}", e))?;

    let search_dir = match path.as_deref() {
        Some(p) if !p.is_empty() => resolve_project_path(root, p)?,
        _ => canonical_root.clone(),
    };

    let mut args = vec![
        "-r".to_string(),
        "-n".to_string(),
        "--color=never".to_string(),
    ];

    if let Some(ref inc) = include {
        args.push(format!("--include={}", inc));
    }

    args.push(pattern);
    args.push(search_dir.display().to_string());

    let output = Command::new("grep")
        .args(&args)
        .output()
        .map_err(|e| format!("Cannot run grep: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut results = Vec::new();

    for line in stdout.lines() {
        // Format: filepath:line_number:content
        let mut parts = line.splitn(3, ':');
        if let (Some(file_path), Some(line_num), Some(content)) =
            (parts.next(), parts.next(), parts.next())
        {
            let fp = PathBuf::from(file_path);
            // Make path relative to project root
            let relative = fp
                .strip_prefix(&canonical_root)
                .unwrap_or(&fp)
                .display()
                .to_string();

            if let Ok(ln) = line_num.parse::<usize>() {
                results.push(SearchMatch {
                    file: relative,
                    line: ln,
                    content: content.to_string(),
                });
            }
        }
    }

    // Cap results to prevent overwhelming output
    if results.len() > 500 {
        results.truncate(500);
    }

    Ok(results)
}

#[tauri::command]
fn project_run_shell(
    command: String,
    timeout_ms: Option<u64>,
    state: tauri::State<'_, ProjectRoot>,
) -> Result<ShellResult, String> {
    let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    let root = guard.as_ref().ok_or("No project root set")?;
    let canonical_root = root.canonicalize().map_err(|e| format!("Cannot canonicalize root: {}", e))?;

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000));

    let mut child = Command::new("sh")
        .arg("-c")
        .arg(&command)
        .current_dir(&canonical_root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Cannot spawn command: {}", e))?;

    // Wait with timeout by polling try_wait
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                // Process has exited; collect all output via wait_with_output
                let output = child.wait_with_output()
                    .map_err(|e| format!("Cannot read command output: {}", e))?;

                return Ok(ShellResult {
                    stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                    stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                    exit_code: output.status.code().unwrap_or(-1),
                });
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    return Err(format!("Command timed out after {}ms", timeout.as_millis()));
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("Error waiting for command: {}", e)),
        }
    }
}

fn run_git_command(root: &PathBuf, args: &[&str]) -> Result<ShellResult, String> {
    let canonical_root = root.canonicalize().map_err(|e| format!("Cannot canonicalize root: {}", e))?;
    let output = Command::new("git")
        .args(args)
        .current_dir(&canonical_root)
        .output()
        .map_err(|e| format!("Cannot run git: {}", e))?;

    Ok(ShellResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

#[tauri::command]
fn project_git_status(state: tauri::State<'_, ProjectRoot>) -> Result<ShellResult, String> {
    let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    let root = guard.as_ref().ok_or("No project root set")?;
    run_git_command(root, &["status", "--porcelain"])
}

#[tauri::command]
fn project_git_diff(
    staged: Option<bool>,
    file: Option<String>,
    state: tauri::State<'_, ProjectRoot>,
) -> Result<ShellResult, String> {
    let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    let root = guard.as_ref().ok_or("No project root set")?;

    let mut args: Vec<&str> = vec!["diff"];
    if staged.unwrap_or(false) {
        args.push("--cached");
    }

    let file_str;
    if let Some(ref f) = file {
        // Validate path doesn't escape root
        resolve_project_path(root, f)?;
        file_str = f.clone();
        args.push("--");
        args.push(&file_str);
    }

    run_git_command(root, &args)
}

#[tauri::command]
fn project_git_log(
    count: Option<u32>,
    state: tauri::State<'_, ProjectRoot>,
) -> Result<ShellResult, String> {
    let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    let root = guard.as_ref().ok_or("No project root set")?;

    let n = count.unwrap_or(20);
    let n_str = format!("-{}", n);
    run_git_command(root, &["log", "--oneline", &n_str])
}

#[tauri::command]
fn project_git_commit(
    message: String,
    files: Vec<String>,
    state: tauri::State<'_, ProjectRoot>,
) -> Result<ShellResult, String> {
    let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    let root = guard.as_ref().ok_or("No project root set")?;

    // Validate all files are within the project root
    for f in &files {
        resolve_project_path(root, f)?;
    }

    // Stage files
    let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
    let mut add_args = vec!["add"];
    add_args.extend_from_slice(&file_refs);
    let add_result = run_git_command(root, &add_args)?;
    if add_result.exit_code != 0 {
        return Err(format!("git add failed: {}", add_result.stderr));
    }

    // Commit
    run_git_command(root, &["commit", "-m", &message])
}

#[tauri::command]
fn project_git_branch(
    name: String,
    create: Option<bool>,
    state: tauri::State<'_, ProjectRoot>,
) -> Result<ShellResult, String> {
    let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    let root = guard.as_ref().ok_or("No project root set")?;

    if create.unwrap_or(false) {
        run_git_command(root, &["checkout", "-b", &name])
    } else {
        run_git_command(root, &["checkout", &name])
    }
}

fn agent_already_running() -> bool {
    TcpStream::connect("127.0.0.1:4301").is_ok()
}

fn spawn_agent_process(agent_dir: &PathBuf, local_token: &str) -> Option<Child> {
    Command::new("node")
        .arg("dist/index.js")
        .current_dir(agent_dir)
        .env("EDGE_RUNTIME_MODE", "all-in-one")
        .env("INFERENCE_AUTH_TOKEN", local_token)
        .env("ADMIN_API_TOKEN", local_token)
        .spawn()
        .ok()
}

fn resolve_agent_dir(app: &tauri::App) -> Option<PathBuf> {
    let agent_dir = app
        .path()
        .resource_dir()
        .ok()
        .map(|p| p.join("agent"))
        .filter(|p| p.join("dist/index.js").exists())
        .unwrap_or_else(|| {
            std::env::var("EDGECODER_INSTALL_DIR")
                .unwrap_or_else(|_| "/opt/edgecoder/app".to_string())
                .into()
        });

    eprintln!("Starting agent from: {:?}", agent_dir);

    if !agent_dir.join("dist/index.js").exists() {
        eprintln!("Agent not found at {:?} — skipping", agent_dir);
        return None;
    }

    Some(agent_dir)
}

fn start_agent(app: &tauri::App, local_token: &str) -> (Option<Child>, Option<PathBuf>) {
    if agent_already_running() {
        eprintln!("EdgeCoder agent already running on :4301 — skipping spawn");
        return (None, None);
    }

    let agent_dir = match resolve_agent_dir(app) {
        Some(dir) => dir,
        None => return (None, None),
    };

    let child = spawn_agent_process(&agent_dir, local_token);
    (child, Some(agent_dir))
}

fn monitor_agent(
    agent_mutex: Arc<Mutex<Option<Child>>>,
    agent_dir: PathBuf,
    local_token: String,
) {
    thread::spawn(move || {
        let mut restarts = 0u32;
        const MAX_RESTARTS: u32 = 5;

        loop {
            thread::sleep(Duration::from_secs(5));

            let needs_restart = {
                let mut guard: std::sync::MutexGuard<'_, Option<Child>> =
                    match agent_mutex.lock() {
                        Ok(g) => g,
                        Err(_) => continue,
                    };
                match guard.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(status)) => {
                            eprintln!("Agent process exited with: {status}");
                            *guard = None;
                            true
                        }
                        Ok(None) => false, // still running
                        Err(e) => {
                            eprintln!("Error checking agent process: {e}");
                            false
                        }
                    },
                    None => false,
                }
            };

            if needs_restart {
                if restarts >= MAX_RESTARTS {
                    eprintln!(
                        "Agent has restarted {MAX_RESTARTS} times — stopping auto-restart"
                    );
                    break;
                }

                eprintln!(
                    "Restarting agent in 3s (restart {}/{})",
                    restarts + 1,
                    MAX_RESTARTS
                );
                thread::sleep(Duration::from_secs(3));

                if agent_already_running() {
                    eprintln!("Agent port is already in use — skipping respawn");
                    continue;
                }

                let new_child = spawn_agent_process(&agent_dir, &local_token);
                if let Ok(mut guard) = agent_mutex.lock() {
                    *guard = new_child;
                }
                restarts += 1;
            }
        }
    });
}

fn main() {
    // Generate a per-session token for local inference auth using timestamp + pid
    let local_token = format!(
        "local-{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id()
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(LocalToken(local_token.clone()))
        .manage(ProjectRoot(Arc::new(Mutex::new(None))))
        .invoke_handler(tauri::generate_handler![
            get_system_metrics,
            get_local_token,
            set_project_root,
            get_project_root,
            project_read_file,
            project_write_file,
            project_list_dir,
            project_search,
            project_run_shell,
            project_git_status,
            project_git_diff,
            project_git_log,
            project_git_commit,
            project_git_branch,
        ])
        .setup(move |app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

            let (child, agent_dir) = start_agent(app, &local_token);
            let agent_mutex = Arc::new(Mutex::new(child));
            app.manage(AgentProcess(Arc::clone(&agent_mutex)));

            if let Some(dir) = agent_dir {
                monitor_agent(Arc::clone(&agent_mutex), dir, local_token.clone());
            }

            // Listen for deep link events (edgecoder://oauth-callback?...)
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls = event.urls();
                if let Some(url) = urls.first() {
                    let url_str = url.to_string();
                    eprintln!("[deep-link] received: {}", url_str);
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.eval(&format!(
                            "window.__handleDeepLink({})",
                            serde_json::to_string(&url_str).unwrap_or_default()
                        ));
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<AgentProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(ref mut child) = *guard {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error running EdgeCoder desktop app");
}
