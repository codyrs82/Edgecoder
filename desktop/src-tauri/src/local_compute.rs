// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

//! Managed local compute: the app sets up Ollama (local models) and a Docker sandbox (Colima)
//! itself on first run, so a new Mac user never opens a terminal.
//!
//! - Reuses what is already there when it is good enough: an Ollama answering on :11434 that is
//!   at least `MIN_OLLAMA_VERSION`, an `ollama` binary that new, or any live Docker socket
//!   (Colima, Docker Desktop, OrbStack, /var/run/docker.sock).
//! - Otherwise (macOS) downloads pinned official release binaries into
//!   `~/Library/Application Support/EdgeCoder/{ollama,lima,bin}`, checks the size and SHA-256
//!   pinned below, then runs `ollama serve` as a child of the app and `colima start` (default
//!   profile, so DOCKER_HOST is `unix://~/.colima/default/docker.sock`).
//! - The agent gets OLLAMA_HOST / DOCKER_HOST / PATH from `AgentCompute::env`. Both hosts are
//!   decided by a fast probe before the agent is spawned (`prepare`), so the agent normally does
//!   not need a restart when the slower downloads and starts finish.
//!
//! Linux and Windows: nothing is downloaded. A running or installed Ollama is used (and started
//! if installed but not running); otherwise the UI points at ollama.com. Docker is reported but
//! never blocks there.
//!
//! std + serde + sha2 + hex only, so it is unit-tested standalone in CI like agent_guard.rs.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------------------------
// Pinned versions
// ---------------------------------------------------------------------------------------------

/// Older Ollama servers refuse current models ("requires a newer version of Ollama").
pub const MIN_OLLAMA_VERSION: Version = Version(0, 40, 0);
pub const OLLAMA_PORT: u16 = 11434;
/// Where the managed Ollama listens when an older Ollama already holds :11434.
pub const OLLAMA_FALLBACK_PORT: u16 = 11435;
/// Colima's default profile: matches a Homebrew `colima start`, so the user's own `docker` works too.
pub const COLIMA_PROFILE: &str = "default";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Arch {
    Arm64,
    X86_64,
}

pub fn host_arch() -> Option<Arch> {
    if cfg!(target_arch = "aarch64") {
        Some(Arch::Arm64)
    } else if cfg!(target_arch = "x86_64") {
        Some(Arch::X86_64)
    } else {
        None
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unpack {
    /// Extract a .tgz into `<root>/<dir>`, replacing what was there.
    TarGzDir(&'static str),
    /// Extract one member of a .tgz to `<root>/<path>`.
    TarGzMember { member: &'static str, to: &'static str },
    /// The download is the executable itself; install it at `<root>/<path>`.
    Binary(&'static str),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Artifact {
    pub name: &'static str,
    pub version: &'static str,
    pub url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
    pub unpack: Unpack,
}

// Checksums: Ollama, Colima and Lima from each release's published checksum file
// (sha256sum.txt, colima-Darwin-*.sha256sum, SHA256SUMS), cross-checked against the GitHub
// release asset digests. Docker publishes no checksums for its static CLI builds, so those two
// are the SHA-256 of the files downloaded from download.docker.com when this was pinned.

/// Universal (arm64 + x86_64) CLI/server with its dylibs, flat in the archive.
pub const OLLAMA: Artifact = Artifact {
    name: "ollama",
    version: "0.40.13",
    url: "https://github.com/ollama/ollama/releases/download/v0.40.13/ollama-darwin.tgz",
    size: 186_689_993,
    sha256: "bae29252232b9e1358cf5801a7d65a07442af18fb5467cb68c7fc3711f59c511",
    unpack: Unpack::TarGzDir("ollama"),
};

pub const COLIMA_ARM64: Artifact = Artifact {
    name: "colima",
    version: "0.10.3",
    url: "https://github.com/abiosoft/colima/releases/download/v0.10.3/colima-Darwin-arm64",
    size: 15_656_320,
    sha256: "980ad8bf61a4ca370243f4cb41401a61276dcd2c2502bee7b9b86f9250169f34",
    unpack: Unpack::Binary("bin/colima"),
};

pub const COLIMA_X86_64: Artifact = Artifact {
    name: "colima",
    version: "0.10.3",
    url: "https://github.com/abiosoft/colima/releases/download/v0.10.3/colima-Darwin-x86_64",
    size: 16_954_240,
    sha256: "3082737fe8a98afda11cba7d9a20b6e56fe80c6153464beda04bec630758770b",
    unpack: Unpack::Binary("bin/colima"),
};

/// Lima's archive has bin/ (limactl, signed with the virtualization entitlement), share/lima
/// (guest agents) and libexec/; limactl finds share/ relative to itself.
pub const LIMA_ARM64: Artifact = Artifact {
    name: "lima",
    version: "2.2.1",
    url: "https://github.com/lima-vm/lima/releases/download/v2.2.1/lima-2.2.1-Darwin-arm64.tar.gz",
    size: 38_328_082,
    sha256: "9e9eacce88f37e185c346bad73aa6136f738d8cdf8c3bb23cd42b071824bc66e",
    unpack: Unpack::TarGzDir("lima"),
};

pub const LIMA_X86_64: Artifact = Artifact {
    name: "lima",
    version: "2.2.1",
    url: "https://github.com/lima-vm/lima/releases/download/v2.2.1/lima-2.2.1-Darwin-x86_64.tar.gz",
    size: 24_958_659,
    sha256: "6b776e4bc41f358e6ee01fefcc78e2eb26f11635a0fcff632234af77a566c6c4",
    unpack: Unpack::TarGzDir("lima"),
};

pub const DOCKER_CLI_ARM64: Artifact = Artifact {
    name: "docker",
    version: "29.9.2",
    url: "https://download.docker.com/mac/static/stable/aarch64/docker-29.9.2.tgz",
    size: 19_654_797,
    sha256: "ea8a2ce5ac31f9f5f3fb711a7a485e1e46cc7a69798a629a70306f6e6af25b7a",
    unpack: Unpack::TarGzMember { member: "docker/docker", to: "bin/docker" },
};

pub const DOCKER_CLI_X86_64: Artifact = Artifact {
    name: "docker",
    version: "29.9.2",
    url: "https://download.docker.com/mac/static/stable/x86_64/docker-29.9.2.tgz",
    size: 20_929_717,
    sha256: "089c3f618df88bdef4f1257d9d604499136a1ec5168b67d194c260acad2b522f",
    unpack: Unpack::TarGzMember { member: "docker/docker", to: "bin/docker" },
};

pub fn colima_artifact(arch: Arch) -> Artifact {
    match arch {
        Arch::Arm64 => COLIMA_ARM64,
        Arch::X86_64 => COLIMA_X86_64,
    }
}

pub fn lima_artifact(arch: Arch) -> Artifact {
    match arch {
        Arch::Arm64 => LIMA_ARM64,
        Arch::X86_64 => LIMA_X86_64,
    }
}

pub fn docker_cli_artifact(arch: Arch) -> Artifact {
    match arch {
        Arch::Arm64 => DOCKER_CLI_ARM64,
        Arch::X86_64 => DOCKER_CLI_X86_64,
    }
}

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version(pub u32, pub u32, pub u32);

impl Version {
    /// "0.40.13", "v0.40.13", "0.40.13-rc1", "0.40" (patch 0). None for anything else.
    pub fn parse(s: &str) -> Option<Version> {
        let s = s.trim().trim_start_matches('v');
        let core = s.split(|c: char| c == '-' || c == '+' || c.is_whitespace()).next()?;
        let mut parts = core.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = match parts.next() {
            Some(p) => p.parse().ok()?,
            None => 0,
        };
        if parts.next().is_some() {
            return None;
        }
        Some(Version(major, minor, patch))
    }

    pub fn meets_minimum(self) -> bool {
        self >= MIN_OLLAMA_VERSION
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.0, self.1, self.2)
    }
}

/// Version of the binary from `ollama --version`. With a server running it prints the *server's*
/// version first ("ollama version is 0.40.7" + "Warning: client version is 0.40.13"), so the
/// client line wins when present.
pub fn parse_ollama_cli_version(out: &str) -> Option<Version> {
    for marker in ["client version is ", "ollama version is "] {
        if let Some(i) = out.find(marker) {
            let rest = &out[i + marker.len()..];
            if let Some(v) = Version::parse(rest.lines().next().unwrap_or("")) {
                return Some(v);
            }
        }
    }
    None
}

/// `{"version":"0.40.13"}` from GET /api/version.
pub fn parse_ollama_api_version(body: &str) -> Option<Version> {
    let v: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
    Version::parse(v.get("version")?.as_str()?)
}

// ---------------------------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------------------------

pub fn sha256_file(path: &Path) -> io::Result<String> {
    let mut f = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Size first (cheap, and catches a truncated download with a clearer message), then SHA-256.
pub fn verify_file(path: &Path, size: u64, sha256: &str) -> Result<(), String> {
    let actual_size = fs::metadata(path).map_err(|e| format!("cannot read the download: {e}"))?.len();
    if actual_size != size {
        return Err(format!("download is {actual_size} bytes, expected {size}"));
    }
    let actual = sha256_file(path).map_err(|e| format!("cannot read the download: {e}"))?;
    if !actual.eq_ignore_ascii_case(sha256) {
        return Err(format!("checksum mismatch: expected {sha256}, got {actual}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/// Where managed binaries live. EDGECODER_RUNTIME_DIR overrides (tests, unusual setups).
pub fn runtime_root(override_dir: Option<&str>, home: &str, os: &str, local_app_data: Option<&str>) -> Option<PathBuf> {
    if let Some(d) = override_dir.map(str::trim).filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(d));
    }
    match os {
        "macos" if !home.is_empty() => Some(Path::new(home).join("Library/Application Support/EdgeCoder")),
        "windows" => local_app_data.filter(|d| !d.is_empty()).map(|d| Path::new(d).join("EdgeCoder")),
        _ if !home.is_empty() => Some(Path::new(home).join(".local/share/edgecoder")),
        _ => None,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Layout {
    pub root: PathBuf,
}

impl Layout {
    pub fn bin_dir(&self) -> PathBuf {
        self.root.join("bin")
    }
    pub fn ollama_dir(&self) -> PathBuf {
        self.root.join("ollama")
    }
    pub fn ollama_bin(&self) -> PathBuf {
        self.ollama_dir().join("ollama")
    }
    pub fn lima_bin_dir(&self) -> PathBuf {
        self.root.join("lima").join("bin")
    }
    pub fn colima_bin(&self) -> PathBuf {
        self.bin_dir().join("colima")
    }
    pub fn downloads_dir(&self) -> PathBuf {
        self.root.join("downloads")
    }
    fn marker(&self, a: &Artifact) -> PathBuf {
        self.root.join(".installed").join(a.name)
    }
    /// The file whose presence (with a matching marker) means `a` is installed.
    pub fn installed_path(&self, a: &Artifact) -> PathBuf {
        match a.unpack {
            Unpack::TarGzDir("ollama") => self.ollama_bin(),
            Unpack::TarGzDir("lima") => self.lima_bin_dir().join("limactl"),
            Unpack::TarGzDir(dir) => self.root.join(dir),
            Unpack::TarGzMember { to, .. } | Unpack::Binary(to) => self.root.join(to),
        }
    }
    /// Installed at exactly the pinned checksum (a re-pin triggers a fresh download).
    pub fn is_installed(&self, a: &Artifact) -> bool {
        self.installed_path(a).exists()
            && fs::read_to_string(self.marker(a)).map(|m| m.trim() == a.sha256).unwrap_or(false)
    }
    /// Directories the agent and colima need on PATH, managed ones only, in priority order.
    pub fn path_dirs(&self) -> Vec<PathBuf> {
        vec![self.bin_dir(), self.lima_bin_dir(), self.ollama_dir()]
    }
}

/// PATH with `extra` dirs prepended (skipping duplicates); `existing_dirs` filters to real dirs.
pub fn compose_path(current: &str, extra: &[PathBuf], sep: char) -> String {
    let mut parts: Vec<String> = Vec::new();
    for d in extra {
        let s = d.to_string_lossy().to_string();
        if !s.is_empty() && !parts.contains(&s) {
            parts.push(s);
        }
    }
    for c in current.split(sep).filter(|c| !c.is_empty()) {
        if !parts.iter().any(|p| p == c) {
            parts.push(c.to_string());
        }
    }
    parts.join(&sep.to_string())
}

/// Places a user's own `ollama` lives, best first.
pub fn ollama_binary_candidates(home: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = [
        "/opt/homebrew/bin/ollama",
        "/usr/local/bin/ollama",
        "/Applications/Ollama.app/Contents/Resources/ollama",
        "/usr/bin/ollama",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    if !home.is_empty() {
        v.push(Path::new(home).join("Applications/Ollama.app/Contents/Resources/ollama"));
        v.push(Path::new(home).join(".local/bin/ollama"));
    }
    v
}

pub fn colima_binary_candidates() -> Vec<PathBuf> {
    ["/opt/homebrew/bin/colima", "/usr/local/bin/colima"].iter().map(PathBuf::from).collect()
}

pub fn docker_cli_candidates(home: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = [
        "/opt/homebrew/bin/docker",
        "/usr/local/bin/docker",
        "/usr/bin/docker",
        "/Applications/Docker.app/Contents/Resources/bin/docker",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    if !home.is_empty() {
        v.push(Path::new(home).join(".docker/bin/docker"));
        v.push(Path::new(home).join(".orbstack/bin/docker"));
    }
    v
}

/// The Colima profile's socket (what DOCKER_HOST points at once we start Colima).
pub fn colima_socket(home: &str) -> PathBuf {
    Path::new(home).join(".colima").join(COLIMA_PROFILE).join("docker.sock")
}

/// Docker sockets to try, best first: DOCKER_HOST (unix:// only), Colima, Docker Desktop,
/// OrbStack, the system socket.
pub fn docker_socket_candidates(home: &str, docker_host: Option<&str>) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(p) = docker_host.and_then(|h| h.trim().strip_prefix("unix://")).filter(|p| !p.is_empty()) {
        v.push(PathBuf::from(p));
    }
    if !home.is_empty() {
        v.push(colima_socket(home));
        v.push(Path::new(home).join(".docker/run/docker.sock"));
        v.push(Path::new(home).join(".orbstack/run/docker.sock"));
    }
    v.push(PathBuf::from("/var/run/docker.sock"));
    v
}

// ---------------------------------------------------------------------------------------------
// Probes (raw HTTP so no client crate is needed)
// ---------------------------------------------------------------------------------------------

/// Status code and body of an HTTP/1.x response (no chunked decoding: we send HTTP/1.0).
pub fn parse_http_response(raw: &str) -> Option<(u16, String)> {
    let mut lines = raw.splitn(2, "\r\n");
    let status_line = lines.next()?;
    let mut it = status_line.split_whitespace();
    if !it.next()?.starts_with("HTTP/") {
        return None;
    }
    let code = it.next()?.parse().ok()?;
    let body = raw.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
    Some((code, body))
}

fn http_exchange<S: Read + Write>(mut s: S, path: &str) -> Option<(u16, String)> {
    let req = format!("GET {path} HTTP/1.0\r\nHost: localhost\r\nUser-Agent: edgecoder-desktop\r\n\r\n");
    s.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    let _ = s.take(256 * 1024).read_to_end(&mut buf);
    parse_http_response(&String::from_utf8_lossy(&buf))
}

pub fn http_get(port: u16, path: &str, timeout: Duration) -> Option<(u16, String)> {
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().ok()?;
    let s = TcpStream::connect_timeout(&addr, timeout).ok()?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    http_exchange(s, path)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OllamaProbe {
    /// Nothing answers on the port.
    Absent,
    /// Something answers; its version if /api/version made sense.
    Running(Option<Version>),
}

pub fn probe_ollama(port: u16) -> OllamaProbe {
    let timeout = Duration::from_millis(800);
    match http_get(port, "/api/version", timeout) {
        Some((200, body)) => OllamaProbe::Running(parse_ollama_api_version(&body)),
        Some(_) => OllamaProbe::Running(None),
        None => {
            // Port taken by something that isn't speaking HTTP still means "can't use this port".
            let addr: SocketAddr = format!("127.0.0.1:{port}").parse().expect("loopback addr");
            if TcpStream::connect_timeout(&addr, timeout).is_ok() {
                OllamaProbe::Running(None)
            } else {
                OllamaProbe::Absent
            }
        }
    }
}

#[cfg(unix)]
pub fn docker_ping(sock: &Path) -> bool {
    use std::os::unix::net::UnixStream;
    let timeout = Duration::from_millis(1500);
    let Ok(s) = UnixStream::connect(sock) else { return false };
    if s.set_read_timeout(Some(timeout)).is_err() || s.set_write_timeout(Some(timeout)).is_err() {
        return false;
    }
    matches!(http_exchange(s, "/_ping"), Some((200, _)))
}

#[cfg(not(unix))]
pub fn docker_ping(_sock: &Path) -> bool {
    false
}

pub fn first_live_socket(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| p.exists() && docker_ping(p)).cloned()
}

fn binary_ollama_version(bin: &Path) -> Option<Version> {
    // Point the CLI at a closed port so it reports its own version without asking a server.
    let out = Command::new(bin)
        .arg("--version")
        .env("OLLAMA_HOST", "127.0.0.1:9")
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let text = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    parse_ollama_cli_version(&text)
}

// ---------------------------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OllamaAction {
    /// A new-enough server already answers on `port`.
    UseRunning(Version),
    /// Start `ollama serve` from this (new-enough) binary.
    Start(PathBuf),
    /// Download the pinned build, then start it.
    InstallAndStart,
    /// Nothing usable and this platform has no managed download.
    Missing,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OllamaPlan {
    pub port: u16,
    pub action: OllamaAction,
    /// An older Ollama holds :11434 (shown to the user, and why we moved to the fallback port).
    pub outdated_running: Option<Option<Version>>,
}

/// Decide where Ollama runs and what to do about it.
/// `user_bin`: the best user-installed binary that meets the minimum; `managed_ok`: whether
/// this platform can download the pinned build.
pub fn plan_ollama(on_default: OllamaProbe, on_fallback: OllamaProbe, user_bin: Option<PathBuf>, managed_ok: bool) -> OllamaPlan {
    let start_or_install = |port: u16, outdated| OllamaPlan {
        port,
        action: match (&user_bin, managed_ok) {
            (Some(b), _) => OllamaAction::Start(b.clone()),
            (None, true) => OllamaAction::InstallAndStart,
            (None, false) => OllamaAction::Missing,
        },
        outdated_running: outdated,
    };
    match on_default {
        OllamaProbe::Running(Some(v)) if v.meets_minimum() => OllamaPlan { port: OLLAMA_PORT, action: OllamaAction::UseRunning(v), outdated_running: None },
        OllamaProbe::Absent => start_or_install(OLLAMA_PORT, None),
        OllamaProbe::Running(old) => match on_fallback {
            OllamaProbe::Running(Some(v)) if v.meets_minimum() => {
                OllamaPlan { port: OLLAMA_FALLBACK_PORT, action: OllamaAction::UseRunning(v), outdated_running: Some(old) }
            }
            _ => start_or_install(OLLAMA_FALLBACK_PORT, Some(old)),
        },
    }
}

/// `colima start` arguments. A new profile gets a VM sized for this machine (vz + virtiofs, so
/// no QEMU is needed); an existing profile keeps whatever the user configured.
pub fn colima_start_args(profile_exists: bool, cpus: usize, mem_bytes: u64, macos_major: Option<u32>) -> Result<Vec<String>, String> {
    let mut args = vec!["start".to_string(), "--profile".to_string(), COLIMA_PROFILE.to_string()];
    if profile_exists {
        return Ok(args);
    }
    if macos_major.is_some_and(|m| m < 13) {
        return Err("The Docker sandbox needs macOS 13 (Ventura) or newer.".to_string());
    }
    let cpu = (cpus / 2).clamp(2, 4);
    let mem_gb = (mem_bytes / (1 << 30) / 4).clamp(2, 8);
    args.extend(
        [
            "--runtime", "docker",
            "--vm-type", "vz",
            "--mount-type", "virtiofs",
            "--cpu", &cpu.to_string(),
            "--memory", &mem_gb.to_string(),
            "--disk", "60",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    Ok(args)
}

/// What the agent is told about local compute.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentCompute {
    pub ollama_host: Option<String>,
    pub docker_host: Option<String>,
    /// Managed dirs to prepend to the agent's PATH (only ones that exist are useful).
    pub path_dirs: Vec<PathBuf>,
    /// LOCAL_MODEL_PROVIDER when we will make sure Ollama is up: the agent decides its worker's
    /// provider once at boot, and Ollama may still be starting then.
    pub model_provider: Option<&'static str>,
}

impl AgentCompute {
    /// Env vars for the agent. Values the user set in the app's own environment win.
    pub fn env(&self, user_env: impl Fn(&str) -> Option<String>) -> Vec<(String, String)> {
        let mut out = Vec::new();
        let mut put = |k: &str, v: &Option<String>| {
            if let Some(v) = v {
                if user_env(k).filter(|u| !u.trim().is_empty()).is_none() {
                    out.push((k.to_string(), v.clone()));
                }
            }
        };
        put("OLLAMA_HOST", &self.ollama_host);
        put("DOCKER_HOST", &self.docker_host);
        put("LOCAL_MODEL_PROVIDER", &self.model_provider.map(str::to_string));
        out
    }
}

pub fn ollama_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

// ---------------------------------------------------------------------------------------------
// Status shown in the UI
// ---------------------------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct ComponentStatus {
    /// pending | checking | downloading | installing | starting | ready | error | skipped
    pub state: String,
    /// existing (the user's own install) | managed (installed by the app) | "" (not yet known)
    pub source: String,
    pub version: String,
    pub detail: String,
    /// Latest line of output from a long step (Colima's VM boot), for a sense of progress.
    pub activity: String,
    pub downloaded: u64,
    pub total: u64,
    pub error: Option<String>,
    /// Whether this component failing keeps the setup screen up (Docker doesn't, off macOS).
    pub required: bool,
}

impl ComponentStatus {
    fn pending(required: bool) -> Self {
        ComponentStatus { state: "pending".into(), required, ..Default::default() }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ComputeStatus {
    /// Whether this platform gets managed downloads (macOS).
    pub managed: bool,
    /// idle | running | ready | error
    pub state: String,
    pub ollama: ComponentStatus,
    pub docker: ComponentStatus,
    pub ollama_url: String,
    pub docker_host: Option<String>,
}

/// Overall state from the two components.
pub fn overall_state(running: bool, ollama: &ComponentStatus, docker: &ComponentStatus) -> &'static str {
    let ok = |c: &ComponentStatus| c.state == "ready" || (!c.required && (c.state == "error" || c.state == "skipped"));
    if ok(ollama) && ok(docker) {
        "ready"
    } else if running {
        "running"
    } else if [ollama, docker].iter().any(|c| c.state == "error") {
        "error"
    } else {
        "idle"
    }
}

// ---------------------------------------------------------------------------------------------
// Manager (global state, side effects)
// ---------------------------------------------------------------------------------------------

/// A change to one component's status (owned, so progress callbacks can hand it over freely).
type Update = Box<dyn FnOnce(&mut ComponentStatus)>;

struct Inner {
    ollama: ComponentStatus,
    docker: ComponentStatus,
    compute: AgentCompute,
    /// Env the current agent was spawned with, to know whether setup changed anything.
    spawned_env: Option<(Vec<(String, String)>, Vec<PathBuf>)>,
    ollama_child: Option<Child>,
    /// Colima binary + PATH if we started the VM (so quitting the app stops it again).
    started_colima: Option<(PathBuf, String)>,
}

pub struct Manager {
    inner: Mutex<Inner>,
    running: AtomicBool,
    layout: Option<Layout>,
    home: String,
    managed: bool,
}

static MANAGER: OnceLock<Manager> = OnceLock::new();

fn home_dir() -> String {
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default()
}

fn os_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

fn env_flag_off(name: &str) -> bool {
    matches!(std::env::var(name).ok().as_deref().map(str::trim), Some("0" | "false" | "no" | "off"))
}

pub fn manager() -> &'static Manager {
    MANAGER.get_or_init(|| {
        let home = home_dir();
        let layout = runtime_root(
            std::env::var("EDGECODER_RUNTIME_DIR").ok().as_deref(),
            &home,
            os_name(),
            std::env::var("LOCALAPPDATA").ok().as_deref(),
        )
        .map(|root| Layout { root });
        // EDGECODER_MANAGED_COMPUTE=0: detect and use what's installed, never download.
        let managed = cfg!(target_os = "macos") && host_arch().is_some() && layout.is_some() && !env_flag_off("EDGECODER_MANAGED_COMPUTE");
        Manager {
            inner: Mutex::new(Inner {
                ollama: ComponentStatus::pending(true),
                docker: ComponentStatus::pending(managed),
                compute: AgentCompute::default(),
                spawned_env: None,
                ollama_child: None,
                started_colima: None,
            }),
            running: AtomicBool::new(false),
            layout,
            home,
            managed,
        }
    })
}

fn log_file(name: &str) -> Option<fs::File> {
    let dir = Path::new(&home_dir()).join(".edgecoder");
    fs::create_dir_all(&dir).ok()?;
    fs::OpenOptions::new().create(true).append(true).open(dir.join(name)).ok()
}

fn log_line(msg: &str) {
    eprintln!("[local-compute] {msg}");
    if let Some(mut f) = log_file("local-compute.log") {
        let _ = writeln!(f, "{msg}");
    }
}

/// Last meaningful line of a log, for an error message the user can act on.
pub fn last_log_line(text: &str) -> Option<String> {
    text.lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| {
            // colima/logrus lines: time="..." level=fatal msg="..." -> just the msg
            match l.find("msg=\"") {
                Some(i) => l[i + 5..].trim_end_matches('"').replace("\\\"", "\""),
                None => l.to_string(),
            }
        })
}

impl Manager {
    fn with<R>(&self, f: impl FnOnce(&mut Inner) -> R) -> R {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        f(&mut g)
    }

    fn set_ollama(&self, f: impl FnOnce(&mut ComponentStatus)) {
        self.with(|i| f(&mut i.ollama));
    }

    fn set_docker(&self, f: impl FnOnce(&mut ComponentStatus)) {
        self.with(|i| f(&mut i.docker));
    }

    pub fn status(&self) -> ComputeStatus {
        let running = self.running.load(Ordering::SeqCst);
        self.with(|i| ComputeStatus {
            managed: self.managed,
            state: overall_state(running, &i.ollama, &i.docker).to_string(),
            ollama: i.ollama.clone(),
            docker: i.docker.clone(),
            ollama_url: i.compute.ollama_host.clone().unwrap_or_else(|| ollama_url(OLLAMA_PORT)),
            docker_host: i.compute.docker_host.clone(),
        })
    }

    fn best_user_ollama(&self) -> Option<(PathBuf, Version)> {
        ollama_binary_candidates(&self.home)
            .into_iter()
            .filter(|p| p.exists())
            .filter_map(|p| binary_ollama_version(&p).map(|v| (p, v)))
            .filter(|(_, v)| v.meets_minimum())
            .max_by_key(|(_, v)| *v)
    }

    fn managed_ollama(&self) -> Option<PathBuf> {
        let l = self.layout.as_ref()?;
        l.is_installed(&OLLAMA).then(|| l.ollama_bin())
    }

    fn plan_ollama_now(&self) -> OllamaPlan {
        let default = probe_ollama(OLLAMA_PORT);
        let fallback = if matches!(default, OllamaProbe::Running(Some(v)) if v.meets_minimum()) {
            OllamaProbe::Absent
        } else {
            probe_ollama(OLLAMA_FALLBACK_PORT)
        };
        // A managed install that's already there counts as a usable binary.
        let bin = self.managed_ollama().or_else(|| self.best_user_ollama().map(|(p, _)| p));
        plan_ollama(default, fallback, bin, self.managed)
    }

    fn docker_candidates(&self) -> Vec<PathBuf> {
        docker_socket_candidates(&self.home, std::env::var("DOCKER_HOST").ok().as_deref())
    }

    /// Fast (sub-second) decision of where Ollama and Docker will be, before the agent spawns,
    /// so the agent starts with the right OLLAMA_HOST / DOCKER_HOST.
    pub fn prepare(&self) -> AgentCompute {
        let plan = self.plan_ollama_now();
        let live = if cfg!(unix) { first_live_socket(&self.docker_candidates()) } else { None };
        let docker_sock = live.or_else(|| self.managed.then(|| colima_socket(&self.home)));
        let compute = AgentCompute {
            ollama_host: (plan.action != OllamaAction::Missing).then(|| ollama_url(plan.port)),
            docker_host: docker_sock.map(|s| format!("unix://{}", s.display())),
            path_dirs: self.layout.as_ref().map(|l| l.path_dirs()).unwrap_or_default(),
            model_provider: (plan.action != OllamaAction::Missing).then_some("ollama-local"),
        };
        self.with(|i| i.compute = compute.clone());
        compute
    }

    /// What an agent spawned now gets: env vars plus the managed PATH dirs that exist yet.
    fn snapshot(i: &Inner) -> (Vec<(String, String)>, Vec<PathBuf>) {
        let env = i.compute.env(|k| std::env::var(k).ok());
        let dirs = i.compute.path_dirs.iter().filter(|d| d.is_dir()).cloned().collect();
        (env, dirs)
    }

    /// Env for an agent being spawned now (also remembered, see `agent_env_changed`).
    pub fn agent_env(&self) -> Vec<(String, String)> {
        self.with(|i| {
            let snap = Self::snapshot(i);
            let env = snap.0.clone();
            i.spawned_env = Some(snap);
            env
        })
    }

    pub fn agent_path_dirs(&self) -> Vec<PathBuf> {
        self.with(|i| Self::snapshot(i).1)
    }

    /// True when the running agent was spawned with different hosts or before the managed
    /// binaries (docker CLI) existed, so it needs a restart.
    fn agent_env_changed(&self) -> bool {
        self.with(|i| {
            let now = Self::snapshot(i);
            i.spawned_env.as_ref().is_some_and(|s| *s != now)
        })
    }

    /// Run setup in the background unless it's already running. `on_env_change` runs when the
    /// agent should be restarted to pick up a different OLLAMA_HOST / DOCKER_HOST.
    pub fn start(&'static self, on_env_change: impl Fn() + Send + 'static) {
        // Already done: the webview asking again (e.g. after sign-in) must not redo the checks.
        if self.status().state == "ready" {
            return;
        }
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        thread::spawn(move || {
            self.ensure();
            self.running.store(false, Ordering::SeqCst);
            if self.agent_env_changed() {
                log_line("local compute changed; restarting the agent");
                on_env_change();
            }
        });
    }

    fn ensure(&self) {
        self.set_ollama(|c| {
            *c = ComponentStatus { state: "checking".into(), detail: "Checking for Ollama".into(), required: true, ..Default::default() }
        });
        let docker_required = self.managed;
        self.set_docker(|c| {
            *c = ComponentStatus { state: "checking".into(), detail: "Checking for Docker".into(), required: docker_required, ..Default::default() }
        });
        self.ensure_ollama();
        self.ensure_docker();
    }

    // ---- Ollama ---------------------------------------------------------------------------

    fn ensure_ollama(&self) {
        // Our own server from an earlier attempt may still be up.
        let alive = self.with(|i| i.ollama_child.as_mut().is_some_and(|c| matches!(c.try_wait(), Ok(None))));
        let plan = self.plan_ollama_now();
        self.with(|i| i.compute.ollama_host = (plan.action != OllamaAction::Missing).then(|| ollama_url(plan.port)));
        self.with(|i| i.compute.model_provider = (plan.action != OllamaAction::Missing).then_some("ollama-local"));
        let outdated_note = match plan.outdated_running {
            Some(Some(v)) => format!(" (an older Ollama {v} is running on :{OLLAMA_PORT}, so EdgeCoder runs its own on :{})", plan.port),
            Some(None) => format!(" (something else is using :{OLLAMA_PORT}, so EdgeCoder runs Ollama on :{})", plan.port),
            None => String::new(),
        };
        let result = match &plan.action {
            OllamaAction::UseRunning(v) => {
                let source = if alive { "managed" } else { "existing" };
                self.set_ollama(|c| {
                    c.state = "ready".into();
                    c.source = source.into();
                    c.version = v.to_string();
                    c.detail = format!("Ollama {v} is running{outdated_note}");
                });
                return;
            }
            OllamaAction::Missing => Err(match plan.outdated_running {
                Some(Some(v)) => format!(
                    "Ollama {v} is too old for current models (EdgeCoder needs {MIN_OLLAMA_VERSION} or newer). Update it from ollama.com, then press Retry."
                ),
                _ => "Ollama isn't installed. Install it from ollama.com, then press Retry.".to_string(),
            }),
            OllamaAction::Start(bin) => self.start_ollama(bin, plan.port, "existing"),
            OllamaAction::InstallAndStart => self
                .install(&[OLLAMA], "Ollama", |f| self.set_ollama(f))
                .and_then(|_| {
                    let bin = self.layout.as_ref().map(|l| l.ollama_bin()).ok_or("no install folder")?;
                    self.start_ollama(&bin, plan.port, "managed")
                }),
        };
        match result {
            Ok(v) => {
                let managed_bin = self.managed_ollama();
                self.set_ollama(|c| {
                    c.state = "ready".into();
                    c.version = v.to_string();
                    c.detail = format!("Ollama {v} is running{outdated_note}");
                    c.error = None;
                    if managed_bin.is_some() && c.source.is_empty() {
                        c.source = "managed".into();
                    }
                });
            }
            Err(e) => {
                log_line(&format!("ollama: {e}"));
                self.set_ollama(|c| {
                    c.state = "error".into();
                    c.error = Some(e);
                });
            }
        }
    }

    fn start_ollama(&self, bin: &Path, port: u16, source: &str) -> Result<Version, String> {
        let managed = self.layout.as_ref().is_some_and(|l| bin.starts_with(&l.root));
        let source = if managed { "managed" } else { source };
        self.set_ollama(|c| {
            c.state = "starting".into();
            c.source = source.into();
            c.detail = "Starting Ollama".into();
        });
        let mut cmd = Command::new(bin);
        cmd.arg("serve").env("OLLAMA_HOST", format!("127.0.0.1:{port}")).stdin(Stdio::null());
        if let Some(f) = log_file("ollama.log") {
            if let Ok(e) = f.try_clone() {
                cmd.stdout(f).stderr(e);
            }
        }
        let child = cmd.spawn().map_err(|e| format!("Couldn't start Ollama ({}): {e}", bin.display()))?;
        self.with(|i| {
            if let Some(mut old) = i.ollama_child.replace(child) {
                let _ = old.kill();
                let _ = old.wait();
            }
        });
        let deadline = Instant::now() + Duration::from_secs(45);
        while Instant::now() < deadline {
            if let OllamaProbe::Running(Some(v)) = probe_ollama(port) {
                return Ok(v);
            }
            let exited = self.with(|i| i.ollama_child.as_mut().and_then(|c| c.try_wait().ok().flatten()));
            if let Some(status) = exited {
                return Err(format!("Ollama exited during startup ({status}). Its output is in ~/.edgecoder/ollama.log."));
            }
            thread::sleep(Duration::from_millis(300));
        }
        Err("Ollama didn't answer within 45 s. Its output is in ~/.edgecoder/ollama.log.".to_string())
    }

    // ---- Docker -----------------------------------------------------------------------------

    fn ensure_docker(&self) {
        let required = self.managed;
        if let Some(sock) = if cfg!(unix) { first_live_socket(&self.docker_candidates()) } else { None } {
            let host = format!("unix://{}", sock.display());
            let cli_missing = self.managed
                && self.user_docker_cli().is_none()
                && host_arch().is_some_and(|a| !self.layout_has(&docker_cli_artifact(a)));
            if cli_missing {
                // A daemon without a `docker` CLI (the agent shells out to it).
                if let Err(e) = self.install_docker_parts(false, true) {
                    self.set_docker(|c| {
                        c.state = "error".into();
                        c.error = Some(e);
                    });
                    return;
                }
            }
            self.with(|i| i.compute.docker_host = Some(host.clone()));
            // Evaluated before set_docker: it takes the same lock.
            let ours = sock == colima_socket(&self.home) && self.started_colima();
            self.set_docker(|c| {
                c.state = "ready".into();
                c.source = if ours { "managed".into() } else { "existing".into() };
                c.detail = format!("Docker is running ({})", sock.display());
                c.error = None;
            });
            return;
        }
        if !self.managed {
            let msg = if cfg!(windows) {
                "Docker isn't checked on Windows yet; install Docker Desktop to run swarm tasks in a sandbox."
            } else {
                "Docker isn't running. Install Docker to run network tasks in a sandbox (optional)."
            };
            self.set_docker(|c| {
                c.state = if cfg!(windows) { "skipped".into() } else { "error".into() };
                c.error = Some(msg.to_string());
                c.required = required;
            });
            return;
        }
        if let Err(e) = self.start_colima() {
            log_line(&format!("docker: {e}"));
            self.set_docker(|c| {
                c.state = "error".into();
                c.error = Some(e);
            });
        }
    }

    fn started_colima(&self) -> bool {
        self.with(|i| i.started_colima.is_some())
    }

    fn layout_has(&self, a: &Artifact) -> bool {
        self.layout.as_ref().is_some_and(|l| l.is_installed(a))
    }

    fn user_docker_cli(&self) -> Option<PathBuf> {
        docker_cli_candidates(&self.home).into_iter().find(|p| p.exists())
    }

    /// The user's own Colima, if it has its limactl next to it.
    fn user_colima(&self) -> Option<PathBuf> {
        colima_binary_candidates()
            .into_iter()
            .find(|p| p.exists() && p.parent().is_some_and(|d| d.join("limactl").exists()))
    }

    fn install_docker_parts(&self, colima: bool, cli: bool) -> Result<(), String> {
        let arch = host_arch().ok_or("unsupported CPU")?;
        let mut parts = Vec::new();
        if colima {
            parts.push(colima_artifact(arch));
            parts.push(lima_artifact(arch));
        }
        if cli {
            parts.push(docker_cli_artifact(arch));
        }
        self.install(&parts, "Docker sandbox", |f| self.set_docker(f))
    }

    fn start_colima(&self) -> Result<(), String> {
        let arch = host_arch().ok_or("unsupported CPU")?;
        let layout = self.layout.clone().ok_or("no install folder")?;
        let user_colima = self.user_colima();
        let need_cli = self.user_docker_cli().is_none() && !self.layout_has(&docker_cli_artifact(arch));
        let need_colima = user_colima.is_none() && !(self.layout_has(&colima_artifact(arch)) && self.layout_has(&lima_artifact(arch)));
        if need_cli || need_colima {
            self.install_docker_parts(need_colima, need_cli)?;
        }
        let colima = user_colima.clone().unwrap_or_else(|| layout.colima_bin());
        let source = if user_colima.is_some() { "existing" } else { "managed" };
        let mut dirs = layout.path_dirs();
        if let Some(d) = user_colima.as_ref().and_then(|p| p.parent()) {
            dirs.insert(0, d.to_path_buf());
        }
        let current = std::env::var("PATH").unwrap_or_default();
        let path = compose_path(&format!("{current}:/usr/bin:/bin:/usr/sbin:/sbin"), &dirs, ':');

        let profile_exists = Path::new(&self.home).join(".colima").join(COLIMA_PROFILE).join("colima.yaml").exists();
        let (cpus, mem) = sysinfo_lite();
        let args = colima_start_args(profile_exists, cpus, mem, macos_major())?;
        self.set_docker(|c| {
            c.state = "starting".into();
            c.source = source.into();
            c.downloaded = 0;
            c.total = 0;
            c.detail = if profile_exists {
                "Starting the Docker VM".into()
            } else {
                "Creating the Docker VM (the first start downloads a Linux image and can take a few minutes)".into()
            };
        });
        log_line(&format!("starting colima: {} {}", colima.display(), args.join(" ")));
        let log_path = Path::new(&self.home).join(".edgecoder").join("colima.log");
        let mut cmd = Command::new(&colima);
        cmd.args(&args).env("PATH", &path).stdin(Stdio::null());
        if let Ok(f) = fs::OpenOptions::new().create(true).write(true).truncate(true).open(&log_path) {
            if let Ok(e) = f.try_clone() {
                cmd.stdout(f).stderr(e);
            }
        }
        let mut child = cmd.spawn().map_err(|e| format!("Couldn't run Colima ({}): {e}", colima.display()))?;
        self.with(|i| i.started_colima = Some((colima.clone(), path.clone())));
        let deadline = Instant::now() + Duration::from_secs(20 * 60);
        let status = loop {
            if let Ok(Some(s)) = child.try_wait() {
                break s;
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                return Err("The Docker VM took more than 20 minutes to start. Details are in ~/.edgecoder/colima.log.".into());
            }
            if let Some(line) = fs::read_to_string(&log_path).ok().as_deref().and_then(last_log_line) {
                self.set_docker(|c| c.activity = line.chars().take(160).collect());
            }
            thread::sleep(Duration::from_millis(500));
        };
        self.set_docker(|c| c.activity = String::new());
        if !status.success() {
            self.with(|i| i.started_colima = None);
            let why = fs::read_to_string(&log_path).ok().as_deref().and_then(last_log_line).unwrap_or_default();
            return Err(format!("The Docker VM didn't start: {why}. Details are in ~/.edgecoder/colima.log."));
        }
        let sock = colima_socket(&self.home);
        let deadline = Instant::now() + Duration::from_secs(60);
        while !docker_ping(&sock) {
            if Instant::now() > deadline {
                return Err(format!("Colima started but Docker isn't answering on {}.", sock.display()));
            }
            thread::sleep(Duration::from_millis(500));
        }
        self.with(|i| i.compute.docker_host = Some(format!("unix://{}", sock.display())));
        self.set_docker(|c| {
            c.state = "ready".into();
            c.detail = "Docker is running in Colima".into();
            c.error = None;
        });
        Ok(())
    }

    // ---- Downloads -----------------------------------------------------------------------------

    /// Download, verify and unpack each artifact not yet installed, reporting progress.
    fn install(&self, parts: &[Artifact], label: &str, set: impl Fn(Update)) -> Result<(), String> {
        let layout = self.layout.as_ref().ok_or("no install folder")?;
        let todo: Vec<&Artifact> = parts.iter().filter(|a| !layout.is_installed(a)).collect();
        if todo.is_empty() {
            return Ok(());
        }
        let total: u64 = todo.iter().map(|a| a.size).sum();
        let mut done = 0u64;
        fs::create_dir_all(layout.downloads_dir()).map_err(|e| format!("Couldn't create {}: {e}", layout.downloads_dir().display()))?;
        for a in todo {
            let names = format!("{} {}", a.name, a.version);
            let n = names.clone();
            set(Box::new(move |c| {
                c.state = "downloading".into();
                c.source = "managed".into();
                c.detail = format!("Downloading {n}");
                c.downloaded = done;
                c.total = total;
                c.error = None;
            }));
            let file = layout.downloads_dir().join(format!("{}-{}.download", a.name, a.version));
            let (base, size) = (done, a.size);
            download(a, &file, |n| {
                set(Box::new(move |c| c.downloaded = base + n.min(size)));
            })
            .map_err(|e| format!("Downloading {label} failed: {e}. Check your internet connection and press Retry."))?;
            let n = names.clone();
            set(Box::new(move |c| {
                c.state = "installing".into();
                c.detail = format!("Verifying {n}");
            }));
            if let Err(e) = verify_file(&file, a.size, a.sha256) {
                let _ = fs::remove_file(&file);
                return Err(format!("The {} download didn't match its pinned checksum ({e}); it was deleted. Press Retry.", a.name));
            }
            let n = names.clone();
            set(Box::new(move |c| c.detail = format!("Installing {n}")));
            unpack(layout, a, &file).map_err(|e| format!("Installing {} failed: {e}", a.name))?;
            let _ = fs::remove_file(&file);
            done += a.size;
            log_line(&format!("installed {} {} into {}", a.name, a.version, layout.root.display()));
        }
        set(Box::new(move |c| c.downloaded = total));
        Ok(())
    }

    /// Stop what this app started: our `ollama serve`, and the Colima VM if we booted it.
    pub fn shutdown(&self) {
        let (child, colima) = self.with(|i| (i.ollama_child.take(), i.started_colima.take()));
        if let Some(mut c) = child {
            let _ = c.kill();
            let _ = c.wait();
        }
        if let Some((bin, path)) = colima {
            // Detached: the VM takes a few seconds to stop and the app is quitting.
            let _ = Command::new(bin)
                .args(["stop", "--profile", COLIMA_PROFILE])
                .env("PATH", path)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        }
    }

    /// Restart our `ollama serve` if it died after setup (called periodically).
    pub fn watchdog(&self) {
        let died = self.with(|i| match i.ollama_child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(Some(_))),
            None => false,
        });
        if died && !self.running.load(Ordering::SeqCst) {
            log_line("ollama exited; starting it again");
            self.with(|i| i.ollama_child = None);
            self.ensure_ollama();
        }
    }
}

/// (logical CPUs, total memory bytes) without pulling sysinfo into this module.
fn sysinfo_lite() -> (usize, u64) {
    let cpus = thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let mem = Command::new("/usr/sbin/sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
        .unwrap_or(8u64 << 30);
    (cpus, mem)
}

fn macos_major() -> Option<u32> {
    let out = Command::new("/usr/bin/sw_vers").arg("-productVersion").output().ok()?;
    String::from_utf8_lossy(&out.stdout).trim().split('.').next()?.parse().ok()
}

/// curl (shipped with macOS) into `file`, reporting bytes so far.
fn download(a: &Artifact, file: &Path, progress: impl Fn(u64)) -> Result<(), String> {
    if !a.url.starts_with("https://") {
        return Err("refusing a non-https download".into());
    }
    let _ = fs::remove_file(file);
    let mut child = Command::new("/usr/bin/curl")
        .args(["--fail", "--location", "--silent", "--show-error", "--proto", "=https", "--retry", "3", "--connect-timeout", "30", "--output"])
        .arg(file)
        .arg(a.url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't run curl: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(60 * 60);
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if status.success() {
                return Ok(());
            }
            let mut err = String::new();
            if let Some(mut s) = child.stderr.take() {
                let _ = s.read_to_string(&mut err);
            }
            let err = err.trim().trim_start_matches("curl: ").to_string();
            return Err(if err.is_empty() { format!("curl exited with {status}") } else { err });
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            return Err("timed out".into());
        }
        progress(fs::metadata(file).map(|m| m.len()).unwrap_or(0));
        thread::sleep(Duration::from_millis(250));
    }
}

/// Unpack a verified download into the layout, atomically per target, then write its marker.
pub fn unpack(layout: &Layout, a: &Artifact, file: &Path) -> Result<(), String> {
    let staging = layout.root.join(format!(".staging-{}", a.name));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let untar = |dest: &Path| -> Result<(), String> {
        let out = Command::new("tar").arg("-xzf").arg(file).arg("-C").arg(dest).output().map_err(|e| format!("couldn't run tar: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!("tar failed: {}", String::from_utf8_lossy(&out.stderr).trim()))
        }
    };
    let result = (|| -> Result<(), String> {
        match a.unpack {
            Unpack::TarGzDir(dir) => {
                untar(&staging)?;
                let target = layout.root.join(dir);
                let _ = fs::remove_dir_all(&target);
                fs::rename(&staging, &target).map_err(|e| e.to_string())?;
            }
            Unpack::TarGzMember { member, to } => {
                untar(&staging)?;
                install_file(&staging.join(member), &layout.root.join(to))?;
            }
            Unpack::Binary(to) => install_file(file, &layout.root.join(to))?,
        }
        Ok(())
    })();
    let _ = fs::remove_dir_all(&staging);
    result?;
    let marker = layout.marker(a);
    if let Some(d) = marker.parent() {
        fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    fs::write(&marker, a.sha256).map_err(|e| e.to_string())
}

fn install_file(src: &Path, dest: &Path) -> Result<(), String> {
    if !src.is_file() {
        return Err(format!("{} missing from the archive", src.display()));
    }
    if let Some(d) = dest.parent() {
        fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = dest.with_extension("new");
    fs::copy(src, &tmp).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, dest).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        use std::sync::atomic::AtomicUsize;
        static N: AtomicUsize = AtomicUsize::new(0);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let d = std::env::temp_dir().join(format!(
            "ec-local-compute-{tag}-{}-{nanos}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn parses_versions() {
        assert_eq!(Version::parse("0.40.13"), Some(Version(0, 40, 13)));
        assert_eq!(Version::parse("v0.40.13\n"), Some(Version(0, 40, 13)));
        assert_eq!(Version::parse("0.41.0-rc2"), Some(Version(0, 41, 0)));
        assert_eq!(Version::parse("0.40"), Some(Version(0, 40, 0)));
        assert_eq!(Version::parse("0.40.1.2"), None);
        assert_eq!(Version::parse("latest"), None);
        assert_eq!(Version::parse(""), None);
    }

    #[test]
    fn minimum_version_check() {
        assert!(Version(0, 40, 0).meets_minimum());
        assert!(Version(0, 40, 13).meets_minimum());
        assert!(Version(1, 0, 0).meets_minimum());
        assert!(!Version(0, 39, 99).meets_minimum());
        assert!(!Version(0, 6, 8).meets_minimum());
        // Ordering is numeric, not lexical.
        assert!(Version(0, 40, 10) > Version(0, 40, 9));
        // The pinned build always satisfies the minimum.
        assert!(Version::parse(OLLAMA.version).unwrap().meets_minimum());
    }

    #[test]
    fn parses_ollama_cli_output() {
        // No server running.
        assert_eq!(
            parse_ollama_cli_version("Warning: could not connect to a running Ollama instance\nWarning: client version is 0.40.13\n"),
            Some(Version(0, 40, 13))
        );
        // A different server running: the binary's own (client) version wins.
        assert_eq!(parse_ollama_cli_version("ollama version is 0.40.7\nWarning: client version is 0.40.13\n"), Some(Version(0, 40, 13)));
        assert_eq!(parse_ollama_cli_version("ollama version is 0.12.3\n"), Some(Version(0, 12, 3)));
        assert_eq!(parse_ollama_cli_version("command not found"), None);
    }

    #[test]
    fn parses_ollama_api_version() {
        assert_eq!(parse_ollama_api_version(r#"{"version":"0.40.7"}"#), Some(Version(0, 40, 7)));
        assert_eq!(parse_ollama_api_version("not json"), None);
        assert_eq!(parse_ollama_api_version(r#"{"v":"1"}"#), None);
    }

    #[test]
    fn parses_http_responses() {
        let raw = "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"version\":\"0.40.13\"}";
        assert_eq!(parse_http_response(raw), Some((200, "{\"version\":\"0.40.13\"}".to_string())));
        assert_eq!(parse_http_response("HTTP/1.1 404 Not Found\r\n\r\n"), Some((404, String::new())));
        assert_eq!(parse_http_response("SSH-2.0-OpenSSH\r\n"), None);
        assert_eq!(parse_http_response(""), None);
    }

    #[test]
    fn checksum_verification() {
        let d = tmpdir("sha");
        let f = d.join("blob");
        fs::write(&f, b"hello world").unwrap();
        let sha = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
        assert_eq!(sha256_file(&f).unwrap(), sha);
        assert!(verify_file(&f, 11, sha).is_ok());
        assert!(verify_file(&f, 11, &sha.to_uppercase()).is_ok());
        let wrong = verify_file(&f, 11, &"0".repeat(64)).unwrap_err();
        assert!(wrong.contains("checksum mismatch"), "{wrong}");
        let short = verify_file(&f, 12, sha).unwrap_err();
        assert!(short.contains("expected 12"), "{short}");
        assert!(verify_file(&d.join("missing"), 1, sha).is_err());
        fs::remove_dir_all(d).ok();
    }

    #[test]
    fn pinned_artifacts_are_well_formed() {
        let all = [OLLAMA, COLIMA_ARM64, COLIMA_X86_64, LIMA_ARM64, LIMA_X86_64, DOCKER_CLI_ARM64, DOCKER_CLI_X86_64];
        for a in all {
            assert!(a.url.starts_with("https://"), "{}", a.url);
            assert!(a.url.contains(a.version), "{} should name {}", a.url, a.version);
            assert_eq!(a.sha256.len(), 64, "{}", a.name);
            assert!(a.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{}", a.name);
            assert!(a.size > 1_000_000, "{}", a.name);
        }
        for arch in [Arch::Arm64, Arch::X86_64] {
            let tag = if arch == Arch::Arm64 { "arm64" } else { "x86_64" };
            let docker_tag = if arch == Arch::Arm64 { "aarch64" } else { "x86_64" };
            assert!(colima_artifact(arch).url.ends_with(&format!("Darwin-{tag}")));
            assert!(lima_artifact(arch).url.contains(&format!("Darwin-{tag}")));
            assert!(docker_cli_artifact(arch).url.contains(&format!("/{docker_tag}/")));
        }
        assert_ne!(COLIMA_ARM64.sha256, COLIMA_X86_64.sha256);
    }

    #[test]
    fn runtime_root_per_platform() {
        assert_eq!(runtime_root(None, "/Users/a", "macos", None), Some(PathBuf::from("/Users/a/Library/Application Support/EdgeCoder")));
        assert_eq!(runtime_root(Some("/opt/ec"), "/Users/a", "macos", None), Some(PathBuf::from("/opt/ec")));
        assert_eq!(runtime_root(Some("  "), "/home/b", "linux", None), Some(PathBuf::from("/home/b/.local/share/edgecoder")));
        assert_eq!(runtime_root(None, "", "windows", Some(r"C:\Users\c\AppData\Local")), Some(Path::new(r"C:\Users\c\AppData\Local").join("EdgeCoder")));
        assert_eq!(runtime_root(None, "", "linux", None), None);
    }

    #[test]
    fn layout_paths() {
        let l = Layout { root: PathBuf::from("/R") };
        assert_eq!(l.ollama_bin(), PathBuf::from("/R/ollama/ollama"));
        assert_eq!(l.colima_bin(), PathBuf::from("/R/bin/colima"));
        assert_eq!(l.bin_dir().join("docker"), PathBuf::from("/R/bin/docker"));
        assert_eq!(l.installed_path(&LIMA_ARM64), PathBuf::from("/R/lima/bin/limactl"));
        assert_eq!(l.installed_path(&OLLAMA), l.ollama_bin());
        assert_eq!(l.installed_path(&DOCKER_CLI_ARM64), l.bin_dir().join("docker"));
        assert_eq!(l.path_dirs(), vec![PathBuf::from("/R/bin"), PathBuf::from("/R/lima/bin"), PathBuf::from("/R/ollama")]);
    }

    #[test]
    fn install_marker_tracks_the_pinned_checksum() {
        let root = tmpdir("marker");
        let l = Layout { root: root.clone() };
        let src = root.join("colima.download");
        fs::write(&src, b"#!/bin/sh\necho colima\n").unwrap();
        assert!(!l.is_installed(&COLIMA_ARM64));
        unpack(&l, &COLIMA_ARM64, &src).unwrap();
        assert!(l.is_installed(&COLIMA_ARM64));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(l.colima_bin()).unwrap().permissions().mode() & 0o777, 0o755);
        }
        // A re-pin (different checksum) is not "installed".
        let repinned = Artifact { sha256: "ab".repeat(32).leak(), ..COLIMA_ARM64 };
        assert!(!l.is_installed(&repinned));
        fs::remove_dir_all(root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn unpacks_tarball_members_and_dirs() {
        let root = tmpdir("tar");
        let src = root.join("src");
        fs::create_dir_all(src.join("docker")).unwrap();
        fs::write(src.join("docker/docker"), b"cli").unwrap();
        let tgz = root.join("docker.tgz");
        assert!(Command::new("tar").arg("-czf").arg(&tgz).arg("-C").arg(&src).arg("docker").status().unwrap().success());
        let l = Layout { root: root.join("rt") };
        unpack(&l, &DOCKER_CLI_ARM64, &tgz).unwrap();
        assert_eq!(fs::read(l.bin_dir().join("docker")).unwrap(), b"cli");
        assert!(l.is_installed(&DOCKER_CLI_ARM64));
        // Dir unpack replaces the target dir.
        let flat = root.join("flat");
        fs::create_dir_all(&flat).unwrap();
        fs::write(flat.join("ollama"), b"bin").unwrap();
        let ol = root.join("ollama.tgz");
        assert!(Command::new("tar").arg("-czf").arg(&ol).arg("-C").arg(&flat).arg("ollama").status().unwrap().success());
        fs::create_dir_all(l.ollama_dir()).unwrap();
        fs::write(l.ollama_dir().join("stale.dylib"), b"old").unwrap();
        unpack(&l, &OLLAMA, &ol).unwrap();
        assert_eq!(fs::read(l.ollama_bin()).unwrap(), b"bin");
        assert!(!l.ollama_dir().join("stale.dylib").exists());
        // A member missing from the archive is an error, not a silent no-op.
        let bad = Artifact { unpack: Unpack::TarGzMember { member: "nope/docker", to: "bin/docker2" }, ..DOCKER_CLI_ARM64 };
        assert!(unpack(&l, &bad, &tgz).is_err());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn compose_path_prepends_without_duplicates() {
        let extra = vec![PathBuf::from("/R/bin"), PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/R/bin")];
        assert_eq!(compose_path("/usr/bin:/opt/homebrew/bin:/bin", &extra, ':'), "/R/bin:/opt/homebrew/bin:/usr/bin:/bin");
        assert_eq!(compose_path("", &extra[..1], ':'), "/R/bin");
        assert_eq!(compose_path("/usr/bin::/bin", &[], ':'), "/usr/bin:/bin");
    }

    #[test]
    fn docker_socket_order() {
        let c = docker_socket_candidates("/Users/a", Some("unix:///tmp/custom.sock"));
        assert_eq!(c[0], PathBuf::from("/tmp/custom.sock"));
        assert_eq!(c[1], PathBuf::from("/Users/a/.colima/default/docker.sock"));
        assert_eq!(c.last().unwrap(), &PathBuf::from("/var/run/docker.sock"));
        // tcp:// DOCKER_HOST isn't a socket to ping; skipped.
        let c = docker_socket_candidates("/Users/a", Some("tcp://1.2.3.4:2375"));
        assert_eq!(c[0], colima_socket("/Users/a"));
    }

    #[test]
    fn plans_ollama() {
        let new = Version(0, 40, 13);
        let old = Version(0, 6, 2);
        let bin = PathBuf::from("/opt/homebrew/bin/ollama");
        // New enough and running: use it.
        let p = plan_ollama(OllamaProbe::Running(Some(new)), OllamaProbe::Absent, None, true);
        assert_eq!((p.port, p.action), (OLLAMA_PORT, OllamaAction::UseRunning(new)));
        // Nothing running: start the user's binary, else install.
        assert_eq!(plan_ollama(OllamaProbe::Absent, OllamaProbe::Absent, Some(bin.clone()), true).action, OllamaAction::Start(bin.clone()));
        let p = plan_ollama(OllamaProbe::Absent, OllamaProbe::Absent, None, true);
        assert_eq!((p.port, p.action), (OLLAMA_PORT, OllamaAction::InstallAndStart));
        assert_eq!(plan_ollama(OllamaProbe::Absent, OllamaProbe::Absent, None, false).action, OllamaAction::Missing);
        // An old server holds :11434: run ours on the fallback port.
        let p = plan_ollama(OllamaProbe::Running(Some(old)), OllamaProbe::Absent, None, true);
        assert_eq!((p.port, p.action.clone(), p.outdated_running), (OLLAMA_FALLBACK_PORT, OllamaAction::InstallAndStart, Some(Some(old))));
        // ... or reuse ours already running there.
        let p = plan_ollama(OllamaProbe::Running(Some(old)), OllamaProbe::Running(Some(new)), None, true);
        assert_eq!((p.port, p.action), (OLLAMA_FALLBACK_PORT, OllamaAction::UseRunning(new)));
        // Unknown thing on :11434 is treated like an old one.
        assert_eq!(plan_ollama(OllamaProbe::Running(None), OllamaProbe::Absent, Some(bin.clone()), false).port, OLLAMA_FALLBACK_PORT);
        // Old server, no managed downloads, no good binary: missing (UI explains the update).
        assert_eq!(plan_ollama(OllamaProbe::Running(Some(old)), OllamaProbe::Absent, None, false).action, OllamaAction::Missing);
    }

    #[test]
    fn colima_args_size_new_vms_and_keep_existing_ones() {
        let gb = 1u64 << 30;
        let a = colima_start_args(false, 10, 16 * gb, Some(15)).unwrap();
        let joined = a.join(" ");
        assert!(joined.starts_with("start --profile default"), "{joined}");
        assert!(joined.contains("--vm-type vz") && joined.contains("--mount-type virtiofs") && joined.contains("--runtime docker"));
        assert!(joined.contains("--cpu 4") && joined.contains("--memory 4"), "{joined}");
        let small = colima_start_args(false, 2, 4 * gb, Some(13)).unwrap().join(" ");
        assert!(small.contains("--cpu 2") && small.contains("--memory 2"), "{small}");
        let big = colima_start_args(false, 32, 128 * gb, None).unwrap().join(" ");
        assert!(big.contains("--cpu 4") && big.contains("--memory 8"), "{big}");
        assert_eq!(colima_start_args(true, 8, 16 * gb, Some(12)).unwrap(), vec!["start", "--profile", "default"]);
        assert!(colima_start_args(false, 8, 16 * gb, Some(12)).unwrap_err().contains("macOS 13"));
    }

    #[test]
    fn agent_env_respects_user_settings() {
        let c = AgentCompute {
            ollama_host: Some(ollama_url(OLLAMA_FALLBACK_PORT)),
            docker_host: Some("unix:///Users/a/.colima/default/docker.sock".into()),
            path_dirs: vec![],
            model_provider: Some("ollama-local"),
        };
        let env = c.env(|_| None);
        assert_eq!(
            env,
            vec![
                ("OLLAMA_HOST".to_string(), "http://127.0.0.1:11435".to_string()),
                ("DOCKER_HOST".to_string(), "unix:///Users/a/.colima/default/docker.sock".to_string()),
                ("LOCAL_MODEL_PROVIDER".to_string(), "ollama-local".to_string()),
            ]
        );
        let env = c.env(|k| (k == "DOCKER_HOST").then(|| "tcp://remote:2375".to_string()));
        assert!(!env.iter().any(|(k, _)| k == "DOCKER_HOST"));
        assert_eq!(AgentCompute::default().env(|_| None), vec![]);
    }

    #[test]
    fn overall_state_rules() {
        let st = |state: &str, required: bool| ComponentStatus { state: state.into(), required, ..Default::default() };
        assert_eq!(overall_state(false, &st("ready", true), &st("ready", true)), "ready");
        assert_eq!(overall_state(true, &st("downloading", true), &st("pending", true)), "running");
        assert_eq!(overall_state(false, &st("ready", true), &st("error", true)), "error");
        // Docker off macOS is optional: an error there doesn't hold up the app.
        assert_eq!(overall_state(false, &st("ready", true), &st("error", false)), "ready");
        assert_eq!(overall_state(false, &st("pending", true), &st("pending", true)), "idle");
    }

    #[test]
    fn last_log_line_extracts_colima_messages() {
        let log = "time=\"x\" level=info msg=\"starting colima\"\ntime=\"x\" level=fatal msg=\"error starting vm: exit status 1\"\n\n";
        assert_eq!(last_log_line(log).as_deref(), Some("error starting vm: exit status 1"));
        assert_eq!(last_log_line("plain failure\n").as_deref(), Some("plain failure"));
        assert_eq!(last_log_line("\n \n"), None);
    }
}
