// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

//! This machine's enrollment in the EdgeCoder network, written after the signed-in user enrolls
//! it through the portal: ~/.edgecoder/network.json (0600). The bundled agent's worker uses it to
//! register with the network coordinator instead of the app's local one.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NetworkEnrollment {
    pub node_id: String,
    pub registration_token: String,
    pub coordinator_url: String,
    pub portal_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkEnrollmentSummary {
    pub node_id: String,
    pub coordinator_url: String,
}

fn edgecoder_dir() -> Option<PathBuf> {
    let home = if cfg!(windows) {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
    } else {
        std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
    }?;
    Some(PathBuf::from(home).join(".edgecoder"))
}

fn valid_node_id(id: &str) -> bool {
    (3..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn valid_https_url(url: &str) -> bool {
    url.starts_with("https://") && url.len() <= 256 && !url.chars().any(|c| c.is_whitespace() || c == '\'' || c == '"')
}

impl NetworkEnrollment {
    pub fn validate(&self) -> Result<(), String> {
        if !valid_node_id(&self.node_id) {
            return Err("invalid node id".into());
        }
        if !(32..=256).contains(&self.registration_token.len()) || !self.registration_token.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err("invalid registration token".into());
        }
        if !valid_https_url(&self.coordinator_url) || !valid_https_url(&self.portal_url) {
            return Err("coordinator and portal must be https URLs".into());
        }
        Ok(())
    }

    pub fn summary(&self) -> NetworkEnrollmentSummary {
        NetworkEnrollmentSummary { node_id: self.node_id.clone(), coordinator_url: self.coordinator_url.clone() }
    }

    /// Environment for the bundled agent (read by src/index.ts and the worker).
    pub fn agent_env(&self) -> Vec<(String, String)> {
        vec![
            ("AGENT_ID".into(), self.node_id.clone()),
            ("AGENT_REGISTRATION_TOKEN".into(), self.registration_token.clone()),
            ("AGENT_NETWORK_COORDINATOR_URL".into(), self.coordinator_url.trim_end_matches('/').to_string()),
            ("PORTAL_URL".into(), self.portal_url.trim_end_matches('/').to_string()),
        ]
    }
}

pub fn load() -> Option<NetworkEnrollment> {
    let raw = fs::read_to_string(edgecoder_dir()?.join("network.json")).ok()?;
    let e: NetworkEnrollment = serde_json::from_str(&raw).ok()?;
    e.validate().ok().map(|_| e)
}

pub fn save(e: &NetworkEnrollment) -> Result<(), String> {
    let dir = edgecoder_dir().ok_or("home directory not found")?;
    fs::create_dir_all(&dir).map_err(|err| format!("cannot create {}: {err}", dir.display()))?;
    let path = dir.join("network.json");
    let tmp = dir.join("network.json.tmp");
    let body = serde_json::to_string_pretty(e).map_err(|err| err.to_string())?;
    write_private(&tmp, body.as_bytes())?;
    fs::rename(&tmp, &path).map_err(|err| format!("cannot write {}: {err}", path.display()))
}

#[cfg(unix)]
fn write_private(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path).map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn write_private(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    fs::write(path, bytes).map_err(|e| e.to_string())
}

/// The enrolled node id, else a stable proposal (`desktop-<host>-<8 hex>`) kept in ~/.edgecoder/node-id.
pub fn node_id() -> Result<String, String> {
    if let Some(e) = load() {
        return Ok(e.node_id);
    }
    let dir = edgecoder_dir().ok_or("home directory not found")?;
    let path = dir.join("node-id");
    if let Ok(existing) = fs::read_to_string(&path) {
        let id = existing.trim().to_string();
        if valid_node_id(&id) {
            return Ok(id);
        }
    }
    let host: String = sysinfo::System::host_name()
        .unwrap_or_else(|| "mac".into())
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(24)
        .collect();
    let id = format!("desktop-{}-{}", if host.is_empty() { "mac".into() } else { host }, &crate::token::generate_local_token()[..8]);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(&path, &id).map_err(|e| e.to_string())?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> NetworkEnrollment {
        NetworkEnrollment {
            node_id: "desktop-mac-1a2b3c4d".into(),
            registration_token: "a".repeat(64),
            coordinator_url: "https://coordinator.edgecoder.io/".into(),
            portal_url: "https://edgecoder.io".into(),
        }
    }

    #[test]
    fn accepts_a_portal_enrollment_and_builds_agent_env() {
        let e = sample();
        assert!(e.validate().is_ok());
        let env = e.agent_env();
        assert!(env.contains(&("AGENT_NETWORK_COORDINATOR_URL".into(), "https://coordinator.edgecoder.io".into())));
        assert!(env.contains(&("AGENT_ID".into(), "desktop-mac-1a2b3c4d".into())));
    }

    #[test]
    fn rejects_plain_http_odd_ids_and_short_tokens() {
        let mut e = sample();
        e.coordinator_url = "http://coordinator.edgecoder.io".into();
        assert!(e.validate().is_err());
        let mut e = sample();
        e.node_id = "../etc".into();
        assert!(e.validate().is_err());
        let mut e = sample();
        e.registration_token = "short".into();
        assert!(e.validate().is_err());
    }
}
