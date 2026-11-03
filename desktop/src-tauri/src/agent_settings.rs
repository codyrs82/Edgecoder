//! Agent settings the user changes in the app (Settings > General), kept in
//! ~/.edgecoder/agent-settings.json and passed to the agent as environment at every spawn.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentSettings {
    /// BLE mesh: find and serve nearby EdgeCoder machines over Bluetooth (macOS).
    pub ble_enabled: bool,
}

impl Default for AgentSettings {
    fn default() -> Self {
        // On by default: the agent always started BLE before this setting existed.
        Self { ble_enabled: true }
    }
}

impl AgentSettings {
    pub fn agent_env(&self) -> Vec<(String, String)> {
        vec![("EDGECODER_BLE".into(), if self.ble_enabled { "1" } else { "0" }.into())]
    }
}

fn path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".edgecoder").join("agent-settings.json"))
}

pub fn load_from(p: &PathBuf) -> AgentSettings {
    fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save_to(p: &PathBuf, s: &AgentSettings) -> Result<(), String> {
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(p, serde_json::to_string_pretty(s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

pub fn load() -> AgentSettings {
    path().map(|p| load_from(&p)).unwrap_or_default()
}

pub fn save(s: &AgentSettings) -> Result<(), String> {
    save_to(&path().ok_or("no home directory")?, s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ble_is_on_until_turned_off_and_the_choice_persists() {
        let dir = std::env::temp_dir().join(format!("ec-agent-settings-{}", std::process::id()));
        let p = dir.join("agent-settings.json");
        let _ = fs::remove_file(&p);
        assert!(load_from(&p).ble_enabled, "missing file means the old default: on");
        save_to(&p, &AgentSettings { ble_enabled: false }).unwrap();
        assert!(!load_from(&p).ble_enabled);
        assert_eq!(load_from(&p).agent_env(), vec![("EDGECODER_BLE".to_string(), "0".to_string())]);
        fs::write(&p, "not json").unwrap();
        assert!(load_from(&p).ble_enabled, "a broken file falls back to the default");
        let _ = fs::remove_dir_all(&dir);
    }
}
