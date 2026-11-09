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
# The service may run as LocalSystem, so the file is only read when Administrators or SYSTEM own
# it (ProgramData lets any user create files that they then own), and keys that change which
# program runs or how node loads code are never taken from it.
$DeniedKeys = @('NODE_BIN', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'PATH', 'PATHEXT',
    'COMSPEC', 'PSMODULEPATH', 'SYSTEMROOT', 'WINDIR', 'PROGRAMFILES', 'PROGRAMDATA', 'APPDATA',
    'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'EDGECODER_ENV_FILE')
if (Test-Path -LiteralPath $EnvFile) {
    $owner = (Get-Acl -LiteralPath $EnvFile).GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -ne 'S-1-5-32-544' -and $owner -ne 'S-1-5-18') {
        Write-Error "$EnvFile is owned by $owner, not Administrators or SYSTEM; refusing to load it. Re-run edgecoder-configure.ps1 from an elevated prompt."
        exit 1
    }
    Get-Content -LiteralPath $EnvFile | ForEach-Object {
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
                if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$' -or $DeniedKeys -contains $key.ToUpperInvariant()) {
                    Write-Warning "Ignoring $key from $EnvFile"
                } else {
                    [Environment]::SetEnvironmentVariable($key, $value, 'Process')
                }
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Resolve Node.js binary
# ---------------------------------------------------------------------------
function Resolve-NodeBin {
    # Only admin-only install locations: not NODE_BIN, PATH, or per-user installs (nvm, fnm),
    # which a standard user can replace while the service runs with more rights.
    $candidates = @(
        (Join-Path $InstallDir 'node\node.exe'),
        (Join-Path $env:ProgramFiles 'nodejs\node.exe')
    )
    foreach ($path in $candidates) {
        if (Test-Path -LiteralPath $path) { return $path }
    }
    return $null
}

$NodeBin = Resolve-NodeBin
if (-not $NodeBin) {
    Write-Error "node binary not found. Install Node.js 22+ from nodejs.org (Program Files\nodejs) or run install.ps1."
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
