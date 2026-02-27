// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

use std::net::TcpStream;
use std::process::{Command, Child};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;
use sysinfo::{System, Disks};
use serde::Serialize;

struct AgentProcess(Mutex<Option<Child>>);
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

fn start_agent(app: &tauri::App, local_token: &str) -> Option<Child> {
    if agent_already_running() {
        eprintln!("EdgeCoder agent already running on :4301 — skipping spawn");
        return None;
    }

    // Try bundled agent in Tauri resource directory first
    let agent_dir = app
        .path()
        .resource_dir()
        .ok()
        .map(|p| p.join("agent"))
        .filter(|p| p.join("dist/index.js").exists())
        // Fall back to system install path
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

    Command::new("node")
        .arg("dist/index.js")
        .current_dir(&agent_dir)
        .env("EDGE_RUNTIME_MODE", "all-in-one")
        .env("INFERENCE_AUTH_TOKEN", local_token)
        .env("ADMIN_API_TOKEN", local_token)
        .spawn()
        .ok()
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

            let child = start_agent(app, &local_token);
            app.manage(AgentProcess(Mutex::new(child)));

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
