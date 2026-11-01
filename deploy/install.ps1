#Requires -RunAsAdministrator
<#
.SYNOPSIS
    EdgeCoder one-line installer for Windows (docs/install.md).

.DESCRIPTION
    irm https://edgecoder.io/install.ps1 | iex            (then: edgecoder-install apply ...)
    or:  powershell -ExecutionPolicy Bypass -File install.ps1 -- --mesh-token <token> [options]

    Installs Node 22, Ollama and checks Docker Desktop, builds EdgeCoder into
    C:\Program Files\EdgeCoder\app, then hands every option to the shared installer
    (edgecoder-install apply), which detects the hardware and creates one agent per GPU.
    deploy/install.sh (Linux, macOS) and the .pkg/.deb/.msi packages run the same
    edgecoder-install, so the options are identical everywhere (--help lists them).
#>
param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $InstallerArgs = @())

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoUrl    = if ($env:EDGECODER_REPO_URL) { $env:EDGECODER_REPO_URL } else { 'https://github.com/codyrs82/Edgecoder.git' }
$RepoRef    = if ($env:EDGECODER_REPO_REF) { $env:EDGECODER_REPO_REF } else { 'main' }
$InstallDir = if ($env:EDGECODER_INSTALL_DIR) { $env:EDGECODER_INSTALL_DIR } else { "$env:ProgramFiles\EdgeCoder\app" }

function Log($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Winget($id) {
    if (-not (Have 'winget')) { throw "winget is required to install $id (install App Installer from the Microsoft Store)" }
    winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements | Out-Null
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

# ----------------------------------------------------------------- Node ----
$needNode = $true
if (Have 'node') { $major = [int](node -p 'process.versions.node.split(".")[0]'); if ($major -ge 22) { $needNode = $false } }
if ($needNode) { Log 'Installing Node.js 22'; Winget 'OpenJS.NodeJS.LTS' }
if (-not (Have 'git')) { Log 'Installing Git'; Winget 'Git.Git' }

# --------------------------------------------------------------- Ollama ----
if (-not (Have 'ollama') -and -not (Test-Path "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe")) { Log 'Installing Ollama'; Winget 'Ollama.Ollama' }

# --------------------------------------------------------------- Docker ----
if (-not (Have 'docker')) {
    Log 'Docker Desktop is not installed'
    Write-Host 'Swarm tasks run in Docker sandboxes; without it the agent registers but takes no work.'
    Write-Host 'Install from https://www.docker.com/products/docker-desktop/ (WSL 2 backend), enable "Start at login", then re-run this installer.'
}

# ---------------------------------------------------------------- build ----
Log "EdgeCoder source -> $InstallDir ($RepoRef)"
if (Test-Path (Join-Path $InstallDir '.git')) {
    git -C $InstallDir fetch -q --all --tags; git -C $InstallDir checkout -q $RepoRef; git -C $InstallDir pull -q --ff-only
} else {
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir) | Out-Null
    git clone -q --branch $RepoRef $RepoUrl $InstallDir
}
Push-Location $InstallDir
try { npm ci --no-audit --no-fund --loglevel=error; npm run build --silent } finally { Pop-Location }

# Make `edgecoder-install` available in every shell.
$binDir = "$env:ProgramFiles\EdgeCoder\bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Set-Content -Path (Join-Path $binDir 'edgecoder-install.cmd') -Value "@echo off`r`nnode `"$InstallDir\dist\install\cli.js`" %*`r`n"
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
if ($machinePath -notlike "*$binDir*") { [Environment]::SetEnvironmentVariable('Path', "$machinePath;$binDir", 'Machine') }

Log 'Installer'
& node "$InstallDir\dist\install\cli.js" apply --app-dir $InstallDir @InstallerArgs
exit $LASTEXITCODE
