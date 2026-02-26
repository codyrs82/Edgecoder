# Portal Download Page Redesign + Cross-Platform Installers

**Date**: 2026-02-24
**Status**: Approved

## Goal

Redesign the edgecoder.io portal download page to be beginner-friendly with OS auto-detection, guided wizard flows, and installers for all platforms (adding Windows .msi). Remove the agent/coordinator distinction from the user-facing download experience — present a single "Install EdgeCoder, join the network" path. Add an `edgecoder configure` CLI so users never manually edit env files.

## Key Decisions

- **Single install path**: No agent vs coordinator choice on download page. Every user installs an agent node. Coordinator setup is admin docs only.
- **OS auto-detection**: Parse User-Agent server-side, highlight the detected platform's card with "Recommended for you" badge.
- **3-step wizard per platform**: Download → Install → Connect (paste token via CLI).
- **`edgecoder configure` CLI**: New shell/PowerShell scripts that write the token to the env file and restart the service.
- **Windows .msi**: New build script for Windows installer.
- **No new frontend framework**: Server-rendered HTML + inline CSS/JS, same as existing portal.
- **Feature cards**: Highlight mesh networking, earn credits, privacy/local-first, multi-platform.

## Page Structure

### Zone 1: Hero Banner
- "Get EdgeCoder" headline
- One-liner: "Install the agent. Join the mesh. Earn credits."
- Auto-detected OS badge: "We detected you're on macOS" (or Windows/Linux/iOS/unknown)

### Zone 2: Feature Cards Row
4 small cards in a horizontal row:
1. **P2P Mesh Network** — "Every node is a full peer. Tasks flow through gossip, not a single server."
2. **Earn Credits** — "Contribute compute, earn credits. Use them or transfer them."
3. **Private & Local-First** — "Code never leaves your device unless you choose cloud review."
4. **Multi-Platform** — "macOS, Windows, Linux, iOS, VS Code. Run anywhere."

### Zone 3: Wizard Area (Main Content)

#### Detected OS Card (Large, Primary)
"Recommended for your system" badge. Contains the 3-step wizard:

**Step 1: Download**
- Large download button with format badge (.pkg / .msi / .deb)
- File size
- "All releases" link

**Step 2: Install**
- Platform-specific instructions (human-readable, no jargon)
- macOS: "Double-click the .pkg file and follow the prompts"
- Windows: "Run the .msi file. Click Next. Allow admin access when prompted."
- Linux: Copy-to-clipboard `sudo dpkg -i EdgeCoder-1.0.0-linux-amd64.deb`
- iOS: "Download from the App Store" / TestFlight link
- VS Code: "Install from Marketplace" + `ext install edgecoder.edgecoder`

**Step 3: Connect to the Network**
- Link to Nodes page to get a registration token
- Copy-to-clipboard command: `edgecoder configure --token YOUR_TOKEN`
- macOS/Linux: terminal command
- Windows: PowerShell command
- iOS: "Open app → Settings → Paste token"
- VS Code: "Command Palette → EdgeCoder: Configure"
- Auto-populate token if `?token=xxx` query param present

#### "Other Platforms" Section (Collapsed by Default)
All other platform cards in a grid, each with the same 3-step wizard but smaller.

### Zone 4: Docker (Advanced)
Collapsed "Docker / Advanced" section at the bottom with the existing Docker instructions.

## Platforms

| Platform | Format | Arch | Status | Build Script |
|----------|--------|------|--------|-------------|
| macOS | .pkg | Universal (arm64 + x86_64) | Existing | `scripts/macos/build-installer.sh` |
| Windows | .msi | x64 | New | `scripts/windows/build-msi.sh` (new) |
| Linux (Debian/Ubuntu) | .deb | amd64 | Existing | `scripts/linux/build-deb.sh` |
| iOS | App Store / TestFlight | arm64 | Existing | Xcode |
| VS Code Extension | .vsix / Marketplace | Any | Existing | `extensions/vscode/` |
| Docker | Container image | amd64 | Existing | `Dockerfile` |

## `edgecoder configure` CLI

A wrapper script installed by each platform's package:

**Input**: `edgecoder configure --token TOKEN`

**Behavior**:
1. Writes `AGENT_REGISTRATION_TOKEN=<token>` to the platform env file
2. Sets `EDGE_RUNTIME_MODE=worker` if not already set
3. Restarts the service (launchctl / systemctl / Windows Service)
4. Prints success message with link to Nodes page

**Files**:
- macOS/Linux: `bin/edgecoder-configure.sh` (installed to `/opt/edgecoder/bin/`)
- Windows: `bin/edgecoder-configure.ps1` (installed to `C:\Program Files\EdgeCoder\bin\`)

## Visual Design

- Matches existing portal Midnight theme (dark glass aesthetic)
- Feature cards: icon + title + one-line description
- Wizard steps: vertical stepper with numbered circles (1, 2, 3) and connecting lines
- Copy buttons: clipboard icon → checkmark + "Copied!" on click
- Download buttons: large gradient blue (`btnPrimary` style) with OS icon
- "Recommended for you": green pill badge
- Responsive: 2-column grid on desktop, single column on mobile

## Client-Side Interactions (Inline JS, No Framework)

- Copy-to-clipboard on code blocks
- "Other platforms" toggle (show/hide)
- Token auto-populate from `?token=xxx` query param
- Smooth scroll anchors between steps

## What This Does NOT Cover

- Building the actual Windows .msi CI pipeline (just the build script)
- App Store submission for iOS
- Changing the coordinator architecture
- Real-time node verification (poll for connected node) — future enhancement
