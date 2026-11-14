// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

//! #138: coordinator / portal hosts changed in Settings after the build.
//!
//! The release CSP `connect-src` is a fixed list (tauri.conf.json, plus the build-time
//! VITE_COORDINATOR_URL / VITE_PORTAL_URL origins from scripts/gen-tauri-csp.mjs). Tauri applies
//! the CSP from the runtime config each time it serves the page, so before the app is built we add
//! the exact origins of the hosts the user saved in Settings (kept in
//! ~/.edgecoder/desktop-hosts.json). The webview saves them through `set_remote_hosts`, which
//! says whether the running window still has the old policy; the UI then offers a restart.
//!
//! Same host rules as #136 (gen-tauri-csp.mjs): https, or http only on loopback; no credentials;
//! the hostname must be plain DNS labels (IDNs as punycode) or a bracketed IPv6 literal, so a
//! value can never add `*`, `https:` or a second directive. Only exact origins are added.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Url;

const LOOPBACK: [&str; 3] = ["127.0.0.1", "localhost", "[::1]"];

fn is_label(l: &str) -> bool {
    !l.is_empty()
        && l.len() <= 63
        && !l.starts_with('-')
        && !l.ends_with('-')
        && l.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

/// True when the parsed hostname contains only host characters.
pub fn is_plain_host(host: &str) -> bool {
    if host.starts_with('[') && host.ends_with(']') && host.len() > 2 {
        return host[1..host.len() - 1].bytes().all(|c| c.is_ascii_hexdigit() || c == b':' || c == b'.');
    }
    !host.is_empty() && host.len() <= 253 && host.split('.').all(is_label)
}

/// The origin to allow for one configured URL, or the reason it is refused.
pub fn allowed_origin(raw: &str) -> Result<String, String> {
    let url = Url::parse(raw.trim()).map_err(|_| format!("not a valid URL: {raw}"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("must not contain credentials".into());
    }
    let host = url.host_str().unwrap_or("");
    if !is_plain_host(host) {
        return Err(format!("non-host character in hostname: {host:?}"));
    }
    let origin = url.origin().ascii_serialization();
    match url.scheme() {
        "https" => Ok(origin),
        "http" if LOOPBACK.contains(&host) => Ok(origin),
        _ => Err(format!("must be https (http only for loopback): {origin}")),
    }
}

/// Hosts saved in Settings (full URLs as the webview normalised them; None = default).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteHosts {
    pub coordinator: Option<String>,
    pub portal: Option<String>,
}

impl RemoteHosts {
    /// Validated, so a hand-edited file can't add anything the Settings check would refuse.
    pub fn validated(coordinator: Option<String>, portal: Option<String>) -> Result<Self, String> {
        let check = |name: &str, v: Option<String>| -> Result<Option<String>, String> {
            match v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
                None => Ok(None),
                Some(s) => allowed_origin(&s).map(|_| Some(s)).map_err(|e| format!("{name} URL {e}")),
            }
        };
        Ok(Self { coordinator: check("Coordinator", coordinator)?, portal: check("Portal", portal)? })
    }

    /// Exact origins to allow, in a stable order, without duplicates.
    pub fn origins(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for v in [&self.coordinator, &self.portal].into_iter().flatten() {
            if let Ok(o) = allowed_origin(v) {
                if !out.contains(&o) {
                    out.push(o);
                }
            }
        }
        out
    }
}

pub fn path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".edgecoder").join("desktop-hosts.json"))
}

/// Saved hosts; anything unreadable or invalid counts as "no override".
pub fn load_from(p: &Path) -> RemoteHosts {
    let Some(h) = fs::read_to_string(p).ok().and_then(|s| serde_json::from_str::<RemoteHosts>(&s).ok()) else {
        return RemoteHosts::default();
    };
    RemoteHosts::validated(h.coordinator, h.portal).unwrap_or_default()
}

pub fn save_to(p: &Path, h: &RemoteHosts) -> Result<(), String> {
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(p, serde_json::to_string_pretty(h).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

pub fn load() -> RemoteHosts {
    path().map(|p| load_from(&p)).unwrap_or_default()
}

/// `connect-src` with the origins appended (base order kept, no duplicates).
pub fn connect_src_with(base: &str, origins: &[String]) -> String {
    let mut tokens: Vec<String> = base.split_whitespace().map(str::to_string).collect();
    for o in origins {
        if !tokens.contains(o) {
            tokens.push(o.clone());
        }
    }
    tokens.join(" ")
}

/// Add the saved hosts' origins to the release CSP's connect-src, before the app is built.
/// Only a directive-map CSP with a connect-src is touched; every other directive stays as built.
pub fn apply_to_config(config: &mut tauri::Config, hosts: &RemoteHosts) {
    use tauri::utils::config::{Csp, CspDirectiveSources};
    let origins = hosts.origins();
    if origins.is_empty() {
        return;
    }
    let Some(Csp::DirectiveMap(map)) = config.app.security.csp.as_mut() else {
        return;
    };
    let Some(src) = map.get_mut("connect-src") else {
        return;
    };
    let base = match src {
        CspDirectiveSources::Inline(s) => s.clone(),
        CspDirectiveSources::List(l) => l.join(" "),
    };
    *src = CspDirectiveSources::Inline(connect_src_with(&base, &origins));
}

/// The connect-src sources the running window's CSP was built with (managed state).
pub struct AppliedHosts(pub Vec<String>);

/// Sources in the config's release connect-src (empty when the CSP isn't a directive map).
pub fn connect_src_sources(config: &tauri::Config) -> Vec<String> {
    use tauri::utils::config::{Csp, CspDirectiveSources};
    match config.app.security.csp.as_ref() {
        Some(Csp::DirectiveMap(map)) => match map.get("connect-src") {
            Some(CspDirectiveSources::Inline(s)) => s.split_whitespace().map(str::to_string).collect(),
            Some(CspDirectiveSources::List(l)) => l.clone(),
            None => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// Result of `set_remote_hosts` for the UI.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostsSaved {
    /// The running window's CSP doesn't allow every saved host yet; a restart applies it.
    pub restart_needed: bool,
}

pub fn restart_needed(applied: &[String], saved: &RemoteHosts) -> bool {
    saved.origins().iter().any(|o| !applied.contains(o))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_and_loopback_http_only() {
        assert_eq!(allowed_origin("https://coord.example.org:8443/api/v1?x=1").unwrap(), "https://coord.example.org:8443");
        assert_eq!(allowed_origin("https://portal.example.org/").unwrap(), "https://portal.example.org");
        assert_eq!(allowed_origin("http://127.0.0.1:9000/x").unwrap(), "http://127.0.0.1:9000");
        assert_eq!(allowed_origin("http://localhost:9000").unwrap(), "http://localhost:9000");
        assert_eq!(allowed_origin("http://[::1]:4301").unwrap(), "http://[::1]:4301");
        assert!(allowed_origin("http://coord.example.org").unwrap_err().contains("https"));
    }

    #[test]
    fn rejects_other_schemes_credentials_and_garbage() {
        assert!(allowed_origin("ws://coord.example.org").is_err());
        assert!(allowed_origin("javascript:alert(1)").is_err());
        assert!(allowed_origin("file:///etc/passwd").is_err());
        assert!(allowed_origin("https://user:pw@coord.example.org").unwrap_err().contains("credentials"));
        assert!(allowed_origin("not a url").is_err());
        assert!(allowed_origin("").is_err());
    }

    #[test]
    fn rejects_hostnames_that_could_widen_the_csp() {
        for host in ["a;b.example.org", "a,b.example.org", "a'b.example.org", "*.example.org", "a$b.example.org", "a_b.example.org", "a!b.example.org", "-a.example.org", "a..example.org"] {
            assert!(allowed_origin(&format!("https://{host}/")).is_err(), "{host}");
        }
    }

    #[test]
    fn idn_becomes_punycode() {
        assert_eq!(allowed_origin("https://BÜCHER.example").unwrap(), "https://xn--bcher-kva.example");
        assert!(is_plain_host("10.0.0.5") && is_plain_host("[::1]") && is_plain_host("coord-1.example.org"));
    }

    #[test]
    fn adds_exact_origins_only() {
        let base = "'self' ipc: http://127.0.0.1:4301 https://edgecoder.io";
        let hosts = RemoteHosts::validated(Some("https://coord.example.org:8443/api".into()), Some("https://edgecoder.io/".into())).unwrap();
        let out = connect_src_with(base, &hosts.origins());
        assert_eq!(out, format!("{base} https://coord.example.org:8443"));
        assert!(!out.split(' ').any(|t| t == "https:" || t.contains('*')));
        assert_eq!(connect_src_with(base, &RemoteHosts::default().origins()), base);
    }

    #[test]
    fn validated_refuses_bad_values_and_ignores_empty() {
        assert!(RemoteHosts::validated(Some("http://evil.example".into()), None).is_err());
        assert_eq!(RemoteHosts::validated(Some("  ".into()), None).unwrap(), RemoteHosts::default());
    }

    #[test]
    fn applies_to_the_release_csp_only_in_connect_src() {
        let mut config: tauri::Config = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let before = serde_json::to_value(&config.app.security).unwrap();
        let hosts = RemoteHosts { coordinator: Some("https://coord.example.org".into()), portal: None };
        apply_to_config(&mut config, &hosts);
        let after = serde_json::to_value(&config.app.security).unwrap();
        let connect = after["csp"]["connect-src"].as_str().unwrap().to_string();
        assert_eq!(connect, format!("{} https://coord.example.org", before["csp"]["connect-src"].as_str().unwrap()));
        for k in ["script-src", "default-src", "frame-src", "img-src"] {
            assert_eq!(before["csp"][k], after["csp"][k], "{k}");
        }
        assert_eq!(before["devCsp"], after["devCsp"]);
    }

    #[test]
    fn a_host_already_in_the_built_csp_needs_no_restart() {
        let config: tauri::Config = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let applied = connect_src_sources(&config);
        assert!(applied.contains(&"https://edgecoder.io".to_string()));
        let h = RemoteHosts { coordinator: None, portal: Some("https://edgecoder.io/".into()) };
        assert!(!restart_needed(&applied, &h));
    }

    #[test]
    fn restart_needed_only_for_new_origins() {
        let applied = vec!["https://coord.example.org".to_string()];
        let same = RemoteHosts { coordinator: Some("https://coord.example.org/x".into()), portal: None };
        let new = RemoteHosts { coordinator: Some("https://other.example.org".into()), portal: None };
        assert!(!restart_needed(&applied, &same));
        assert!(restart_needed(&applied, &new));
        assert!(!restart_needed(&applied, &RemoteHosts::default()));
    }

    #[test]
    fn persists_and_ignores_a_tampered_file() {
        let dir = std::env::temp_dir().join(format!("ec-hosts-{}", std::process::id()));
        let p = dir.join("desktop-hosts.json");
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(load_from(&p), RemoteHosts::default());
        let h = RemoteHosts { coordinator: Some("https://c.example.org".into()), portal: Some("http://127.0.0.1:4310".into()) };
        save_to(&p, &h).unwrap();
        assert_eq!(load_from(&p), h);
        fs::write(&p, r#"{"coordinator":"https://*.example.org"}"#).unwrap();
        assert_eq!(load_from(&p), RemoteHosts::default());
        let _ = fs::remove_dir_all(&dir);
    }
}
