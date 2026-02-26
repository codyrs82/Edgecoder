# Portal Download Page Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current technical download page with a beginner-friendly, OS-auto-detected wizard that covers macOS, Windows (.msi), Linux (.deb), iOS, VS Code, and Docker — plus a new `edgecoder configure --token TOKEN` quick-connect mode.

**Architecture:** Server-rendered HTML in the existing Fastify portal (no new framework). OS detection via User-Agent header server-side. The download page route handler at `app.get("/portal/download")` in `src/portal/server.ts` is replaced entirely. New `edgecoder configure --token TOKEN` flag added to the existing macOS configure script, a new Linux configure script, and a new Windows PowerShell configure script. A new Windows MSI build script parallels the existing macOS/Linux build scripts.

**Tech Stack:** TypeScript (Fastify), Bash, PowerShell, HTML/CSS/inline JS, WiX/msitools for Windows .msi.

**Design doc:** `docs/plans/2026-02-24-portal-download-redesign-design.md`

---

## Task 1: Add `--token` Quick-Connect Flag to macOS Configure Script

**Files:**
- Modify: `scripts/macos/payload/bin/edgecoder-configure.sh:1-213`
- Test: manual — run `./edgecoder-configure.sh --token test123` and verify env file is written

The existing configure script is interactive-only. Add a `--token TOKEN` flag that writes the minimum config (token + worker mode + coordinator URL) and restarts the service non-interactively. This is the command users will copy from the portal.

**Step 1: Add the --token argument handler**

At the top of `edgecoder-configure.sh`, after the `--help` block (line 70-78), add a `--token` handler:

```bash
if [[ "${1:-}" == "--token" ]]; then
  TOKEN="${2:-}"
  if [[ -z "$TOKEN" ]]; then
    echo "Usage: edgecoder configure --token YOUR_TOKEN"
    echo ""
    echo "Get your token from https://portal.edgecoder.io/portal/nodes"
    exit 1
  fi

  mkdir -p /etc/edgecoder

  # Preserve existing config or start from example
  if [[ -f "$ENV_FILE" ]]; then
    cp "$ENV_FILE" "${ENV_FILE}.bak"
  elif [[ -f "$ENV_EXAMPLE" ]]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
  fi

  # Write/update token and mode
  write_or_update_env() {
    local key="$1" value="$2"
    if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
      sed -i '' "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    else
      echo "${key}=${value}" >> "$ENV_FILE"
    fi
  }

  touch "$ENV_FILE"
  write_or_update_env "AGENT_REGISTRATION_TOKEN" "$TOKEN"
  write_or_update_env "EDGE_RUNTIME_MODE" "worker"
  write_or_update_env "COORDINATOR_URL" "https://coordinator.edgecoder.io"
  write_or_update_env "AGENT_OS" "macos"
  chmod 600 "$ENV_FILE"

  echo ""
  echo "  EdgeCoder configured!"
  echo ""
  echo "  Token:       saved to $ENV_FILE"
  echo "  Mode:        worker (mesh peer)"
  echo "  Coordinator: https://coordinator.edgecoder.io"
  echo ""

  # Restart service if running
  if sudo launchctl print system/io.edgecoder.runtime &>/dev/null; then
    echo "  Restarting EdgeCoder service..."
    sudo launchctl kickstart -k system/io.edgecoder.runtime
    echo "  Service restarted."
  else
    echo "  Service not loaded yet. Start it with:"
    echo "    sudo launchctl load /Library/LaunchDaemons/io.edgecoder.runtime.plist"
  fi

  echo ""
  echo "  Check your node at: https://portal.edgecoder.io/portal/nodes"
  echo ""
  exit 0
fi
```

**Step 2: Add a `configure` symlink alias**

In `scripts/macos/package-scripts/postinstall`, add a symlink so `edgecoder configure` works:

```bash
ln -sf /opt/edgecoder/bin/edgecoder-configure.sh /usr/local/bin/edgecoder
```

This lets users type `sudo edgecoder --token TOKEN` or `sudo edgecoder configure --token TOKEN`.

**Step 3: Test locally**

```bash
# Dry run (won't actually write to /etc without sudo)
bash scripts/macos/payload/bin/edgecoder-configure.sh --token test-abc-123
```

Expected: prints "EdgeCoder configured!" with token/mode/coordinator summary.

**Step 4: Commit**

```bash
git add scripts/macos/payload/bin/edgecoder-configure.sh
git commit -m "feat(installer): add --token quick-connect to macOS configure script"
```

---

## Task 2: Create Linux Configure Script with --token Support

**Files:**
- Create: `scripts/linux/payload/bin/edgecoder-configure.sh`
- Modify: `scripts/linux/build-deb.sh:49-53` (copy configure script into package)
- Modify: `scripts/linux/package-scripts/postinst` (symlink to /usr/local/bin/edgecoder)

**Step 1: Create the Linux configure script**

Create `scripts/linux/payload/bin/edgecoder-configure.sh`:

```bash
#!/usr/bin/env bash

set -euo pipefail

ENV_FILE="/etc/edgecoder/edgecoder.env"
ENV_EXAMPLE="/etc/edgecoder/edgecoder.env.example"

if [[ "${1:-}" == "--help" ]]; then
  cat <<'EOF'
EdgeCoder Linux configuration tool.

Quick connect:
  sudo edgecoder --token YOUR_TOKEN

Interactive wizard:
  sudo edgecoder configure

Get your token from https://portal.edgecoder.io/portal/nodes
EOF
  exit 0
fi

write_or_update_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}

if [[ "${1:-}" == "--token" || "${1:-}" == "configure" && "${2:-}" == "--token" ]]; then
  TOKEN="${2:-}"
  [[ "${1:-}" == "configure" ]] && TOKEN="${3:-}"
  if [[ -z "$TOKEN" ]]; then
    echo "Usage: sudo edgecoder --token YOUR_TOKEN"
    echo ""
    echo "Get your token from https://portal.edgecoder.io/portal/nodes"
    exit 1
  fi

  mkdir -p /etc/edgecoder

  if [[ -f "$ENV_FILE" ]]; then
    cp "$ENV_FILE" "${ENV_FILE}.bak"
  elif [[ -f "$ENV_EXAMPLE" ]]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
  fi

  touch "$ENV_FILE"
  write_or_update_env "AGENT_REGISTRATION_TOKEN" "$TOKEN"
  write_or_update_env "EDGE_RUNTIME_MODE" "worker"
  write_or_update_env "COORDINATOR_URL" "https://coordinator.edgecoder.io"
  write_or_update_env "AGENT_OS" "linux"
  chmod 600 "$ENV_FILE"

  echo ""
  echo "  EdgeCoder configured!"
  echo ""
  echo "  Token:       saved to $ENV_FILE"
  echo "  Mode:        worker (mesh peer)"
  echo "  Coordinator: https://coordinator.edgecoder.io"
  echo ""

  if systemctl is-active --quiet edgecoder 2>/dev/null; then
    echo "  Restarting EdgeCoder service..."
    sudo systemctl restart edgecoder
    echo "  Service restarted."
  else
    echo "  Starting EdgeCoder service..."
    sudo systemctl enable edgecoder 2>/dev/null || true
    sudo systemctl start edgecoder
    echo "  Service started."
  fi

  echo ""
  echo "  Check your node at: https://portal.edgecoder.io/portal/nodes"
  echo ""
  exit 0
fi

# Fall through to interactive wizard (same pattern as macOS script)
echo ""
echo "EdgeCoder Linux setup wizard"
echo "For quick setup, use: sudo edgecoder --token YOUR_TOKEN"
echo "This configures $ENV_FILE for the systemd service."
echo ""
echo "Get your token from https://portal.edgecoder.io/portal/nodes"
echo ""

read -r -p "Registration token: " TOKEN
if [[ -z "$TOKEN" ]]; then
  echo "Token is required. Get one from https://portal.edgecoder.io/portal/nodes"
  exit 1
fi

mkdir -p /etc/edgecoder
touch "$ENV_FILE"
write_or_update_env "AGENT_REGISTRATION_TOKEN" "$TOKEN"
write_or_update_env "EDGE_RUNTIME_MODE" "worker"
write_or_update_env "COORDINATOR_URL" "https://coordinator.edgecoder.io"
write_or_update_env "AGENT_OS" "linux"
chmod 600 "$ENV_FILE"

echo ""
echo "  EdgeCoder configured!"
echo "  Restarting service..."
sudo systemctl enable edgecoder 2>/dev/null || true
sudo systemctl restart edgecoder
echo ""
echo "  Check your node at: https://portal.edgecoder.io/portal/nodes"
echo ""
```

**Step 2: Update build-deb.sh to include the configure script**

In `scripts/linux/build-deb.sh`, after line 51 (payload copy section), add:

```bash
cp "$PAYLOAD_DIR/bin/edgecoder-configure.sh" "$PKGROOT/usr/lib/edgecoder/bin/edgecoder-configure.sh"
```

And after line 74 (chmod section), add:

```bash
chmod 755 "$PKGROOT/usr/lib/edgecoder/bin/edgecoder-configure.sh"
```

**Step 3: Update postinst to create the symlink**

In `scripts/linux/package-scripts/postinst`, add:

```bash
ln -sf /usr/lib/edgecoder/bin/edgecoder-configure.sh /usr/local/bin/edgecoder
```

**Step 4: Commit**

```bash
git add scripts/linux/payload/bin/edgecoder-configure.sh scripts/linux/build-deb.sh scripts/linux/package-scripts/postinst
git commit -m "feat(installer): add Linux configure script with --token quick-connect"
```

---

## Task 3: Create Windows Configure PowerShell Script

**Files:**
- Create: `scripts/windows/payload/bin/edgecoder-configure.ps1`

**Step 1: Create the PowerShell configure script**

Create `scripts/windows/payload/bin/edgecoder-configure.ps1`:

```powershell
#Requires -RunAsAdministrator
param(
    [Parameter(Position=0)]
    [string]$Command,
    [string]$Token
)

$ErrorActionPreference = "Stop"
$EnvFile = "C:\ProgramData\EdgeCoder\edgecoder.env"
$ServiceName = "EdgeCoder"

function Write-OrUpdateEnv {
    param([string]$Key, [string]$Value)
    if (Test-Path $EnvFile) {
        $content = Get-Content $EnvFile -Raw
        if ($content -match "(?m)^$Key=") {
            $content = $content -replace "(?m)^$Key=.*", "$Key=$Value"
            Set-Content $EnvFile $content -NoNewline
        } else {
            Add-Content $EnvFile "$Key=$Value"
        }
    } else {
        Add-Content $EnvFile "$Key=$Value"
    }
}

if ($Command -eq "--help" -or $Command -eq "help") {
    Write-Host ""
    Write-Host "EdgeCoder Windows configuration tool."
    Write-Host ""
    Write-Host "Quick connect:"
    Write-Host "  edgecoder --token YOUR_TOKEN"
    Write-Host ""
    Write-Host "Get your token from https://portal.edgecoder.io/portal/nodes"
    Write-Host ""
    exit 0
}

# Handle: edgecoder --token TOKEN  or  edgecoder configure --token TOKEN
if ($Command -eq "--token") {
    # Token is the second positional arg
    if (-not $Token) {
        # Check if it was passed positionally
        $Token = $args[0]
    }
}
if ($Command -eq "configure" -and $args.Count -ge 2 -and $args[0] -eq "--token") {
    $Token = $args[1]
    $Command = "--token"
}

if ($Command -eq "--token" -or $Token) {
    if (-not $Token) {
        Write-Host "Usage: edgecoder --token YOUR_TOKEN" -ForegroundColor Red
        Write-Host ""
        Write-Host "Get your token from https://portal.edgecoder.io/portal/nodes"
        exit 1
    }

    # Ensure config directory exists
    $configDir = Split-Path $EnvFile -Parent
    if (-not (Test-Path $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }

    # Backup existing config
    if (Test-Path $EnvFile) {
        Copy-Item $EnvFile "$EnvFile.bak" -Force
    }

    if (-not (Test-Path $EnvFile)) {
        New-Item -ItemType File -Path $EnvFile -Force | Out-Null
    }

    Write-OrUpdateEnv "AGENT_REGISTRATION_TOKEN" $Token
    Write-OrUpdateEnv "EDGE_RUNTIME_MODE" "worker"
    Write-OrUpdateEnv "COORDINATOR_URL" "https://coordinator.edgecoder.io"
    Write-OrUpdateEnv "AGENT_OS" "windows"

    Write-Host ""
    Write-Host "  EdgeCoder configured!" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Token:       saved to $EnvFile"
    Write-Host "  Mode:        worker (mesh peer)"
    Write-Host "  Coordinator: https://coordinator.edgecoder.io"
    Write-Host ""

    # Restart service if it exists
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc) {
        Write-Host "  Restarting EdgeCoder service..."
        Restart-Service -Name $ServiceName -Force
        Write-Host "  Service restarted." -ForegroundColor Green
    } else {
        Write-Host "  Service not installed yet. It will start after MSI installation completes."
    }

    Write-Host ""
    Write-Host "  Check your node at: https://portal.edgecoder.io/portal/nodes"
    Write-Host ""
    exit 0
}

# Interactive fallback
Write-Host ""
Write-Host "EdgeCoder Windows setup"
Write-Host "For quick setup, use: edgecoder --token YOUR_TOKEN"
Write-Host ""
Write-Host "Get your token from https://portal.edgecoder.io/portal/nodes"
Write-Host ""
$Token = Read-Host "Registration token"
if (-not $Token) {
    Write-Host "Token is required." -ForegroundColor Red
    exit 1
}

# Re-invoke with --token
& $PSCommandPath --token $Token
```

**Step 2: Commit**

```bash
git add scripts/windows/payload/bin/edgecoder-configure.ps1
git commit -m "feat(installer): add Windows PowerShell configure script with --token"
```

---

## Task 4: Create Windows MSI Build Script

**Files:**
- Create: `scripts/windows/build-msi.sh`
- Create: `scripts/windows/payload/bin/edgecoder-runtime.ps1`
- Create: `scripts/windows/edgecoder.wxs` (WiX manifest)

This task creates the build infrastructure for a Windows .msi installer. The actual .msi build requires WiX Toolset on Windows or `wixl` (msitools) on Linux/macOS.

**Step 1: Create the Windows runtime wrapper**

Create `scripts/windows/payload/bin/edgecoder-runtime.ps1`:

```powershell
$ErrorActionPreference = "Stop"
$AppDir = "C:\Program Files\EdgeCoder\app"
$EnvFile = "C:\ProgramData\EdgeCoder\edgecoder.env"

# Load environment from file
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match '^([^#][^=]+)=(.*)$') {
            [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process")
        }
    }
}

$Mode = if ($env:EDGE_RUNTIME_MODE) { $env:EDGE_RUNTIME_MODE } else { "worker" }

$entryPoints = @{
    "worker"        = "dist/swarm/worker-runner.js"
    "all-in-one"    = "dist/index.js"
    "coordinator"   = "dist/swarm/coordinator.js"
    "control-plane" = "dist/control-plane/server.js"
    "inference"     = "dist/inference/service.js"
    "ide-provider"  = "dist/apps/ide/provider-server.js"
}

if (-not $entryPoints.ContainsKey($Mode)) {
    Write-Error "Unsupported EDGE_RUNTIME_MODE: $Mode"
    exit 1
}

$entry = $entryPoints[$Mode]
Set-Location $AppDir
& node $entry
```

**Step 2: Create the WiX XML manifest**

Create `scripts/windows/edgecoder.wxs`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*"
           Name="EdgeCoder"
           Language="1033"
           Version="1.0.0.0"
           Manufacturer="EdgeCoder"
           UpgradeCode="A1B2C3D4-E5F6-7890-ABCD-EF1234567890">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" />
    <MajorUpgrade DowngradeErrorMessage="A newer version is already installed." />
    <MediaTemplate EmbedCab="yes" />

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLFOLDER" Name="EdgeCoder">
          <Directory Id="AppFolder" Name="app" />
          <Directory Id="BinFolder" Name="bin" />
        </Directory>
      </Directory>
      <Directory Id="CommonAppDataFolder">
        <Directory Id="EdgeCoderDataFolder" Name="EdgeCoder" />
      </Directory>
    </Directory>

    <Feature Id="MainFeature" Title="EdgeCoder Runtime" Level="1">
      <ComponentGroupRef Id="AppFiles" />
      <ComponentGroupRef Id="BinFiles" />
      <ComponentRef Id="DataFolder" />
      <ComponentRef Id="PathEntry" />
    </Feature>

    <Component Id="DataFolder" Guid="B2C3D4E5-F6A7-8901-BCDE-F12345678901" Directory="EdgeCoderDataFolder">
      <CreateFolder />
    </Component>

    <Component Id="PathEntry" Guid="C3D4E5F6-A7B8-9012-CDEF-123456789012" Directory="BinFolder">
      <Environment Id="PATH" Name="PATH" Value="[BinFolder]" Permanent="no" Part="last" Action="set" System="yes" />
    </Component>

    <!-- ServiceInstall for Windows Service -->
    <Component Id="ServiceComponent" Guid="D4E5F6A7-B8C9-0123-DEFA-234567890123" Directory="BinFolder">
      <ServiceInstall Id="EdgeCoderService"
                      Name="EdgeCoder"
                      DisplayName="EdgeCoder Runtime"
                      Description="EdgeCoder mesh agent runtime service"
                      Start="auto"
                      Type="ownProcess"
                      ErrorControl="normal"
                      Arguments="&quot;[BinFolder]edgecoder-runtime.ps1&quot;" />
      <ServiceControl Id="StartService" Name="EdgeCoder" Start="install" Stop="both" Remove="uninstall" Wait="yes" />
    </Component>
  </Product>
</Wix>
```

**Step 3: Create the build script**

Create `scripts/windows/build-msi.sh`:

```bash
#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD_DIR="$ROOT_DIR/build/windows"
STAGE_APP="$BUILD_DIR/stage-app"
PAYLOAD_DIR="$ROOT_DIR/scripts/windows/payload"
VERSION="${1:-$(node -p "require('./package.json').version" 2>/dev/null || true)}"

if [[ -z "${VERSION}" ]]; then
  echo "Unable to determine package version."
  echo "Pass it explicitly: scripts/windows/build-msi.sh <version>"
  exit 1
fi

echo "Preparing EdgeCoder Windows installer v${VERSION}..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/app" "$BUILD_DIR/bin"

echo "Building project..."
npm run build --prefix "$ROOT_DIR"

echo "Staging production runtime..."
mkdir -p "$STAGE_APP"
cp -R "$ROOT_DIR/dist" "$STAGE_APP/dist"
cp "$ROOT_DIR/package.json" "$STAGE_APP/package.json"
cp "$ROOT_DIR/package-lock.json" "$STAGE_APP/package-lock.json"
npm ci --omit=dev --prefix "$STAGE_APP"

echo "Copying payload..."
cp -R "$STAGE_APP/." "$BUILD_DIR/app/"
cp "$PAYLOAD_DIR/bin/edgecoder-configure.ps1" "$BUILD_DIR/bin/edgecoder-configure.ps1"
cp "$PAYLOAD_DIR/bin/edgecoder-runtime.ps1" "$BUILD_DIR/bin/edgecoder-runtime.ps1"

echo ""
echo "Windows build staged at: $BUILD_DIR"
echo ""
echo "To create .msi, run on a Windows machine (or with WiX in CI):"
echo "  candle.exe scripts/windows/edgecoder.wxs -out build/windows/edgecoder.wixobj"
echo "  light.exe build/windows/edgecoder.wixobj -out build/EdgeCoder-${VERSION}-windows-x64.msi"
echo ""
echo "Or with msitools (Linux):"
echo "  wixl scripts/windows/edgecoder.wxs -o build/EdgeCoder-${VERSION}-windows-x64.msi"
echo ""

OUTPUT_MSI="$ROOT_DIR/build/EdgeCoder-${VERSION}-windows-x64.msi"
echo "Expected output: $OUTPUT_MSI"
```

**Step 4: Commit**

```bash
git add scripts/windows/
git commit -m "feat(installer): add Windows MSI build infrastructure and runtime scripts"
```

---

## Task 5: Rewrite the Portal Download Page — Hero + Feature Cards

**Files:**
- Modify: `src/portal/server.ts:5236-5448` (replace the entire `/portal/download` route handler)

This task replaces the route handler with the new page. Due to the size, we split into two steps: first the hero + feature cards + OS detection logic, then the platform wizard cards.

**Step 1: Add the OS detection helper**

Above the route handler (around line 5234), add:

```typescript
function detectOS(userAgent: string): "macos" | "windows" | "linux" | "ios" | "unknown" {
  const ua = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  if (/macintosh|mac os x/.test(ua)) return "macos";
  if (/windows/.test(ua)) return "windows";
  if (/linux|ubuntu|debian/.test(ua)) return "linux";
  return "unknown";
}
```

**Step 2: Replace the route handler opening — hero + feature cards**

Replace the entire `app.get("/portal/download", ...)` handler (lines 5236-5448) with the new implementation. The full handler is large, so the plan provides the complete content section by section. Start with:

```typescript
app.get("/portal/download", async (req, reply) => {
  const GH_RELEASE_BASE = "https://github.com/edgecoder-io/edgecoder/releases/latest/download";
  const GH_RELEASES_PAGE = "https://github.com/edgecoder-io/edgecoder/releases/latest";
  const userAgent = (req.headers["user-agent"] ?? "").toString();
  const detectedOS = detectOS(userAgent);
  const queryToken = (req.query as any)?.token ?? "";

  const content = `
    <style>
      .hero-dl { text-align:center; padding:20px 0 8px; }
      .hero-dl h2 { font-size:22px; margin:0 0 6px; color:var(--text); }
      .hero-dl .subtitle { color:var(--muted); font-size:13px; margin:0 0 4px; }
      .hero-dl .os-badge { display:inline-block; padding:3px 10px; border-radius:999px; font-size:11px; background:rgba(16,185,129,0.12); color:#059669; border:1px solid rgba(16,185,129,0.3); margin-top:6px; }
      .feature-row { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin:12px 0; }
      @media(max-width:920px) { .feature-row { grid-template-columns:repeat(2,1fr); } }
      .feature-card { padding:12px; border-radius:8px; border:1px solid var(--card-border); background:var(--card); }
      .feature-card .fc-icon { font-size:18px; margin-bottom:4px; }
      .feature-card .fc-title { font-size:12px; font-weight:600; color:var(--text); margin-bottom:2px; }
      .feature-card .fc-desc { font-size:11px; color:var(--muted); line-height:1.4; }
      .wizard-card { border:2px solid var(--brand); border-radius:10px; padding:16px; background:var(--card); margin-bottom:10px; position:relative; }
      .wizard-card.secondary { border:1px solid var(--card-border); }
      .rec-badge { position:absolute; top:-10px; left:16px; padding:2px 10px; border-radius:999px; font-size:10px; font-weight:600; background:rgba(16,185,129,0.15); color:#059669; border:1px solid rgba(16,185,129,0.3); }
      .step { display:flex; gap:12px; margin:12px 0; align-items:flex-start; }
      .step-num { flex-shrink:0; width:28px; height:28px; border-radius:50%; background:linear-gradient(140deg,var(--brand),var(--brand-2)); color:white; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; }
      .step-content { flex:1; min-width:0; }
      .step-content h4 { margin:0 0 4px; font-size:13px; color:var(--text); }
      .step-content p { margin:0; font-size:12px; color:var(--muted); line-height:1.5; }
      .dl-btn { display:inline-flex; align-items:center; gap:6px; padding:10px 20px; border-radius:8px; background:linear-gradient(140deg,#2563eb,#1d4ed8); color:white; text-decoration:none; font-size:13px; font-weight:600; border:1px solid rgba(37,99,235,0.75); transition:transform 0.1s; }
      .dl-btn:hover { transform:translateY(-1px); }
      .dl-btn .fmt { font-size:10px; opacity:0.8; font-weight:400; }
      .dl-btn-secondary { display:inline-flex; align-items:center; gap:4px; padding:6px 12px; border-radius:6px; background:var(--card); color:var(--text); text-decoration:none; font-size:11px; border:1px solid var(--card-border); }
      .code-block { position:relative; border:1px dashed rgba(37,99,235,0.42); border-radius:6px; padding:8px 36px 8px 10px; background:rgba(239,246,255,0.08); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; user-select:all; margin:6px 0 0; overflow-x:auto; white-space:pre; color:var(--text); }
      .copy-btn { position:absolute; top:6px; right:6px; padding:2px 6px; border-radius:4px; border:1px solid var(--card-border); background:var(--card); color:var(--muted); font-size:10px; cursor:pointer; }
      .copy-btn:hover { color:var(--text); }
      .toggle-link { color:var(--brand); font-size:12px; cursor:pointer; text-decoration:underline; background:none; border:none; padding:8px 0; display:block; }
      .other-platforms { display:none; }
      .other-platforms.show { display:block; }
      .other-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; margin-top:8px; }
      @media(max-width:920px) { .other-grid { grid-template-columns:1fr; } }
    </style>

    <!-- ── Hero ────────────────────────────────────────────────────────── -->
    <div class="hero-dl">
      <h2>Get EdgeCoder</h2>
      <p class="subtitle">Install the agent. Join the mesh. Earn credits.</p>
      ${detectedOS !== "unknown" ? \`<div class="os-badge">Detected: \${detectedOS === "macos" ? "macOS" : detectedOS === "ios" ? "iOS" : detectedOS === "windows" ? "Windows" : "Linux"}</div>\` : ""}
    </div>

    <!-- ── Feature cards ──────────────────────────────────────────────── -->
    <div class="feature-row">
      <div class="feature-card">
        <div class="fc-icon">&#x1f310;</div>
        <div class="fc-title">P2P Mesh Network</div>
        <div class="fc-desc">Every node is a full peer. Tasks flow through gossip, not a single server.</div>
      </div>
      <div class="feature-card">
        <div class="fc-icon">&#x26a1;</div>
        <div class="fc-title">Earn Credits</div>
        <div class="fc-desc">Contribute compute, earn credits. Use them for AI tasks or transfer them.</div>
      </div>
      <div class="feature-card">
        <div class="fc-icon">&#x1f512;</div>
        <div class="fc-title">Private &amp; Local-First</div>
        <div class="fc-desc">Code never leaves your device unless you choose cloud review.</div>
      </div>
      <div class="feature-card">
        <div class="fc-icon">&#x1f4bb;</div>
        <div class="fc-title">Multi-Platform</div>
        <div class="fc-desc">macOS, Windows, Linux, iOS, VS Code. Run anywhere.</div>
      </div>
    </div>
`;
```

This is the first half. Task 6 continues with the platform-specific wizard cards.

**Step 3: Commit this partial progress**

Don't commit yet — continue to Task 6 which completes the handler.

---

## Task 6: Rewrite the Portal Download Page — Platform Wizard Cards

**Files:**
- Modify: `src/portal/server.ts` (continuing the content string from Task 5)

**Step 1: Define platform card helper functions**

Continue the content string from Task 5. Each platform is a wizard card with 3 steps. The detected OS gets `wizard-card` (primary border), others get `wizard-card secondary`.

Add the platform cards (macOS, Windows, Linux, iOS, VS Code, Docker) as a continuation of the `content` template literal. The detected OS card goes first, others go in the "other platforms" toggle section.

The full implementation uses a helper approach — define each platform as a function, then arrange them based on `detectedOS`:

```typescript
  // --- Platform card builders (inside the route handler) ---

  const tokenPlaceholder = queryToken || "YOUR_TOKEN";
  const tokenNote = queryToken
    ? '<span style="color:#059669;font-size:11px;">Token auto-filled from your Nodes page.</span>'
    : '<span style="font-size:11px;color:var(--muted);">Get your token from <a href="/portal/nodes" style="color:var(--brand);">Nodes page</a> &rarr; Enroll a node &rarr; Copy token.</span>';

  function macosCard(primary: boolean) {
    const cls = primary ? "wizard-card" : "wizard-card secondary";
    const badge = primary ? '<div class="rec-badge">Recommended for you</div>' : "";
    return `
      <div class="${cls}">
        ${badge}
        <h3 style="margin:${primary ? "4px" : "0"} 0 2px;font-size:15px;">macOS</h3>
        <p style="font-size:11px;color:var(--muted);margin:0 0 10px;">Apple Silicon &amp; Intel. Installs a background service that joins the EdgeCoder mesh.</p>
        <div class="step">
          <div class="step-num">1</div>
          <div class="step-content">
            <h4>Download the installer</h4>
            <div style="margin-top:6px;">
              <a href="${GH_RELEASE_BASE}/EdgeCoder-1.0.0-macos-installer.pkg" class="dl-btn">Download for macOS <span class="fmt">.pkg</span></a>
              <a href="${GH_RELEASES_PAGE}" class="dl-btn-secondary" target="_blank" style="margin-left:6px;">All releases</a>
            </div>
          </div>
        </div>
        <div class="step">
          <div class="step-num">2</div>
          <div class="step-content">
            <h4>Run the installer</h4>
            <p>Double-click the <strong>.pkg</strong> file and follow the prompts. It will ask for your password to install the background service.</p>
          </div>
        </div>
        <div class="step">
          <div class="step-num">3</div>
          <div class="step-content">
            <h4>Connect to the network</h4>
            ${tokenNote}
            <div class="code-block" id="mac-cmd">sudo edgecoder --token ${tokenPlaceholder}<button class="copy-btn" onclick="copyCmd('mac-cmd')">Copy</button></div>
            <p style="margin-top:6px;font-size:11px;color:var(--muted);">This saves your token and restarts the service. Your node will appear on the <a href="/portal/nodes" style="color:var(--brand);">Nodes page</a> within a minute.</p>
          </div>
        </div>
      </div>`;
  }

  function windowsCard(primary: boolean) {
    const cls = primary ? "wizard-card" : "wizard-card secondary";
    const badge = primary ? '<div class="rec-badge">Recommended for you</div>' : "";
    return `
      <div class="${cls}">
        ${badge}
        <h3 style="margin:${primary ? "4px" : "0"} 0 2px;font-size:15px;">Windows</h3>
        <p style="font-size:11px;color:var(--muted);margin:0 0 10px;">64-bit Windows 10/11. Installs a Windows Service that joins the EdgeCoder mesh.</p>
        <div class="step">
          <div class="step-num">1</div>
          <div class="step-content">
            <h4>Download the installer</h4>
            <div style="margin-top:6px;">
              <a href="${GH_RELEASE_BASE}/EdgeCoder-1.0.0-windows-x64.msi" class="dl-btn">Download for Windows <span class="fmt">.msi</span></a>
              <a href="${GH_RELEASES_PAGE}" class="dl-btn-secondary" target="_blank" style="margin-left:6px;">All releases</a>
            </div>
          </div>
        </div>
        <div class="step">
          <div class="step-num">2</div>
          <div class="step-content">
            <h4>Run the installer</h4>
            <p>Double-click the <strong>.msi</strong> file. Click <strong>Next</strong> through the wizard. Allow admin access when prompted. The installer sets up a background service automatically.</p>
          </div>
        </div>
        <div class="step">
          <div class="step-num">3</div>
          <div class="step-content">
            <h4>Connect to the network</h4>
            ${tokenNote}
            <p style="font-size:11px;color:var(--muted);margin:4px 0 2px;">Open <strong>PowerShell as Administrator</strong> and run:</p>
            <div class="code-block" id="win-cmd">edgecoder --token ${tokenPlaceholder}<button class="copy-btn" onclick="copyCmd('win-cmd')">Copy</button></div>
            <p style="margin-top:6px;font-size:11px;color:var(--muted);">This saves your token and restarts the service. Your node will appear on the <a href="/portal/nodes" style="color:var(--brand);">Nodes page</a> within a minute.</p>
          </div>
        </div>
      </div>`;
  }

  function linuxCard(primary: boolean) {
    const cls = primary ? "wizard-card" : "wizard-card secondary";
    const badge = primary ? '<div class="rec-badge">Recommended for you</div>' : "";
    return `
      <div class="${cls}">
        ${badge}
        <h3 style="margin:${primary ? "4px" : "0"} 0 2px;font-size:15px;">Linux (Debian / Ubuntu)</h3>
        <p style="font-size:11px;color:var(--muted);margin:0 0 10px;">amd64. Installs a systemd service that joins the EdgeCoder mesh on boot.</p>
        <div class="step">
          <div class="step-num">1</div>
          <div class="step-content">
            <h4>Download the package</h4>
            <div style="margin-top:6px;">
              <a href="${GH_RELEASE_BASE}/EdgeCoder-1.0.0-linux-amd64.deb" class="dl-btn">Download for Linux <span class="fmt">.deb</span></a>
              <a href="${GH_RELEASES_PAGE}" class="dl-btn-secondary" target="_blank" style="margin-left:6px;">All releases</a>
            </div>
          </div>
        </div>
        <div class="step">
          <div class="step-num">2</div>
          <div class="step-content">
            <h4>Install the package</h4>
            <p>Open a terminal and run:</p>
            <div class="code-block" id="linux-install">sudo dpkg -i EdgeCoder-1.0.0-linux-amd64.deb<button class="copy-btn" onclick="copyCmd('linux-install')">Copy</button></div>
          </div>
        </div>
        <div class="step">
          <div class="step-num">3</div>
          <div class="step-content">
            <h4>Connect to the network</h4>
            ${tokenNote}
            <div class="code-block" id="linux-cmd">sudo edgecoder --token ${tokenPlaceholder}<button class="copy-btn" onclick="copyCmd('linux-cmd')">Copy</button></div>
            <p style="margin-top:6px;font-size:11px;color:var(--muted);">This saves your token, enables the service, and starts it. Your node will appear on the <a href="/portal/nodes" style="color:var(--brand);">Nodes page</a> within a minute.</p>
          </div>
        </div>
      </div>`;
  }

  function iosCard(primary: boolean) {
    const cls = primary ? "wizard-card" : "wizard-card secondary";
    const badge = primary ? '<div class="rec-badge">Recommended for you</div>' : "";
    return `
      <div class="${cls}">
        ${badge}
        <h3 style="margin:${primary ? "4px" : "0"} 0 2px;font-size:15px;">iOS (iPhone / iPad)</h3>
        <p style="font-size:11px;color:var(--muted);margin:0 0 10px;">Contribute on-device compute from your phone. Supports internet mesh and Bluetooth local mode.</p>
        <div class="step">
          <div class="step-num">1</div>
          <div class="step-content">
            <h4>Download the app</h4>
            <p>Get <strong>EdgeCoder</strong> from the App Store (or <a href="https://testflight.apple.com/join/edgecoder" style="color:var(--brand);">TestFlight</a> during beta).</p>
          </div>
        </div>
        <div class="step">
          <div class="step-num">2</div>
          <div class="step-content">
            <h4>Sign in</h4>
            <p>Open the app and sign in with your EdgeCoder account (same email you used here).</p>
          </div>
        </div>
        <div class="step">
          <div class="step-num">3</div>
          <div class="step-content">
            <h4>Connect to the network</h4>
            <p>Go to <a href="/portal/nodes" style="color:var(--brand);">Nodes page</a> &rarr; Enroll a node &rarr; Copy token. In the app, go to <strong>Settings</strong> &rarr; paste your token &rarr; tap <strong>Join Network</strong>.</p>
          </div>
        </div>
      </div>`;
  }

  function vscodeCard(primary: boolean) {
    const cls = primary ? "wizard-card" : "wizard-card secondary";
    return `
      <div class="${cls}">
        <h3 style="margin:0 0 2px;font-size:15px;">VS Code Extension</h3>
        <p style="font-size:11px;color:var(--muted);margin:0 0 10px;">Use EdgeCoder directly in your editor. Route code tasks to local AI or the mesh.</p>
        <div class="step">
          <div class="step-num">1</div>
          <div class="step-content">
            <h4>Install the extension</h4>
            <p>Open VS Code and run:</p>
            <div class="code-block" id="vscode-cmd">ext install edgecoder.edgecoder<button class="copy-btn" onclick="copyCmd('vscode-cmd')">Copy</button></div>
            <p style="margin-top:4px;font-size:11px;color:var(--muted);">Or search "EdgeCoder" in the VS Code Extensions panel.</p>
          </div>
        </div>
        <div class="step">
          <div class="step-num">2</div>
          <div class="step-content">
            <h4>Connect</h4>
            <p>Open Command Palette (<code>Cmd+Shift+P</code>) &rarr; <strong>EdgeCoder: Configure</strong>. The extension connects to your local EdgeCoder agent automatically.</p>
          </div>
        </div>
      </div>`;
  }

  function dockerCard() {
    return `
      <div class="wizard-card secondary">
        <h3 style="margin:0 0 2px;font-size:15px;">Docker</h3>
        <p style="font-size:11px;color:var(--muted);margin:0 0 10px;">Run EdgeCoder in a container. For advanced users and CI/CD.</p>
        <div class="code-block" id="docker-cmd">docker run -d --restart unless-stopped \\
  --name edgecoder \\
  -e AGENT_REGISTRATION_TOKEN=${tokenPlaceholder} \\
  -e COORDINATOR_URL=https://coordinator.edgecoder.io \\
  ghcr.io/edgecoder-io/edgecoder:latest<button class="copy-btn" onclick="copyCmd('docker-cmd')">Copy</button></div>
      </div>`;
  }
```

**Step 2: Arrange cards by detected OS and close the handler**

```typescript
  // Build the platform order: detected OS first, others in "other platforms"
  const allPlatforms = ["macos", "windows", "linux", "ios"] as const;
  const cardBuilders: Record<string, (primary: boolean) => string> = {
    macos: macosCard,
    windows: windowsCard,
    linux: linuxCard,
    ios: iosCard,
  };

  const primaryOS = detectedOS !== "unknown" ? detectedOS : "macos";
  const primaryCard = cardBuilders[primaryOS](true);

  const otherCards = allPlatforms
    .filter(os => os !== primaryOS)
    .map(os => cardBuilders[os](false))
    .join("\n");

  const platformSection = `
    <!-- ── Primary platform ──────────────────────────────────────────── -->
    ${primaryCard}

    <!-- ── Other platforms toggle ─────────────────────────────────────── -->
    <button class="toggle-link" onclick="document.getElementById('other-platforms').classList.toggle('show');this.textContent=this.textContent.includes('Show')?'Hide other platforms':'Show other platforms';">Show other platforms</button>
    <div id="other-platforms" class="other-platforms">
      <div class="other-grid">
        ${otherCards}
        ${vscodeCard(false)}
      </div>
      <div style="margin-top:10px;">
        ${dockerCard()}
      </div>
    </div>
  `;

  const fullContent = content + platformSection;

  const script = `
    requireAuth().catch(() => {});
    function copyCmd(id) {
      const el = document.getElementById(id);
      if (!el) return;
      const text = el.textContent.replace(/Copy$/, '').trim();
      navigator.clipboard.writeText(text).then(() => {
        const btn = el.querySelector('.copy-btn');
        if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 2000); }
      });
    }
    // Auto-fill token from query param
    ${queryToken ? `
    document.querySelectorAll('.code-block').forEach(el => {
      el.childNodes.forEach(n => {
        if (n.nodeType === 3 && n.textContent.includes('YOUR_TOKEN')) {
          n.textContent = n.textContent.replace('YOUR_TOKEN', '${queryToken}');
        }
      });
    });
    ` : ""}
  `;
  return reply.type("text/html").send(portalAuthedPageHtml({
    title: "EdgeCoder Portal | Get EdgeCoder",
    activeTab: "download",
    heading: "Get EdgeCoder",
    subtitle: "Install the agent, join the mesh, start contributing.",
    content: fullContent,
    script
  }));
});
```

**Step 3: Run the portal locally to verify**

```bash
cd /Users/codysmith/Cursor/Edgecoder
npm run dev
# Open http://localhost:4310/portal/download in browser
# Verify: OS detection badge, feature cards, wizard steps, copy buttons, "other platforms" toggle
```

**Step 4: Commit**

```bash
git add src/portal/server.ts
git commit -m "feat(portal): redesign download page with OS detection, guided wizard, and feature cards"
```

---

## Task 7: Update Portal Navigation Labels

**Files:**
- Modify: `src/portal/server.ts:3551` (nav link label)
- Modify: `src/portal/server.ts:5444` (subtitle)

**Step 1: Update nav link**

Change the "Download" nav label to "Get EdgeCoder":

In line 3551, change:
```
${navLink("download", "Download", "/portal/download")}
```
to:
```
${navLink("download", "Get EdgeCoder", "/portal/download")}
```

**Step 2: Commit**

```bash
git add src/portal/server.ts
git commit -m "feat(portal): rename Download nav link to 'Get EdgeCoder'"
```

---

## Task 8: Add Portal Download Page Test

**Files:**
- Create: `tests/portal/download-page.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect } from "vitest";
import { detectOS } from "../../src/portal/server.js";

// Note: detectOS must be exported from server.ts for testing.
// If it cannot be exported (monolithic file), test via HTTP response content instead.

describe("detectOS", () => {
  it("detects macOS from Safari User-Agent", () => {
    expect(detectOS("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")).toBe("macos");
  });

  it("detects Windows from Chrome User-Agent", () => {
    expect(detectOS("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")).toBe("windows");
  });

  it("detects Linux from Firefox User-Agent", () => {
    expect(detectOS("Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/120.0")).toBe("linux");
  });

  it("detects iOS from iPhone User-Agent", () => {
    expect(detectOS("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15")).toBe("ios");
  });

  it("returns unknown for empty User-Agent", () => {
    expect(detectOS("")).toBe("unknown");
  });

  it("returns unknown for bot User-Agent", () => {
    expect(detectOS("Googlebot/2.1")).toBe("unknown");
  });
});
```

**Step 2: Export detectOS from server.ts**

At the top of `src/portal/server.ts`, change `detectOS` to be exported:

```typescript
export function detectOS(userAgent: string): "macos" | "windows" | "linux" | "ios" | "unknown" {
```

**Step 3: Run the test**

```bash
npx vitest run tests/portal/download-page.test.ts
```

Expected: 6 tests pass.

**Step 4: Commit**

```bash
git add tests/portal/download-page.test.ts src/portal/server.ts
git commit -m "test(portal): add OS detection unit tests for download page"
```

---

## Task 9: Add `build:windows-msi` npm Script

**Files:**
- Modify: `package.json` (add build script)

**Step 1: Add the script**

In `package.json`, in the `"scripts"` section, add:

```json
"build:windows-msi": "bash scripts/windows/build-msi.sh"
```

**Step 2: Commit**

```bash
git add package.json
git commit -m "feat(build): add build:windows-msi npm script"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | macOS configure `--token` flag | `scripts/macos/payload/bin/edgecoder-configure.sh` |
| 2 | Linux configure script | `scripts/linux/payload/bin/edgecoder-configure.sh`, `build-deb.sh`, `postinst` |
| 3 | Windows configure PowerShell | `scripts/windows/payload/bin/edgecoder-configure.ps1` |
| 4 | Windows MSI build infra | `scripts/windows/build-msi.sh`, `edgecoder.wxs`, runtime scripts |
| 5-6 | Portal download page rewrite | `src/portal/server.ts` (one route handler) |
| 7 | Nav label update | `src/portal/server.ts` (one line) |
| 8 | OS detection tests | `tests/portal/download-page.test.ts` |
| 9 | npm build script | `package.json` |
