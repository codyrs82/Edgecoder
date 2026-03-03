// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

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

struct AgentProcess(Arc<Mutex<Option<Child>>>);
struct LocalToken(String);

#[derive(Serialize)]
struct SystemMetrics {
    cpu_usage_percent: f32,
    memory_used_mb: u64,
    memory_total_mb: u64,
    disk_used_gb: f64,
    disk_total_gb: f64,
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
        .manage(LocalToken(local_token.clone()))
        .invoke_handler(tauri::generate_handler![get_system_metrics, get_local_token])
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
