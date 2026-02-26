#Requires -Version 5.1
<#
.SYNOPSIS
    Installs Ollama and pulls a default model for EdgeCoder (Windows).

.DESCRIPTION
    Best-effort script that:
    1. Checks whether Ollama is already installed (Program Files + PATH).
    2. Downloads and runs the Ollama installer if not present.
    3. Starts the Ollama service / process.
    4. Pulls the default coding model.

    The script never causes the parent installer to fail; all errors are
    caught and reported as warnings.

.NOTES
    Environment variable OLLAMA_MODEL overrides the default model name.
#>

# Do not use strict-mode Stop here: the entire script is best-effort.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$DefaultModel   = if ($env:OLLAMA_MODEL) { $env:OLLAMA_MODEL } else { 'qwen2.5-coder:1.5b' }
$OllamaExeName  = 'ollama.exe'
$InstallerUrl    = 'https://ollama.com/download/OllamaSetup.exe'
$InstallerPath   = Join-Path $env:TEMP 'OllamaSetup.exe'
$OllamaEndpoint  = 'http://127.0.0.1:11434/api/tags'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Find-Ollama {
    <#
    .SYNOPSIS
        Locate the ollama.exe binary. Returns $null if not found.
    #>

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
        Write-Host "Downloading Ollama installer from $InstallerUrl ..."
        try {
            # Use BITS or Invoke-WebRequest
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $InstallerUrl -OutFile $InstallerPath -UseBasicParsing -ErrorAction Stop
        } catch {
            Write-Host "Warning: could not download Ollama installer: $_"
            Write-Host "Install Ollama manually from https://ollama.com/download"
            exit 0
        }

        Write-Host 'Running Ollama installer (silent)...'
        try {
            $proc = Start-Process -FilePath $InstallerPath -ArgumentList '/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES' `
                                  -Wait -PassThru -ErrorAction Stop
            if ($proc.ExitCode -ne 0) {
                Write-Host "Warning: Ollama installer exited with code $($proc.ExitCode)."
            }
        } catch {
            Write-Host "Warning: Ollama installer failed: $_"
            Write-Host "Install Ollama manually from https://ollama.com/download"
            exit 0
        } finally {
            Remove-Item -Path $InstallerPath -Force -ErrorAction SilentlyContinue
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
