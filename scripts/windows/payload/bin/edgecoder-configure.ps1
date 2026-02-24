#Requires -RunAsAdministrator
<#
.SYNOPSIS
    EdgeCoder Windows environment configuration script.

.DESCRIPTION
    Configures C:\ProgramData\EdgeCoder\edgecoder.env for the EdgeCoder
    Windows service. Supports a non-interactive --token quick-connect
    mode (intended for copy-paste from the portal download page) and an
    interactive wizard fallback.

.PARAMETER Command
    Positional sub-command. Accepted values: "configure", "help".

.PARAMETER Token
    Registration token for non-interactive quick-connect mode.
    Equivalent to: edgecoder --token YOUR_TOKEN

.EXAMPLE
    # Non-interactive quick-connect
    edgecoder --token YOUR_TOKEN
    edgecoder configure --token YOUR_TOKEN

.EXAMPLE
    # Interactive wizard
    edgecoder configure

.EXAMPLE
    # Show help
    edgecoder --help
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command,

    [Parameter()]
    [string]$Token
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
$EnvDir  = 'C:\ProgramData\EdgeCoder'
$EnvFile = Join-Path $EnvDir 'edgecoder.env'
$ServiceName = 'EdgeCoder'
$CoordinatorUrl = 'https://coordinator.edgecoder.io'
$PortalNodesUrl = 'https://portal.edgecoder.io/portal/nodes'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Show-Help {
    $helpText = @"
EdgeCoder environment setup wizard.

Usage:
  edgecoder configure                         # interactive wizard
  edgecoder --token YOUR_TOKEN                # quick-connect
  edgecoder configure --token YOUR_TOKEN      # quick-connect (alternate)

Options:
  --token TOKEN   Configure this node as a worker with the given registration
                  token and restart the service. Non-interactive; intended for
                  copy-paste from the portal download page.
  --help          Show this help message.
  help            Show this help message.
"@
    Write-Host $helpText
}

function Write-OrUpdateEnv {
    <#
    .SYNOPSIS
        Upsert a KEY=VALUE pair in the env file.
    .DESCRIPTION
        If the key already exists (commented or not), the line is replaced.
        Otherwise the pair is appended.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$File,
        [Parameter(Mandatory)][string]$Key,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Value
    )

    $line = "${Key}=${Value}"

    if (-not (Test-Path $File)) {
        # File does not exist yet; create with this single line.
        Set-Content -Path $File -Value $line -Encoding UTF8
        return
    }

    $content = Get-Content -Path $File -Encoding UTF8
    $pattern = "^#?${Key}="
    $replaced = $false
    $newContent = @()

    foreach ($existing in $content) {
        if ($existing -match $pattern) {
            $newContent += $line
            $replaced = $true
        } else {
            $newContent += $existing
        }
    }

    if (-not $replaced) {
        $newContent += $line
    }

    Set-Content -Path $File -Value $newContent -Encoding UTF8
}

function Invoke-TokenQuickConnect {
    <#
    .SYNOPSIS
        Non-interactive quick-connect using a registration token.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$TokenValue
    )

    if ([string]::IsNullOrWhiteSpace($TokenValue)) {
        Write-Error "Error: --token requires a non-empty TOKEN argument."
        Write-Host ''
        Write-Host 'Usage:'
        Write-Host '  edgecoder --token YOUR_TOKEN'
        exit 1
    }

    # 1. Ensure config directory exists
    if (-not (Test-Path $EnvDir)) {
        New-Item -ItemType Directory -Path $EnvDir -Force | Out-Null
    }

    # 2. Back up existing config
    if (Test-Path $EnvFile) {
        $timestamp = Get-Date -Format 'yyyyMMddHHmmss'
        $backupPath = "${EnvFile}.bak.${timestamp}"
        Copy-Item -Path $EnvFile -Destination $backupPath -Force
        Write-Host "Backed up existing config to $backupPath"
    }
    else {
        # Seed a minimal file so Write-OrUpdateEnv has something to work with
        New-Item -ItemType File -Path $EnvFile -Force | Out-Null
    }

    # 3. Write the quick-connect values
    Write-OrUpdateEnv -File $EnvFile -Key 'AGENT_REGISTRATION_TOKEN' -Value $TokenValue
    Write-OrUpdateEnv -File $EnvFile -Key 'EDGE_RUNTIME_MODE'        -Value 'worker'
    Write-OrUpdateEnv -File $EnvFile -Key 'COORDINATOR_URL'           -Value $CoordinatorUrl
    Write-OrUpdateEnv -File $EnvFile -Key 'AGENT_OS'                  -Value 'windows'

    # 4. Summary
    $truncatedToken = if ($TokenValue.Length -gt 12) {
        "$($TokenValue.Substring(0, 8))...$($TokenValue.Substring($TokenValue.Length - 4))"
    } else {
        '****'
    }

    Write-Host ''
    Write-Host 'EdgeCoder quick-connect configured successfully!'
    Write-Host ''
    Write-Host "  Config file : $EnvFile"
    Write-Host '  Mode        : worker'
    Write-Host "  Coordinator : $CoordinatorUrl"
    Write-Host "  Token       : $truncatedToken (truncated)"
    Write-Host ''

    # 5. Restart or advise
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -ne $svc) {
        Write-Host 'Restarting EdgeCoder service...'
        Restart-Service -Name $ServiceName -Force
        Write-Host 'Service restarted.'
    }
    else {
        Write-Host "EdgeCoder Windows service ('$ServiceName') is not installed yet."
        Write-Host 'Install and start it, then the new configuration will be picked up.'
    }

    Write-Host ''
    Write-Host "View your nodes at: $PortalNodesUrl"
}

function Invoke-InteractiveWizard {
    <#
    .SYNOPSIS
        Interactive wizard that prompts for a registration token.
    #>

    # Check for interactive terminal
    if (-not [Environment]::UserInteractive) {
        Write-Host 'No interactive terminal detected.'
        Write-Host 'Run this from a terminal, for example:'
        Write-Host '  edgecoder configure'
        exit 1
    }

    Write-Host ''
    Write-Host 'EdgeCoder Windows setup wizard'
    Write-Host "This configures $EnvFile for the EdgeCoder Windows service."
    Write-Host ''

    # Check for existing config
    if (Test-Path $EnvFile) {
        $overwrite = Read-Host 'Existing config found. Overwrite it? [no]'
        if ([string]::IsNullOrWhiteSpace($overwrite)) { $overwrite = 'no' }
        $overwrite = $overwrite.ToLower()
        if ($overwrite -eq 'y') { $overwrite = 'yes' }

        if ($overwrite -ne 'yes') {
            Write-Host "Keeping existing config: $EnvFile"
            return
        }
    }

    Write-Host ''
    Write-Host 'To quick-connect, paste the registration token from the portal.'
    Write-Host 'Get yours at: https://portal.edgecoder.io/portal'
    Write-Host ''

    $inputToken = Read-Host 'AGENT_REGISTRATION_TOKEN'

    if ([string]::IsNullOrWhiteSpace($inputToken)) {
        Write-Host ''
        Write-Host 'No token entered. You can re-run with:'
        Write-Host '  edgecoder --token YOUR_TOKEN'
        Write-Host "Or edit the config file directly: $EnvFile"
        return
    }

    Invoke-TokenQuickConnect -TokenValue $inputToken
}

# ---------------------------------------------------------------------------
# Main dispatch
# ---------------------------------------------------------------------------

# Handle --help / help
if ($Command -eq '--help' -or $Command -eq 'help') {
    Show-Help
    exit 0
}

# Handle --token (with or without "configure" sub-command)
if (-not [string]::IsNullOrWhiteSpace($Token)) {
    Invoke-TokenQuickConnect -TokenValue $Token
    exit 0
}

# If the bare command is "configure" with no --token, run interactive wizard
if ([string]::IsNullOrWhiteSpace($Command) -or $Command -eq 'configure') {
    Invoke-InteractiveWizard
    exit 0
}

# Unknown command
Write-Host "Unknown command: $Command" -ForegroundColor Red
Write-Host ''
Show-Help
exit 1
