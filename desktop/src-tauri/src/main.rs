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

fn agent_already_running() -> bool {
    TcpStream::connect("127.0.0.1:4301").is_ok()
}

fn start_agent() -> Option<Child> {
    if agent_already_running() {
        eprintln!("EdgeCoder agent already running on :4301 — skipping spawn");
        return None;
    }

    let agent_dir = std::env::var("EDGECODER_INSTALL_DIR")
        .unwrap_or_else(|_| "/opt/edgecoder/app".to_string());

    Command::new("node")
        .arg("dist/index.js")
        .current_dir(&agent_dir)
        .env("EDGE_RUNTIME_MODE", "all-in-one")
        .spawn()
        .ok()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![get_system_metrics])
        .setup(|app| {
            let child = start_agent();
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
