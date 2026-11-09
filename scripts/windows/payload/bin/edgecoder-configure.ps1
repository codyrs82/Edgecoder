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
    [string]$Token,

    # A file holding the token (first line), so it is not on the command line.
    [Parameter()]
    [string]$TokenFile
)

Set-StrictMode -Version Latest

# Shared installer (same options on macOS, Linux and Windows): `edgecoder install <args>` and
# `edgecoder-install <args>` both run dist\install\cli.js, which detects GPUs and creates one
# agent + Ollama task per GPU.
if ($args.Count -gt 0 -and ($args[0] -eq 'install' -or $args[0] -eq 'detect' -or $args[0] -eq 'plan' -or $args[0] -eq 'apply' -or $args[0] -eq 'status' -or $args[0] -eq 'remove')) {
    $cli = Join-Path $env:ProgramFiles 'EdgeCoder\app\dist\install\cli.js'
    $rest = if ($args[0] -eq 'install') { $args[1..($args.Count - 1)] } else { $args }
    # Elevated: never `node` from PATH, which may resolve to a binary a standard user can replace.
    $node = @((Join-Path $env:ProgramFiles 'EdgeCoder\node\node.exe'), (Join-Path $env:ProgramFiles 'nodejs\node.exe')) |
        Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $node) { Write-Error 'Node.js not found in Program Files; run install.ps1 or install Node.js 22+ from nodejs.org.'; exit 1 }
    & $node $cli @rest
    exit $LASTEXITCODE
}
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
$EnvDir  = 'C:\ProgramData\EdgeCoder'
$EnvFile = Join-Path $EnvDir 'edgecoder.env'
$ServiceName = 'EdgeCoder'
$CoordinatorUrl = 'https://coordinator.edgecoder.io'
$PortalNodesUrl = 'https://portal.edgecoder.io/portal/nodes'
$OllamaInstaller = Join-Path $PSScriptRoot 'edgecoder-install-ollama.ps1'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Invoke-OllamaInstall {
    <#
    .SYNOPSIS
        Run the Ollama install script (best-effort, non-fatal).
    #>
    if (Test-Path $OllamaInstaller) {
        Write-Host ''
        Write-Host 'Bootstrapping Ollama (best-effort)...'
        try {
            & $OllamaInstaller
        } catch {
            Write-Host "Warning: Ollama auto-install encountered an error: $_"
        }
    }
}

function Set-FirewallRules {
    <#
    .SYNOPSIS
        Remove the inbound 'EdgeCoder Runtime' rule (TCP 4301-4310) older versions created.
        The worker only makes outbound connections, so no inbound port is opened.
    #>
    $ruleName = 'EdgeCoder Runtime'
    if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
        Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
        Write-Host "Removed inbound firewall rule '$ruleName' (no longer needed)."
    }
}

function Set-EnvironmentVariables {
    <#
    .SYNOPSIS
        Set machine-level environment variables for EdgeCoder directories.
    #>
    $vars = @{
        'EDGECODER_CONFIG_DIR' = "$env:APPDATA\EdgeCoder"
        'EDGECODER_LOG_DIR'    = "$env:LOCALAPPDATA\EdgeCoder\logs"
    }

    foreach ($kv in $vars.GetEnumerator()) {
        $current = [Environment]::GetEnvironmentVariable($kv.Key, 'Machine')
        if ($current -ne $kv.Value) {
            [Environment]::SetEnvironmentVariable($kv.Key, $kv.Value, 'Machine')
            Write-Host "Set machine env: $($kv.Key) = $($kv.Value)"
        } else {
            Write-Host "Machine env already set: $($kv.Key)"
        }
    }
}

function Register-WindowsService {
    <#
    .SYNOPSIS
        Register EdgeCoder as a Windows service using sc.exe.
        Falls back to NSSM if sc.exe registration is not suitable.
    #>
    # The service runs as LocalService, never LocalSystem: it only needs to read its config and
    # make outbound connections.
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -ne $svc) {
        Write-Host "Windows service '$ServiceName' is already registered (status: $($svc.Status)); running it as LocalService."
        & sc.exe config $ServiceName obj= 'NT AUTHORITY\LocalService' password= '""' | Out-Null
        return
    }

    $runtimeScript = Join-Path $PSScriptRoot 'edgecoder-runtime.ps1'
    $pwshCmd = Get-Command powershell.exe -ErrorAction SilentlyContinue
    if (-not $pwshCmd) { $pwshCmd = Get-Command pwsh.exe -ErrorAction SilentlyContinue }
    $pwsh = if ($pwshCmd) { $pwshCmd.Source } else { $null }

    if (-not $pwsh) {
        Write-Host 'Warning: could not locate PowerShell binary to register service.'
        return
    }

    # Try NSSM first (more robust for scripts)
    $nssm = Get-Command nssm.exe -ErrorAction SilentlyContinue
    if ($nssm) {
        try {
            & $nssm.Source install $ServiceName $pwsh "-ExecutionPolicy Bypass -File `"$runtimeScript`""
            & $nssm.Source set $ServiceName Description 'EdgeCoder Runtime Service'
            & $nssm.Source set $ServiceName Start SERVICE_AUTO_START
            & $nssm.Source set $ServiceName ObjectName 'NT AUTHORITY\LocalService'
            Write-Host "Windows service '$ServiceName' registered via NSSM."
            return
        } catch {
            Write-Host "Warning: NSSM registration failed: $_"
        }
    }

    # Fallback: sc.exe with a wrapper
    try {
        $binPath = "`"$pwsh`" -ExecutionPolicy Bypass -File `"$runtimeScript`""
        & sc.exe create $ServiceName binPath= $binPath start= auto obj= 'NT AUTHORITY\LocalService' DisplayName= "EdgeCoder Runtime"
        Write-Host "Windows service '$ServiceName' registered via sc.exe."
        Write-Host 'Note: sc.exe services using PowerShell scripts may need NSSM for production use.'
    } catch {
        Write-Host "Warning: could not register Windows service: $_"
        Write-Host 'Install NSSM (https://nssm.cc) for reliable service registration.'
    }
}

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

    if ($Value -match "[`r`n]") { throw "$Key must be a single line" }
    $line = "${Key}=${Value}"

    if (-not (Test-Path -LiteralPath $File)) {
        # File does not exist yet; create with this single line.
        Set-Content -LiteralPath $File -Value $line -Encoding UTF8
        return
    }

    $content = Get-Content -LiteralPath $File -Encoding UTF8
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

    # A new file, moved over the old one: it carries the config dir's ACL, not the old file's.
    $tmp = "$File.tmp.$([Guid]::NewGuid().ToString('N'))"
    Set-Content -LiteralPath $tmp -Value $newContent -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $File -Force
}

function Protect-EnvDir {
    <#
    .SYNOPSIS
        Create C:\ProgramData\EdgeCoder owned by Administrators with an explicit ACL, before any
        token is written. ProgramData lets every user create folders and files and keep owning
        them, so a pre-existing folder or env file owned by anyone but Administrators, SYSTEM or
        this account is refused instead of reused.
    #>
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $trusted = @('S-1-5-32-544', 'S-1-5-18', $me)
    foreach ($p in @($EnvDir, $EnvFile)) {
        if (Test-Path -LiteralPath $p) {
            $item = Get-Item -LiteralPath $p -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$p is a junction or symbolic link; remove it and re-run." }
            $owner = (Get-Acl -LiteralPath $p).GetOwner([Security.Principal.SecurityIdentifier]).Value
            if ($trusted -notcontains $owner) { throw "$p already exists and is owned by $owner, not Administrators or SYSTEM; another user may have created it. Inspect it, remove it, and re-run." }
        }
    }
    if (-not (Test-Path -LiteralPath $EnvDir)) { New-Item -ItemType Directory -Path $EnvDir | Out-Null }
    # Owner Administrators; no inheritance; Administrators and SYSTEM full, LocalService (the
    # service account) read.
    $acl = Get-Acl -LiteralPath $EnvDir
    $acl.SetSecurityDescriptorSddlForm('O:BAG:SYD:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;LS)')
    Set-Acl -LiteralPath $EnvDir -AclObject $acl
    # Existing files (env file, backups) drop any explicit ACEs and inherit exactly that.
    Get-ChildItem -LiteralPath $EnvDir -Force -File | ForEach-Object {
        $f = Get-Acl -LiteralPath $_.FullName
        $f.SetSecurityDescriptorSddlForm('O:BAG:SYD:AI')
        Set-Acl -LiteralPath $_.FullName -AclObject $f
    }
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

    if ($TokenValue -notmatch '^[A-Za-z0-9._~+/=-]{1,1024}$') {
        Write-Error 'Error: the token may only contain letters, digits and . _ ~ + / = -'
        exit 1
    }

    # 1. Create and lock the config directory before anything is written to it
    Protect-EnvDir

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

    # Bootstrap Ollama after quick-connect configuration
    Invoke-OllamaInstall

    # Set up firewall rules and environment variables
    Set-FirewallRules
    Set-EnvironmentVariables

    # Register as Windows service if not already present
    Register-WindowsService

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

# Handle -TokenFile / --token (with or without "configure" sub-command)
if (-not [string]::IsNullOrWhiteSpace($TokenFile)) {
    $Token = (Get-Content -LiteralPath $TokenFile -TotalCount 1).Trim()
}
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
