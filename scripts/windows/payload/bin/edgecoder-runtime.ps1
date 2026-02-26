#Requires -Version 5.1
<#
.SYNOPSIS
    EdgeCoder runtime launcher for Windows.

.DESCRIPTION
    Reads configuration from the EdgeCoder environment file, resolves the
    Node.js binary, and launches the appropriate entry point based on
    EDGE_RUNTIME_MODE.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$InstallDir = "$env:ProgramFiles\EdgeCoder"
$AppDir     = Join-Path $InstallDir 'app'
$ConfigDir  = "$env:APPDATA\EdgeCoder"
$LogDir     = "$env:LOCALAPPDATA\EdgeCoder\logs"
$EnvFile    = if ($env:EDGECODER_ENV_FILE) { $env:EDGECODER_ENV_FILE } else { 'C:\ProgramData\EdgeCoder\edgecoder.env' }

# ---------------------------------------------------------------------------
# Ensure runtime directories exist
# ---------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir    | Out-Null

# ---------------------------------------------------------------------------
# Load environment variables from env file
# ---------------------------------------------------------------------------
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#')) {
            $eqIndex = $line.IndexOf('=')
            if ($eqIndex -gt 0) {
                $key   = $line.Substring(0, $eqIndex).Trim()
                $value = $line.Substring($eqIndex + 1).Trim()
                # Strip surrounding quotes if present
                if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
                    ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                    $value = $value.Substring(1, $value.Length - 2)
                }
                [Environment]::SetEnvironmentVariable($key, $value, 'Process')
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Resolve Node.js binary
# ---------------------------------------------------------------------------
function Resolve-NodeBin {
    # 1. Explicit NODE_BIN env var
    if ($env:NODE_BIN -and (Test-Path $env:NODE_BIN)) {
        return $env:NODE_BIN
    }

    # 2. node on PATH
    $onPath = Get-Command node -ErrorAction SilentlyContinue
    if ($onPath) {
        return $onPath.Source
    }

    # 3. Common install locations
    $candidates = @(
        'C:\Program Files\nodejs\node.exe',
        'C:\Program Files (x86)\nodejs\node.exe',
        "$env:LOCALAPPDATA\fnm\node-versions\*\installation\node.exe",
        "$env:APPDATA\nvm\*\node.exe"
    )

    foreach ($pattern in $candidates) {
        $found = Get-Item $pattern -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1
        if ($found) {
            return $found.FullName
        }
    }

    return $null
}

$NodeBin = Resolve-NodeBin
if (-not $NodeBin) {
    Write-Error "node binary not found. Install Node.js 20+ and set NODE_BIN in $EnvFile."
    exit 1
}

if (-not (Test-Path $AppDir)) {
    Write-Error "EdgeCoder app directory not found at $AppDir"
    exit 1
}

Set-Location $AppDir

# ---------------------------------------------------------------------------
# Resolve mode and launch
# ---------------------------------------------------------------------------
$Mode = if ($env:EDGE_RUNTIME_MODE) { $env:EDGE_RUNTIME_MODE } else { 'worker' }

$entryPoints = @{
    'worker'        = 'dist\swarm\worker-runner.js'
    'all-in-one'    = 'dist\index.js'
    'coordinator'   = 'dist\swarm\coordinator.js'
    'control-plane' = 'dist\control-plane\server.js'
    'inference'     = 'dist\inference\service.js'
    'ide-provider'  = 'dist\apps\ide\provider-server.js'
}

if (-not $entryPoints.ContainsKey($Mode)) {
    Write-Error "Unsupported EDGE_RUNTIME_MODE: $Mode"
    exit 1
}

$entryPoint = $entryPoints[$Mode]

# ---------------------------------------------------------------------------
# Export platform directories for the Node.js runtime
# ---------------------------------------------------------------------------
$env:NODE_ENV = 'production'
if (-not $env:EDGECODER_CONFIG_DIR) { $env:EDGECODER_CONFIG_DIR = $ConfigDir }
if (-not $env:EDGECODER_LOG_DIR)    { $env:EDGECODER_LOG_DIR    = $LogDir }

# ---------------------------------------------------------------------------
# Launch with log tee
# ---------------------------------------------------------------------------
$logFile = Join-Path $LogDir 'runtime.log'
& $NodeBin $entryPoint 2>&1 | Tee-Object -FilePath $logFile -Append
exit $LASTEXITCODE
