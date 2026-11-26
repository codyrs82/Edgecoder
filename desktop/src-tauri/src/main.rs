// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

use std::fs;
use std::io::Write as IoWrite;
use std::path::PathBuf;
use std::process::{Command, Child};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;
use sysinfo::{System, Disks};
use serde::Serialize;

mod agent_attest;
mod app_nap;
mod agent_guard;
mod agent_settings;
mod ide_guard;
mod local_compute;
mod navigation;
mod remote_hosts;
mod network_enrollment;
mod service_supervisor;
mod terminal;
mod token;
use agent_guard::{port_in_use, reclaim_stale_agent, AgentEvent, AgentGuard, AgentOwnership, AGENT_ADDR};
use token::generate_local_token;
use network_enrollment::{NetworkEnrollment, NetworkEnrollmentSummary};
use service_supervisor::{Action as ServiceAction, Supervisor};

struct AgentProcess(Arc<Mutex<Option<Child>>>);
/// The self-healing state for the local service (service_supervisor.rs), shared by the monitor
/// thread and the "Restart now" / update commands.
struct ServiceSupervisor(Arc<Mutex<Supervisor>>);
/// This build's version (tauri.conf.json), recorded next to the agent it starts.
static APP_VERSION: OnceLock<String> = OnceLock::new();
struct LocalToken(String);
/// #72: whether the agent on :4301 is ours, plus what's needed to retry a spawn.
struct AgentControl {
    guard: Arc<AgentGuard>,
    agent_dir: Option<PathBuf>,
    tokens: AgentTokens,
}

/// Secrets handed to the spawned agent (#6). Separate values so a leaked inference token
/// (exposed to the webview) does not grant admin access. Fresh per launch, unless the agent an
/// earlier launch started is still on :4301 and proves it holds them (#147).
#[derive(Clone)]
struct AgentTokens {
    inference: String,
    admin: String,
}

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

    // The disk holding the user's files. Summing every mount double-counts: on macOS the system
    // and data volumes share one APFS container and each reports its full size.
    let disks = Disks::new_with_refreshed_list();
    let mounts: Vec<(String, u64, u64)> = disks
        .iter()
        .map(|d| (d.mount_point().to_string_lossy().into_owned(), d.total_space(), d.available_space()))
        .collect();
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let (disk_total_bytes, disk_available_bytes) = disk_for_path(&mounts, &home).unwrap_or((0, 0));
    let disk_used_bytes = disk_total_bytes.saturating_sub(disk_available_bytes);

    // Decimal GB, as Finder and About This Mac show it.
    let disk_total_gb = disk_total_bytes as f64 / 1e9;
    let disk_used_gb = disk_used_bytes as f64 / 1e9;

    SystemMetrics {
        cpu_usage_percent,
        memory_used_mb,
        memory_total_mb,
        disk_used_gb,
        disk_total_gb,
    }
}

/// (total, available) bytes of the mount that holds `path`: the longest mount point it sits under.
fn disk_for_path(mounts: &[(String, u64, u64)], path: &str) -> Option<(u64, u64)> {
    mounts
        .iter()
        .filter(|(m, total, _)| {
            *total > 0 && (m == "/" || path == m || path.starts_with(&format!("{}/", m.trim_end_matches('/'))))
        })
        .max_by_key(|(m, _, _)| m.len())
        .map(|(_, t, a)| (*t, *a))
}

/// #72: the inference token goes to the webview only while :4301 is the agent this app spawned.
#[tauri::command]
fn get_local_token(
    state: tauri::State<'_, LocalToken>,
    control: tauri::State<'_, AgentControl>,
    process: tauri::State<'_, AgentProcess>,
) -> Result<String, String> {
    // Check the child right now, so a dead agent never gets the token in the monitor's gap.
    let alive = agent_alive(&control, &process);
    control.guard.token_for_webview(&state.0, alive)
}

/// Whether our agent is there right now: the child we spawned is running, or (#147) the reused
/// agent answers a fresh challenge with our admin token.
fn agent_alive(control: &AgentControl, process: &AgentProcess) -> bool {
    if control.guard.get() == AgentOwnership::Verified {
        return agent_attest::challenge(AGENT_ADDR, &control.tokens.admin);
    }
    process.0.lock().map(|mut g| child_alive(&mut g)).unwrap_or(false)
}

/// #147: the listener on :4301 answers a fresh challenge with this app's admin token.
fn verify_existing_agent(tokens: &AgentTokens) -> bool {
    let ok = agent_attest::challenge(AGENT_ADDR, &tokens.admin);
    if ok {
        eprintln!("The agent already on :4301 answered the challenge; reusing it");
    }
    ok
}

/// Keep the tokens a spawned agent gets, so a later launch can verify and reuse it (#147).
fn persist_tokens(tokens: &AgentTokens) {
    let Some(p) = agent_attest::tokens_path() else { return };
    let stored = agent_attest::StoredTokens { inference: tokens.inference.clone(), admin: tokens.admin.clone() };
    if let Err(e) = agent_attest::save_tokens(&p, &stored) {
        eprintln!("Could not save the agent tokens (a later launch won't reuse this agent): {e}");
    }
}

/// True while the child we spawned is still running.
fn child_alive(slot: &mut Option<Child>) -> bool {
    match slot.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => false,
    }
}

/// #138: save the coordinator / portal URLs from Settings so the next launch's CSP allows their
/// exact origins. `restartNeeded` is true while the running window's CSP doesn't allow them yet.
#[tauri::command]
fn set_remote_hosts(
    coordinator: Option<String>,
    portal: Option<String>,
    applied: tauri::State<'_, remote_hosts::AppliedHosts>,
) -> Result<remote_hosts::HostsSaved, String> {
    let hosts = remote_hosts::RemoteHosts::validated(coordinator, portal)?;
    let p = remote_hosts::path().ok_or("no home directory")?;
    if remote_hosts::load_from(&p) != hosts {
        remote_hosts::save_to(&p, &hosts)?;
    }
    Ok(remote_hosts::HostsSaved { restart_needed: remote_hosts::restart_needed(&applied.0, &hosts) })
}

/// #72: "spawned", "port_occupied" or "not_started", for the UI.
#[tauri::command]
fn get_agent_status(
    control: tauri::State<'_, AgentControl>,
    process: tauri::State<'_, AgentProcess>,
) -> String {
    let alive = agent_alive(&control, &process);
    if !alive {
        control.guard.apply(AgentEvent::Exited);
    }
    control.guard.get().as_str().to_string()
}

/// #72: after the user stops whatever held :4301, try to spawn our own agent again.
#[tauri::command]
fn retry_local_agent(
    control: tauri::State<'_, AgentControl>,
    process: tauri::State<'_, AgentProcess>,
) -> String {
    let alive = agent_alive(&control, &process);
    let state = control.guard.get();
    if alive && matches!(state, AgentOwnership::Spawned | AgentOwnership::Verified) {
        return state.as_str().to_string();
    }
    if !alive {
        control.guard.apply(AgentEvent::Exited);
    }
    // The monitor thread (started at launch whenever an agent dir exists) watches what starts here.
    start_service(&process.0, control.agent_dir.as_ref(), &control.tokens, &control.guard);
    control.guard.get().as_str().to_string()
}

/// Start our agent (and with it the IDE provider on :4304) unless one of ours is already there.
/// Returns true when our agent is running afterwards. Shared by Retry, "Restart now" and the
/// monitor's automatic restarts.
fn start_service(
    agent: &Arc<Mutex<Option<Child>>>,
    agent_dir: Option<&PathBuf>,
    tokens: &AgentTokens,
    guard: &AgentGuard,
) -> bool {
    if let Ok(mut slot) = agent.lock() {
        if child_alive(&mut slot) {
            return true; // a Retry or the monitor started one meanwhile
        }
    }
    if port_in_use(AGENT_ADDR) {
        // #147: reuse it only when it proves it holds our admin token.
        if verify_existing_agent(tokens) {
            guard.apply(AgentEvent::Verified);
            return true;
        }
        if !reclaim_stale_agent(AGENT_ADDR) {
            guard.apply(AgentEvent::PortBusy);
            log_service("Another process holds port 4301, so EdgeCoder's local service can't start; trying again later");
            return false;
        }
    }
    let Some(dir) = agent_dir else {
        guard.apply(AgentEvent::SpawnFailed);
        return false;
    };
    let Ok(mut slot) = agent.lock() else { return false };
    if child_alive(&mut slot) {
        return true;
    }
    let child = spawn_agent_process(dir, tokens);
    let ok = child.is_some();
    guard.apply(if ok { AgentEvent::SpawnOk } else { AgentEvent::SpawnFailed });
    *slot = child;
    ok
}

/// Stop our agent and wait for it to exit (its IDE provider exits with it). A reused agent from an
/// earlier launch (#147) has no child here; it is stopped through reclaim_stale_agent.
fn stop_service(agent: &Arc<Mutex<Option<Child>>>, guard: &AgentGuard) {
    let had_child = match agent.lock() {
        Ok(mut slot) => match slot.take() {
            Some(mut child) => {
                let _ = child.kill();
                let _ = child.wait();
                true
            }
            None => false,
        },
        Err(_) => false,
    };
    if !had_child && guard.get() == AgentOwnership::Verified && port_in_use(AGENT_ADDR) {
        reclaim_stale_agent(AGENT_ADDR);
    }
    guard.apply(AgentEvent::Exited);
}

/// Write a line about the service to ~/.edgecoder/agent.log (and stderr), so "View log" and
/// Settings → Logs show every automatic restart.
fn log_service(msg: &str) {
    eprintln!("[service] {msg}");
    let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) else { return };
    let dir = PathBuf::from(home).join(".edgecoder");
    let _ = fs::create_dir_all(&dir);
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(dir.join("agent.log")) {
        let _ = writeln!(f, "{}", service_supervisor::log_line(msg));
    }
}

/// "Restart now" (shown once automatic restarts have failed for about a minute): stop whatever is
/// left of the service and start it at once, with the backoff from the beginning.
#[tauri::command]
fn restart_local_service(
    control: tauri::State<'_, AgentControl>,
    process: tauri::State<'_, AgentProcess>,
    supervisor: tauri::State<'_, ServiceSupervisor>,
) -> String {
    log_service("Restart now: restarting EdgeCoder's local service");
    stop_service(&process.0, &control.guard);
    let ok = start_service(&process.0, control.agent_dir.as_ref(), &control.tokens, &control.guard);
    if let Ok(mut s) = supervisor.0.lock() {
        s.manual_restart(Instant::now(), ok);
    }
    control.guard.get().as_str().to_string()
}

/// Before the updater relaunches the app: stop the service (so the new version starts its own,
/// with the new agent code) and keep the monitor from starting the old one again meanwhile.
/// `restart_local_service` undoes it if the relaunch doesn't happen.
#[tauri::command]
fn stop_local_service_for_update(
    control: tauri::State<'_, AgentControl>,
    process: tauri::State<'_, AgentProcess>,
    supervisor: tauri::State<'_, ServiceSupervisor>,
) {
    if let Ok(mut s) = supervisor.0.lock() {
        s.pause();
    }
    log_service("Stopping EdgeCoder's local service to install an update");
    stop_service(&process.0, &control.guard);
}

/// The last lines of ~/.edgecoder/agent.log, for "View log".
#[tauri::command]
fn read_service_log() -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).ok_or("home directory not found")?;
    let path = PathBuf::from(home).join(".edgecoder").join("agent.log");
    let mut f = fs::File::open(&path).map_err(|_| "No log yet (~/.edgecoder/agent.log).".to_string())?;
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    const MAX: u64 = 64 * 1024;
    if len > MAX {
        let _ = f.seek(SeekFrom::Start(len - MAX));
    }
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(service_supervisor::tail_lines(&String::from_utf8_lossy(&buf), 200))
}

/// Kill the agent so the monitor thread respawns it with the current local-compute env.
fn restart_agent(agent: &Arc<Mutex<Option<Child>>>) {
    if let Ok(mut guard) = agent.lock() {
        if let Some(ref mut child) = *guard {
            let _ = child.kill();
        }
    }
}

/// Settings > General choices that the agent reads at start (BLE mesh on or off).
#[tauri::command]
fn get_agent_settings() -> agent_settings::AgentSettings {
    agent_settings::load()
}

/// Save the BLE mesh choice and restart the agent so it takes effect (the monitor respawns it).
#[tauri::command]
fn set_agent_ble(enabled: bool, process: tauri::State<'_, AgentProcess>) -> Result<agent_settings::AgentSettings, String> {
    let mut s = agent_settings::load();
    if s.ble_enabled != enabled {
        s.ble_enabled = enabled;
        agent_settings::save(&s)?;
        restart_agent(&process.0);
    }
    Ok(s)
}

/// Save "Code from your phone" (off, view or on) and restart the agent so it takes effect.
#[tauri::command]
fn set_agent_code_relay(mode: String, process: tauri::State<'_, AgentProcess>) -> Result<agent_settings::AgentSettings, String> {
    if !agent_settings::CODE_RELAY_MODES.contains(&mode.as_str()) {
        return Err("expected off, view or on".into());
    }
    let mut s = agent_settings::load();
    if s.code_relay_mode() != mode {
        s.code_relay = mode;
        agent_settings::save(&s)?;
        restart_agent(&process.0);
    }
    Ok(s)
}

/// First-run local compute (Ollama + the Colima Docker sandbox): progress for the setup screen.
#[tauri::command]
fn get_local_compute_status() -> local_compute::ComputeStatus {
    local_compute::manager().status()
}

/// Start (or retry) local compute setup in the background; no-op while it is already running.
#[tauri::command]
fn start_local_compute_setup(process: tauri::State<'_, AgentProcess>) -> local_compute::ComputeStatus {
    let agent = Arc::clone(&process.0);
    let manager = local_compute::manager();
    manager.start(move || restart_agent(&agent));
    manager.status()
}

/// This machine's network node id: the enrolled one, else a stable proposal for enrolling.
#[tauri::command]
fn get_network_node_id() -> Result<String, String> {
    network_enrollment::node_id()
}

/// Whether this machine is enrolled (never returns the registration token).
#[tauri::command]
fn get_network_enrollment() -> Option<NetworkEnrollmentSummary> {
    network_enrollment::load().map(|e| e.summary())
}

/// Store the portal's enrollment for this machine and restart the agent on it
/// (the monitor thread respawns the agent, which then reads the new enrollment).
#[tauri::command]
fn save_network_enrollment(
    enrollment: NetworkEnrollment,
    process: tauri::State<'_, AgentProcess>,
) -> Result<NetworkEnrollmentSummary, String> {
    enrollment.validate()?;
    network_enrollment::save(&enrollment)?;
    if let Ok(mut guard) = process.0.lock() {
        if let Some(ref mut child) = *guard {
            let _ = child.kill();
        }
    }
    Ok(enrollment.summary())
}

/// Path of the IDE provider token written by the IDE server (#4): ~/.edgecoder/ide-token.
fn ide_token_path() -> Option<PathBuf> {
    // Match Node's os.homedir(), which the IDE server uses to write the token:
    // USERPROFILE on Windows (Git Bash/MSYS often set HOME elsewhere), HOME elsewhere.
    let home = if cfg!(windows) {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
    } else {
        std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
    }?;
    Some(PathBuf::from(home).join(".edgecoder").join("ide-token"))
}

/// Read the IDE provider token so the webview can call the IDE server (127.0.0.1:4304).
/// The file is the single source of truth; the desktop never generates or logs it.
/// It is handed out only while the agent on :4301 is the one this app spawned (the provider is
/// its child), and on macOS only when every listener on :4304 is a child of that agent.
#[tauri::command]
fn get_ide_token(
    control: tauri::State<'_, AgentControl>,
    process: tauri::State<'_, AgentProcess>,
) -> Result<String, String> {
    let agent_pid = {
        // Same ownership rule as the inference token: refuse unless :4301 is our live agent.
        let alive = agent_alive(&control, &process);
        control.guard.token_for_webview("", alive)?;
        // A reused agent (#147) has no child here, so its IDE listeners can't be checked: refused.
        let slot = process.0.lock().map_err(|_| "agent state unavailable".to_string())?;
        slot.as_ref().map(|c| c.id()).ok_or_else(|| "not_started: the local agent is not running".to_string())?
    };
    if let Some(listeners) = ide_guard::ide_listeners() {
        ide_guard::listeners_owned_by(&listeners, agent_pid)?;
    }
    let path = ide_token_path().ok_or_else(|| "home directory not found".to_string())?;
    let raw = fs::read_to_string(&path)
        .map_err(|_| "IDE token not found; start the IDE provider server once to create ~/.edgecoder/ide-token".to_string())?;
    let token = raw.trim().to_string();
    if token.is_empty() {
        return Err("IDE token file is empty".to_string());
    }
    Ok(token)
}

/// Major version from `node -p process.versions.node` output ("22.23.4\n" -> 22).
fn parse_node_major(out: &str) -> Option<u32> {
    out.trim().split('.').next()?.parse().ok()
}

fn node_major(node: &PathBuf) -> Option<u32> {
    let out = Command::new(node).args(["-p", "process.versions.node"]).output().ok()?;
    parse_node_major(&String::from_utf8_lossy(&out.stdout))
}

/// Apps launched from Finder/the Dock get a bare PATH (/usr/bin:/bin:...), so a Homebrew or nvm
/// Node is invisible to `Command::new("node")` and the agent never starts. Look where Node
/// actually lives (EDGECODER_NODE wins), require >= 22, then fall back to the user's login shell.
/// The Node runtime shipped inside the bundle (scripts/bundle-agent-resources.sh), if present.
fn bundled_node(agent_dir: &PathBuf) -> Option<PathBuf> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    Some(agent_dir.join("node").join(name)).filter(|p| p.exists())
}

fn resolve_node_binary(agent_dir: &PathBuf) -> Option<PathBuf> {
    const MIN_MAJOR: u32 = 22;
    if let Ok(p) = std::env::var("EDGECODER_NODE") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    // The bundled runtime matches the native modules it was built with, so it comes first.
    if let Some(p) = bundled_node(agent_dir) {
        return Some(p);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let mut candidates: Vec<PathBuf> = [
        "/opt/homebrew/opt/node@22/bin/node",
        "/usr/local/opt/node@22/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
        r"C:\Program Files\nodejs\node.exe",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    if let Ok(entries) = std::fs::read_dir(format!("{home}/.nvm/versions/node")) {
        let mut nvm: Vec<PathBuf> = entries.flatten().map(|e| e.path().join("bin/node")).collect();
        nvm.sort();
        nvm.reverse();
        candidates.extend(nvm);
    }
    if let Some(found) = candidates
        .into_iter()
        .find(|p| p.exists() && node_major(p).is_some_and(|m| m >= MIN_MAJOR))
    {
        return Some(found);
    }
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        if let Ok(out) = Command::new(shell).args(["-lc", "command -v node"]).output() {
            let p = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
            if p.exists() && node_major(&p).is_some_and(|m| m >= MIN_MAJOR) {
                return Some(p);
            }
        }
    }
    // Last resort: whatever PATH has (fine on Windows/Linux desktops with a normal PATH).
    Some(PathBuf::from("node")).filter(|p| node_major(p).is_some_and(|m| m >= MIN_MAJOR))
}

/// PATH for the agent. A Finder launch gets /usr/bin:/bin:..., where the `docker` CLI (Homebrew,
/// Docker Desktop, OrbStack, Colima) is missing, so the agent would report Docker as down and never
/// take swarm work. Prepend the usual install locations that exist.
fn agent_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    if cfg!(windows) {
        return current;
    }
    let home = std::env::var("HOME").unwrap_or_default();
    // The app's own Docker CLI / Colima (local_compute) come after the user's installs.
    let managed = local_compute::manager().agent_path_dirs().into_iter().map(|d| d.to_string_lossy().to_string());
    let extra: Vec<String> = [
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/Applications/Docker.app/Contents/Resources/bin".to_string(),
        format!("{home}/.docker/bin"),
        format!("{home}/.orbstack/bin"),
    ]
    .into_iter()
    .chain(managed)
    .filter(|d| PathBuf::from(d).is_dir() && !current.split(':').any(|c| c == d))
    .collect();
    if extra.is_empty() {
        current
    } else if current.is_empty() {
        extra.join(":")
    } else {
        format!("{}:{current}", extra.join(":"))
    }
}

fn spawn_agent_process(agent_dir: &PathBuf, tokens: &AgentTokens) -> Option<Child> {
    persist_tokens(tokens);
    let log = agent_log();
    let Some(node) = resolve_node_binary(agent_dir) else {
        let msg = "Node.js 22+ not found (bundle, Homebrew, nvm, /usr/local, PATH, login shell); not starting the agent";
        eprintln!("{msg}");
        if let Some(mut f) = log {
            let _ = writeln!(f, "{msg}");
        }
        return None;
    };
    eprintln!("Starting agent with {:?}", node);
    let mut cmd = Command::new(node);
    // Agent output goes to ~/.edgecoder/agent.log so a failed start can be diagnosed from a
    // Finder launch, where stderr goes nowhere.
    if let Some(f) = log {
        if let Ok(err) = f.try_clone() {
            cmd.stdout(f).stderr(err);
        }
    }
    let child = cmd.arg("dist/index.js")
        .current_dir(agent_dir)
        .env("EDGE_RUNTIME_MODE", "all-in-one")
        .env("PATH", agent_path())
        // The app's local coordinator never pays out (payouts run on the network seeds), so it
        // needs no Lightning node; without this it refuses to start (mock Lightning is disabled).
        .env("ECONOMY_PAYMENTS_ENABLED", "0")
        .env("INFERENCE_AUTH_TOKEN", &tokens.inference)
        .env("ADMIN_API_TOKEN", &tokens.admin)
        // The app's own version, so the agent registers as it (src/common/app-version.ts); it reported
        // the bundled package.json's 1.0.0 before (network run 19).
        .envs(APP_VERSION.get().map(|v| ("EDGECODER_APP_VERSION", v.as_str())))
        // OLLAMA_HOST / DOCKER_HOST of the Ollama and Docker sandbox the app sets up (local_compute).
        .envs(local_compute::manager().agent_env())
        // Settings > General: BLE mesh on or off.
        .envs(agent_settings::load().agent_env())
        // Once the signed-in user has enrolled this machine, its worker joins the network
        // coordinator; read at every spawn, so saving an enrollment takes effect on restart.
        .envs(network_enrollment::load().map(|e| e.agent_env()).unwrap_or_default())
        .spawn()
        .ok();
    if child.is_some() {
        remember_agent_version();
    }
    child
}

/// Record which app version started the agent, so a later launch reuses it only when it is the
/// same version (after an update the old agent is replaced; see may_reuse_agent).
fn remember_agent_version() {
    let (Some(p), Some(v)) = (service_supervisor::agent_version_path(), APP_VERSION.get()) else { return };
    let _ = fs::write(p, v);
}

/// ~/.edgecoder/agent.log, truncated at each spawn once it passes 5 MB.
fn agent_log() -> Option<fs::File> {
    let dir = PathBuf::from(std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok()?).join(".edgecoder");
    fs::create_dir_all(&dir).ok()?;
    let path = dir.join("agent.log");
    let too_big = fs::metadata(&path).map(|m| m.len() > 5 * 1024 * 1024).unwrap_or(false);
    fs::OpenOptions::new()
        .create(true)
        .append(!too_big)
        .write(true)
        .truncate(too_big)
        .open(&path)
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

fn start_agent(app: &tauri::App, tokens: &AgentTokens, guard: &AgentGuard, reused: bool) -> (Option<Child>, Option<PathBuf>) {
    let agent_dir = resolve_agent_dir(app);
    // #147: main() already challenged the listener with the saved tokens and adopted them.
    if reused {
        guard.apply(AgentEvent::Verified);
        return (None, agent_dir);
    }
    // #72: an unverified listener never got this launch's tokens, so don't trust it. One left by
    // an earlier launch of this app is stopped and replaced; anything else is left alone.
    if port_in_use(AGENT_ADDR) && !reclaim_stale_agent(AGENT_ADDR) {
        eprintln!("Something is already listening on :4301 — not spawning, inference token withheld");
        guard.apply(AgentEvent::PortBusy);
        return (None, agent_dir);
    }
    let Some(dir) = agent_dir else {
        guard.apply(AgentEvent::SpawnFailed);
        return (None, None);
    };
    let child = spawn_agent_process(&dir, tokens);
    guard.apply(if child.is_some() { AgentEvent::SpawnOk } else { AgentEvent::SpawnFailed });
    (child, Some(dir))
}

/// Self-healing (service_supervisor.rs): every 2 s, is our agent alive and does the service answer
/// /health on :4304? A dead agent is started again on a backoff (1 s, 2 s, 5 s, 10 s, then every
/// 30 s, never giving up); a running one whose service is stuck is stopped and started again. Each
/// restart is logged to ~/.edgecoder/agent.log. Agents started by Retry / "Restart now" are watched
/// too.
fn monitor_agent(
    agent_mutex: Arc<Mutex<Option<Child>>>,
    agent_dir: PathBuf,
    tokens: AgentTokens,
    agent_guard: Arc<AgentGuard>,
    supervisor: Arc<Mutex<Supervisor>>,
) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(2));
        let alive = monitored_agent_alive(&agent_mutex, &agent_guard);
        let healthy = alive && service_supervisor::service_healthy();
        let action = match supervisor.lock() {
            Ok(mut s) => s.observe(Instant::now(), alive, healthy),
            Err(_) => continue,
        };
        match action {
            ServiceAction::Wait => {}
            ServiceAction::Stop => {
                log_service(&format!(
                    "EdgeCoder's local service hasn't answered on :4304 for {} s; restarting it",
                    service_supervisor::UNHEALTHY_LIMIT.as_secs()
                ));
                stop_service(&agent_mutex, &agent_guard);
                if let Ok(mut s) = supervisor.lock() {
                    s.stopped(Instant::now());
                }
            }
            ServiceAction::Start => {
                let attempt = supervisor.lock().map(|s| s.attempts() + 1).unwrap_or(1);
                log_service(&format!("EdgeCoder's local service isn't running; starting it again (restart {attempt})"));
                let ok = start_service(&agent_mutex, Some(&agent_dir), &tokens, &agent_guard);
                if !ok {
                    let next = service_supervisor::backoff(attempt).as_secs();
                    log_service(&format!("EdgeCoder's local service didn't start (restart {attempt}); next try in {next} s"));
                }
                if let Ok(mut s) = supervisor.lock() {
                    s.restarted(Instant::now(), ok);
                }
            }
        }
    });
}

/// Whether our agent process is there: the child we spawned is running, or (#147) the reused one
/// still holds the port. An exit is logged and revokes the tokens (#72) until it is back.
fn monitored_agent_alive(agent: &Arc<Mutex<Option<Child>>>, guard: &AgentGuard) -> bool {
    let Ok(mut slot) = agent.lock() else { return false };
    match slot.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(None) => true,
            Ok(Some(status)) => {
                log_service(&format!("EdgeCoder's local service exited ({status})"));
                *slot = None;
                guard.apply(AgentEvent::Exited);
                false
            }
            Err(e) => {
                eprintln!("Error checking agent process: {e}");
                guard.apply(AgentEvent::Exited);
                false
            }
        },
        None => guard.get() == AgentOwnership::Verified && port_in_use(AGENT_ADDR),
    }
}

fn main() {
    // #6: per-launch tokens from the OS CSPRNG (never logged). The webview only
    // receives the inference token via get_local_token; the admin token stays
    // with the spawned agent process.
    // #147: if :4301 is taken, reuse it only when it proves (fresh nonce, HMAC with the admin
    // token) that it is the agent an earlier launch started with the saved tokens.
    // After an update the agent left by the old version is never reused: the new version starts
    // its own (start_agent stops the old one), so the service runs the new code.
    // Network run 12: no App Nap while the app (and the agent it runs) hosts; idle sleep still allowed.
    if !app_nap::keep_app_awake_for_hosting() && cfg!(target_os = "macos") {
        eprintln!("Couldn't declare the hosting activity; macOS may nap the app in the background");
    }
    let mut context = tauri::generate_context!();
    let app_version = context.package_info().version.to_string();
    let _ = APP_VERSION.set(app_version.clone());
    let same_version = service_supervisor::may_reuse_agent(
        service_supervisor::agent_version_path().and_then(|p| fs::read_to_string(p).ok()).as_deref(),
        &app_version,
    );
    let reused_tokens = if port_in_use(AGENT_ADDR) && same_version {
        agent_attest::tokens_path()
            .and_then(|p| agent_attest::load_tokens(&p))
            .map(|t| AgentTokens { inference: t.inference, admin: t.admin })
            .filter(verify_existing_agent)
    } else {
        None
    };
    let reused = reused_tokens.is_some();
    let tokens = reused_tokens.unwrap_or_else(|| AgentTokens {
        inference: generate_local_token(),
        admin: generate_local_token(),
    });
    let local_token = tokens.inference.clone();

    // #138: hosts changed in Settings after the build get their exact origins added to the
    // release CSP connect-src (Tauri applies the CSP from this runtime config).
    let saved_hosts = remote_hosts::load();
    remote_hosts::apply_to_config(context.config_mut(), &saved_hosts);
    let applied_hosts = remote_hosts::AppliedHosts(remote_hosts::connect_src_sources(context.config()));

    tauri::Builder::default()
        // Must be registered first. On Windows and Linux an edgecoder:// link (the OAuth callback)
        // starts a second process: the deep-link feature hands the URL to the running app's
        // on_open_url and this callback focuses its window, so a second app never opens.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // Model output in chat must never replace the app with a remote page.
        .plugin(navigation::guard())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(LocalToken(local_token.clone()))
        .manage(applied_hosts)
        .manage(terminal::Terminals::default())
        .invoke_handler(tauri::generate_handler![
            terminal::term_spawn,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_kill,
            get_system_metrics,
            get_local_token,
            get_agent_status,
            retry_local_agent,
            get_network_node_id,
            get_network_enrollment,
            save_network_enrollment,
            get_local_compute_status,
            get_agent_settings,
            set_agent_ble,
            set_agent_code_relay,
            start_local_compute_setup,
            get_ide_token,
            set_remote_hosts,
            restart_local_service,
            stop_local_service_for_update,
            read_service_log,
        ])
        .setup(move |app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

            // Decide (fast probes) where Ollama and Docker will be before the agent spawns, so it
            // starts with the right OLLAMA_HOST / DOCKER_HOST; downloads and starts run after.
            let compute = local_compute::manager();
            compute.prepare();

            let agent_guard = Arc::new(AgentGuard::new());
            let (child, agent_dir) = start_agent(app, &tokens, &agent_guard, reused);
            let supervisor = Arc::new(Mutex::new(Supervisor::new()));
            if let Ok(mut s) = supervisor.lock() {
                s.launched(Instant::now(), child.is_some() || reused);
            }
            let agent_mutex = Arc::new(Mutex::new(child));

            let agent_for_compute = Arc::clone(&agent_mutex);
            compute.start(move || restart_agent(&agent_for_compute));
            thread::spawn(move || loop {
                thread::sleep(Duration::from_secs(10));
                compute.watchdog();
            });
            app.manage(AgentProcess(Arc::clone(&agent_mutex)));
            app.manage(ServiceSupervisor(Arc::clone(&supervisor)));
            app.manage(AgentControl {
                guard: Arc::clone(&agent_guard),
                agent_dir: agent_dir.clone(),
                tokens: tokens.clone(),
            });

            if let Some(dir) = agent_dir {
                monitor_agent(Arc::clone(&agent_mutex), dir, tokens.clone(), Arc::clone(&agent_guard), supervisor);
            }

            // Listen for deep link events (edgecoder://oauth-callback?...)
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls = event.urls();
                if let Some(url) = urls.first() {
                    // Only the OAuth callback shape is passed on; the URL (it carries a one-time
                    // token) is never logged.
                    if !is_oauth_callback(url) {
                        eprintln!("[deep-link] ignored a link that is not an oauth callback");
                        return;
                    }
                    eprintln!("[deep-link] oauth callback received");
                    let url_str = url.to_string();
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
        .build(context)
        .expect("error building EdgeCoder desktop app")
        .run(|app, event| {
            // Quit and the updater's relaunch end the app without destroying its window, which
            // left the agent running and holding the port for the next launch.
            if let tauri::RunEvent::Exit = event {
                if let Some(terms) = app.try_state::<terminal::Terminals>() {
                    terminal::kill_all(&terms);
                }
                // Our `ollama serve`, and the Colima VM if this launch booted it.
                local_compute::manager().shutdown();
                if let Some(state) = app.try_state::<AgentProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(ref mut child) = *guard {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        });
}

/// Query keys the portal puts on the OAuth callback (src/portal/routes/auth.ts).
const OAUTH_CALLBACK_KEYS: [&str; 5] = ["status", "provider", "mobile_token", "error", "state"];

/// True only for `edgecoder://oauth-callback[/]?<known keys>`: the scheme, host and path the app
/// registered, no fragment, no credentials, and each expected key at most once.
fn is_oauth_callback(url: &tauri::Url) -> bool {
    if url.scheme() != "edgecoder" || url.host_str() != Some("oauth-callback") {
        return false;
    }
    if !(url.path().is_empty() || url.path() == "/") || url.fragment().is_some() {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return false;
    }
    let mut seen: Vec<String> = Vec::new();
    for (k, v) in url.query_pairs() {
        if !OAUTH_CALLBACK_KEYS.contains(&k.as_ref()) || seen.iter().any(|s| s == k.as_ref()) || v.len() > 512 {
            return false;
        }
        seen.push(k.into_owned());
    }
    true
}

#[cfg(test)]
mod deep_link_tests {
    use super::is_oauth_callback;

    fn ok(s: &str) -> bool {
        is_oauth_callback(&tauri::Url::parse(s).unwrap())
    }

    #[test]
    fn accepts_the_oauth_callback() {
        assert!(ok("edgecoder://oauth-callback?status=ok&provider=google&mobile_token=abc123"));
        assert!(ok("edgecoder://oauth-callback/?status=error&provider=github&error=oauth_state_invalid"));
        assert!(ok("edgecoder://oauth-callback"));
    }

    #[test]
    fn rejects_other_shapes() {
        assert!(!ok("https://oauth-callback/?status=ok"));
        assert!(!ok("edgecoder://other?status=ok"));
        assert!(!ok("edgecoder://oauth-callback/extra?status=ok"));
        assert!(!ok("edgecoder://oauth-callback?status=ok#frag"));
        assert!(!ok("edgecoder://oauth-callback?status=ok&redirect=https://evil.example"));
        assert!(!ok("edgecoder://oauth-callback?mobile_token=a&mobile_token=b"));
        assert!(!ok("edgecoder://user:pw@oauth-callback?status=ok"));
        assert!(!ok("edgecoder://oauth-callback:8080?status=ok"));
    }
}

#[cfg(test)]
mod node_resolution_tests {
    #[test]
    fn disk_is_the_mount_holding_home_not_the_sum_of_volumes() {
        let mounts = vec![
            ("/".to_string(), 994_000_000_000, 167_000_000_000),
            ("/System/Volumes/Data".to_string(), 994_000_000_000, 167_000_000_000),
            ("/Volumes/USB".to_string(), 64_000_000_000, 10_000_000_000),
        ];
        assert_eq!(super::disk_for_path(&mounts, "/Users/me"), Some((994_000_000_000, 167_000_000_000)));
        assert_eq!(super::disk_for_path(&mounts, "/Volumes/USB/x"), Some((64_000_000_000, 10_000_000_000)));
        assert_eq!(super::disk_for_path(&mounts, "/Volumes/USBX"), Some((994_000_000_000, 167_000_000_000)));
    }

    use super::parse_node_major;

    #[test]
    fn parses_node_major_versions() {
        assert_eq!(parse_node_major("22.23.4\n"), Some(22));
        assert_eq!(parse_node_major("v22.1.0"), None); // `-p process.versions.node` never prints a v
        assert_eq!(parse_node_major("20.18.0"), Some(20));
        assert_eq!(parse_node_major(""), None);
    }
}
