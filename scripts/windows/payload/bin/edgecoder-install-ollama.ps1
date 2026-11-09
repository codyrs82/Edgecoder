#Requires -Version 5.1
<#
.SYNOPSIS
    Installs Ollama and pulls a default model for EdgeCoder (Windows).

.DESCRIPTION
    Best-effort script that:
    1. Checks whether Ollama is already installed (Program Files + PATH).
    2. If not present, downloads the official release zip of a pinned version, checks its
       SHA-256 (the same pin as src/install/ollama-pins.ts and deploy/install.ps1) and unpacks
       it into Program Files\Ollama. Nothing unverified is ever run.
    3. Starts the Ollama process and pulls the default coding model, but only when not
       elevated: an elevated run (the MSI runs this as SYSTEM) installs the binary and stops,
       so Ollama never serves as SYSTEM or an administrator.

    The script never causes the parent installer to fail; all errors are
    caught and reported as warnings.

.NOTES
    Environment variable OLLAMA_MODEL overrides the default model name.
#>

# Do not use strict-mode Stop here: the entire script is best-effort.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$DefaultModel   = if ($env:OLLAMA_MODEL) { $env:OLLAMA_MODEL } else { 'qwen3.5:9b' }
$OllamaExeName  = 'ollama.exe'
# Pinned release (source of truth: src/install/ollama-pins.ts, win-x64).
$OllamaVersion   = '0.40.7'
$OllamaZip       = 'ollama-windows-amd64.zip'
$OllamaSha256    = 'e6527768c53e85ec4596495fb0f035ef07f437b4b591ebc3581684699a4668f4'
$OllamaUrl       = "https://github.com/ollama/ollama/releases/download/v$OllamaVersion/$OllamaZip"
$OllamaDir       = Join-Path $env:ProgramFiles 'Ollama'
$IsElevated      = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$OllamaEndpoint  = 'http://127.0.0.1:11434/api/tags'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Find-Ollama {
    <#
    .SYNOPSIS
        Locate the ollama.exe binary. Returns $null if not found.
    #>

    # Elevated, only the admin-only Program Files copy: PATH and the user profile hold binaries a
    # standard user can replace.
    if ($IsElevated) {
        $pf = Join-Path $OllamaDir $OllamaExeName
        if (Test-Path -LiteralPath $pf) { return $pf }
        return $null
    }

    # 1. Check PATH
    $onPath = Get-Command $OllamaExeName -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    # 2. Well-known install locations
    $candidates = @(
        "$env:ProgramFiles\Ollama\$OllamaExeName",
        "${env:ProgramFiles(x86)}\Ollama\$OllamaExeName",
        "$env:LOCALAPPDATA\Programs\Ollama\$OllamaExeName",
        "$env:LOCALAPPDATA\Ollama\$OllamaExeName"
    )

    foreach ($path in $candidates) {
        if (Test-Path $path) { return $path }
    }

    return $null
}

function Wait-ForOllama {
    <#
    .SYNOPSIS
        Wait up to $Seconds for Ollama to respond on its HTTP endpoint.
    #>
    param([int]$Seconds = 15)

    for ($i = 1; $i -le $Seconds; $i++) {
        try {
            $null = Invoke-RestMethod -Uri $OllamaEndpoint -Method Get -TimeoutSec 2 -ErrorAction Stop
            return $true
        } catch {
            # not ready yet
        }
        if ($i -eq 1) {
            Write-Host 'Waiting for Ollama to be ready...'
        }
        Start-Sleep -Seconds 1
    }
    return $false
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

try {

    # --- Locate or install Ollama -------------------------------------------
    $ollamaPath = Find-Ollama

    if ($ollamaPath) {
        Write-Host "Ollama already installed at: $ollamaPath"
    } else {
        Write-Host "Installing Ollama $OllamaVersion (official release zip, pinned SHA-256) into $OllamaDir ..."
        if (-not $IsElevated) {
            Write-Host "Installing into $OllamaDir needs an elevated prompt; install Ollama manually from https://github.com/ollama/ollama/releases"
            exit 0
        }
        # A fresh, randomly named directory: nothing another user planted is read, and the zip is
        # only unpacked after its hash matches.
        $tmp = Join-Path ([IO.Path]::GetTempPath()) ('edgecoder-ollama-' + [Guid]::NewGuid().ToString('N'))
        try {
            New-Item -ItemType Directory -Path $tmp -ErrorAction Stop | Out-Null
            $zip = Join-Path $tmp $OllamaZip
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $OllamaUrl -OutFile $zip -UseBasicParsing -ErrorAction Stop
            $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
            if ($got -ne $OllamaSha256) { throw "checksum mismatch for $OllamaZip (expected $OllamaSha256, got $got); not installing it" }
            New-Item -ItemType Directory -Force -Path $OllamaDir -ErrorAction Stop | Out-Null
            Expand-Archive -LiteralPath $zip -DestinationPath $OllamaDir -Force -ErrorAction Stop
        } catch {
            Write-Host "Warning: could not install Ollama: $_"
            Write-Host 'Install Ollama manually from https://github.com/ollama/ollama/releases'
            exit 0
        } finally {
            Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
        }

        # Refresh PATH for this session so we can find the newly installed binary
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                    [System.Environment]::GetEnvironmentVariable('Path', 'User')

        $ollamaPath = Find-Ollama
        if ($ollamaPath) {
            Write-Host "Ollama installed at: $ollamaPath"
        } else {
            Write-Host 'Warning: Ollama was installed but could not be located on PATH.'
            Write-Host 'Install Ollama manually from https://ollama.com/download if needed.'
            exit 0
        }
    }

    # --- Start Ollama -------------------------------------------------------
    if ($IsElevated) {
        # Never serve as SYSTEM/administrator. edgecoder-install runs Ollama per user at logon.
        Write-Host 'Ollama is installed. It runs as the user (edgecoder-install apply); the model is pulled on first use.'
        exit 0
    }
    # Try the Windows service first, then fall back to starting the process
    $svc = Get-Service -Name 'ollama' -ErrorAction SilentlyContinue
    if ($svc) {
        if ($svc.Status -ne 'Running') {
            Write-Host 'Starting Ollama Windows service...'
            Start-Service -Name 'ollama' -ErrorAction SilentlyContinue
        }
    } else {
        # No service; start ollama serve in the background
        if (-not (Wait-ForOllama -Seconds 2)) {
            Write-Host 'Starting Ollama serve process...'
            Start-Process -FilePath $ollamaPath -ArgumentList 'serve' `
                          -WindowStyle Hidden -ErrorAction SilentlyContinue
        }
    }

    # --- Pull default model -------------------------------------------------
    Write-Host "Pulling default model: $DefaultModel ..."

    if (Wait-ForOllama -Seconds 15) {
        try {
            $pullProc = Start-Process -FilePath $ollamaPath -ArgumentList 'pull', $DefaultModel `
                                      -NoNewWindow -Wait -PassThru -ErrorAction Stop
            if ($pullProc.ExitCode -eq 0) {
                Write-Host "Model $DefaultModel pulled successfully."
            } else {
                Write-Host "Warning: could not pull $DefaultModel. It will be pulled on first use."
            }
        } catch {
            Write-Host "Warning: could not pull $DefaultModel. It will be pulled on first use."
        }
    } else {
        Write-Host 'Warning: Ollama not responding. Model will be pulled on first use.'
    }

} catch {
    Write-Host "Warning: Ollama auto-install encountered an error: $_"
    Write-Host 'Ollama can be installed manually from https://ollama.com/download'
}

exit 0
