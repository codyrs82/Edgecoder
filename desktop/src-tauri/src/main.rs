use std::process::{Command, Child};
use std::sync::Mutex;
use tauri::Manager;

struct AgentProcess(Mutex<Option<Child>>);

fn start_agent() -> Option<Child> {
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
        .setup(|app| {
            let child = start_agent();
            app.manage(AgentProcess(Mutex::new(child)));
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
