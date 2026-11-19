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
    /// "Code from your phone" (AGENT_CODE_RELAY): "off" (default), "view" or "on".
    pub code_relay: String,
}

/// The values AGENT_CODE_RELAY takes; anything else is read as "off".
pub const CODE_RELAY_MODES: [&str; 3] = ["off", "view", "on"];

impl Default for AgentSettings {
    fn default() -> Self {
        // On by default: the agent always started BLE before this setting existed.
        // Code from your phone is off until the user turns it on.
        Self { ble_enabled: true, code_relay: "off".into() }
    }
}

impl AgentSettings {
    /// The code relay mode to pass on: a value from an older or hand-edited file that isn't one of
    /// CODE_RELAY_MODES is "off".
    pub fn code_relay_mode(&self) -> &'static str {
        CODE_RELAY_MODES.iter().copied().find(|m| *m == self.code_relay).unwrap_or("off")
    }

    pub fn agent_env(&self) -> Vec<(String, String)> {
        vec![
            ("EDGECODER_BLE".into(), if self.ble_enabled { "1" } else { "0" }.into()),
            ("AGENT_CODE_RELAY".into(), self.code_relay_mode().into()),
        ]
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
        save_to(&p, &AgentSettings { ble_enabled: false, ..Default::default() }).unwrap();
        assert!(!load_from(&p).ble_enabled);
        assert_eq!(
            load_from(&p).agent_env(),
            vec![("EDGECODER_BLE".to_string(), "0".to_string()), ("AGENT_CODE_RELAY".to_string(), "off".to_string())]
        );
        fs::write(&p, "not json").unwrap();
        assert!(load_from(&p).ble_enabled, "a broken file falls back to the default");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn code_relay_is_off_until_turned_on_and_unknown_values_are_off() {
        let dir = std::env::temp_dir().join(format!("ec-agent-settings-code-{}", std::process::id()));
        let p = dir.join("agent-settings.json");
        let _ = fs::remove_file(&p);
        assert_eq!(load_from(&p).code_relay_mode(), "off");
        // A file from before this setting existed: BLE kept, code relay off.
        fs::create_dir_all(&dir).unwrap();
        fs::write(&p, "{\"bleEnabled\":false}").unwrap();
        assert_eq!(load_from(&p).code_relay_mode(), "off");
        assert!(!load_from(&p).ble_enabled);
        save_to(&p, &AgentSettings { code_relay: "view".into(), ..Default::default() }).unwrap();
        assert!(load_from(&p).agent_env().contains(&("AGENT_CODE_RELAY".to_string(), "view".to_string())));
        save_to(&p, &AgentSettings { code_relay: "everything".into(), ..Default::default() }).unwrap();
        assert_eq!(load_from(&p).code_relay_mode(), "off");
        let _ = fs::remove_dir_all(&dir);
    }
}
