# Desktop Auto-Update Design

## Goal

Add automatic update checking and in-app update installation to the EdgeCoder desktop app using the Tauri v2 updater plugin, with GitHub Releases as the update source.

## Architecture

The Tauri updater plugin handles the full lifecycle: version check, download, signature verification, and platform-specific installation. The agent runtime is bundled with the desktop app — no independent agent updates.

**Components:**

| Layer | Responsibility |
|-------|---------------|
| `tauri-plugin-updater` (Rust) | Download, verify, install platform binary |
| Svelte frontend | Update notification banner + Settings UI |
| GitHub Releases | Host `latest.json` manifest + signed platform binaries |
| Tauri signing key | Ed25519 keypair for update signature verification |

## Update Flow

1. App launches → check GitHub Releases for `latest.json`
2. Periodic re-check every 4 hours
3. Compare remote version vs `tauri.conf.json` version
4. If newer → show non-intrusive banner: "EdgeCoder v{X.Y.Z} available. [Update Now]"
5. User clicks "Update Now" → download signed binary → verify → install → restart
6. Settings page has manual "Check for Updates" button

## UI

### Settings Page (About section)

Enhance existing About section in `desktop/src/pages/Settings.svelte`:
- Current version (already shown)
- "Check for Updates" button
- Status text: "Up to date" / "Update available (v1.3.0)" / "Downloading..." / "Installing..."

### Global Banner

Dismissible banner at the top of the app window when an update is detected.

## Signing

- Generate Tauri Ed25519 keypair via `tauri signer generate`
- Private key: `TAURI_SIGNING_PRIVATE_KEY` env var (build machine only)
- Public key: embedded in `tauri.conf.json` → `plugins.updater.pubkey`
- Separate from existing release-integrity Ed25519 keys

## Config Changes

**`tauri.conf.json`** — add updater plugin config:
```json
{
  "plugins": {
    "updater": {
      "pubkey": "<generated-public-key>",
      "endpoints": [
        "https://github.com/codyrs82/Edgecoder/releases/latest/download/latest.json"
      ]
    }
  }
}
```

**`Cargo.toml`** — add dependency:
```toml
tauri-plugin-updater = "2"
```

**`capabilities/default.json`** — add updater permission:
```json
"updater:default"
```

## Release Process

1. Bump version in `tauri.conf.json`
2. Set `TAURI_SIGNING_PRIVATE_KEY` env var
3. Run `tauri build` → generates signed installers + `latest.json`
4. Create GitHub Release with tag matching the version
5. Upload platform binaries + `latest.json` as release assets

## Constraints

- iOS updates remain via App Store (out of scope)
- Agent runtime updates are coupled with desktop app updates
- No delta/incremental updates — full binary replacement
- Requires GitHub Releases to be accessible from user machines
