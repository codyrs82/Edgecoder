#Requires -RunAsAdministrator
<#
.SYNOPSIS
    EdgeCoder installer for Windows (docs/install.md).

.DESCRIPTION
    irm https://edgecoder.io/install.ps1 -OutFile install.ps1; .\install.ps1 -- --mesh-token <token> [options]

    Installs a signed, prebuilt EdgeCoder agent release into C:\Program Files\EdgeCoder\app and
    runs the shared installer (edgecoder-install apply), which detects the hardware and creates
    one agent per GPU. deploy/install.sh (Linux, macOS) works the same way, and the options are
    identical everywhere (edgecoder-install help lists them). Options of this script:

      --version X     install release agent-vX (default: the latest agent release on GitHub)
      --from-source   UNVERIFIED developer install: clone and build --ref (default main)

    What it trusts, and how (docs/install.md, "How the installer verifies what it installs"):
      - Node.js: the official nodejs.org zip of $NodeVersion, checked against a pinned SHA-256.
      - EdgeCoder: SHA256SUMS must carry a valid minisign (Ed25519) signature by $ReleasePubKey
        for this exact tag, then the tarball must match it. Checked by verify-release.js (below)
        in the pinned Node; the same code is in install.sh.
      - Ollama: the official GitHub release zip of $OllamaVersion, checked against a pinned SHA-256.
      - Docker Desktop: detected; if missing, instructions are printed.
    Nothing downloaded is piped into a shell.
#>
param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $InstallerArgs = @())

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is many times slower with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo           = if ($env:EDGECODER_REPO) { $env:EDGECODER_REPO } else { 'codyrs82/Edgecoder' }
$InstallDir     = if ($env:EDGECODER_INSTALL_DIR) { $env:EDGECODER_INSTALL_DIR } else { "$env:ProgramFiles\EdgeCoder\app" }
$NodeDir        = "$env:ProgramFiles\EdgeCoder\node"
$OllamaDir      = "$env:ProgramFiles\Ollama"
# Changing these cannot weaken verification: every release is still checked against $ReleasePubKey.
$ReleaseBaseUrl = if ($env:EDGECODER_RELEASE_BASE_URL) { $env:EDGECODER_RELEASE_BASE_URL } else { "https://github.com/$Repo/releases/download" }
$ReleaseApiUrl  = if ($env:EDGECODER_RELEASE_API_URL) { $env:EDGECODER_RELEASE_API_URL } else { "https://api.github.com/repos/$Repo/releases?per_page=100" }

# ------------------------------------------------------------- trust anchors ----
# The minisign public key that signs agent releases (scripts/set-release-signing-key.sh writes
# this line; the same key is in deploy/install.sh and docs/install.md).
$ReleasePubKey = 'UNSET' # release-pubkey
# Test-only override (tests/install): it replaces the key above. Never set it.
if ($env:EDGECODER_INSECURE_TEST_ONLY_RELEASE_PUBKEY) {
    Write-Warning 'EDGECODER_INSECURE_TEST_ONLY_RELEASE_PUBKEY is set: releases are checked against a TEST key, not EdgeCoder''s. Do not use this outside tests.'
    $ReleasePubKey = $env:EDGECODER_INSECURE_TEST_ONLY_RELEASE_PUBKEY
}
$NodeVersion   = '22.23.4'
$NodeSha256    = 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20'   # node-v22.23.4-win-x64.zip
$OllamaVersion = '0.40.7'
$OllamaSha256  = 'e6527768c53e85ec4596495fb0f035ef07f437b4b591ebc3581684699a4668f4'   # ollama-windows-amd64.zip
$Target        = 'win-x64'

function Log($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Fetch($url, $out) {
    if ($url -notmatch '^(https|file)://') { throw "refusing to download over a non-https URL: $url" }
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out
}
function New-TempDir {
    $d = Join-Path ([IO.Path]::GetTempPath()) ("edgecoder-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $d | Out-Null
    return $d
}
# Download $url to $out and stop unless its SHA-256 is $sha.
function Fetch-Pinned($url, $out, $sha) {
    Fetch $url $out
    $got = (Get-FileHash -Algorithm SHA256 -Path $out).Hash.ToLowerInvariant()
    if ($got -ne $sha) { throw "checksum mismatch for $url (expected $sha, got $got); not installing it" }
}

# ------------------------------------------------------------------ args ----
$Version = ''; $FromSource = $false; $SourceRef = 'main'; $Rest = @()
for ($i = 0; $i -lt $InstallerArgs.Count; $i++) {
    $a = $InstallerArgs[$i]
    $hasValue = $i + 1 -lt $InstallerArgs.Count
    if ($a -eq '--version') { if (-not $hasValue) { throw '--version needs a value' }; $i++; $Version = $InstallerArgs[$i] }
    elseif ($a -like '--version=*') { $Version = $a.Substring(10) }
    elseif ($a -eq '--from-source') { $FromSource = $true }
    elseif ($a -eq '--ref') { if (-not $hasValue) { throw '--ref needs a value' }; $i++; $SourceRef = $InstallerArgs[$i] }
    else { $Rest += $a }
}
$InstallerArgs = $Rest
if ([Environment]::Is64BitOperatingSystem -eq $false -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'EdgeCoder releases are built for x64 Windows only' }

# ----------------------------------------------------------------- Node ----
$Node = Join-Path $NodeDir 'node.exe'
$haveNode = (Test-Path $Node) -and ((& $Node -p 'process.versions.node') -eq $NodeVersion)
if (-not $haveNode) {
    Log "Installing Node.js $NodeVersion (nodejs.org build) into $NodeDir"
    $tmp = New-TempDir
    $zip = Join-Path $tmp "node-v$NodeVersion-win-x64.zip"
    Fetch-Pinned "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" $zip $NodeSha256
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
    New-Item -ItemType Directory -Force -Path (Split-Path $NodeDir) | Out-Null
    Move-Item (Join-Path $tmp "node-v$NodeVersion-win-x64") $NodeDir
    Remove-Item -Recurse -Force $tmp
}
$env:Path = "$NodeDir;$env:Path"

# --------------------------------------------------------------- Ollama ----
if (-not (Have 'ollama') -and -not (Test-Path "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe") -and -not (Test-Path "$OllamaDir\ollama.exe")) {
    Log "Installing Ollama $OllamaVersion (official release archive) into $OllamaDir"
    $tmp = New-TempDir
    $zip = Join-Path $tmp 'ollama-windows-amd64.zip'
    Fetch-Pinned "https://github.com/ollama/ollama/releases/download/v$OllamaVersion/ollama-windows-amd64.zip" $zip $OllamaSha256
    New-Item -ItemType Directory -Force -Path $OllamaDir | Out-Null
    Expand-Archive -Path $zip -DestinationPath $OllamaDir -Force
    Remove-Item -Recurse -Force $tmp
}

# --------------------------------------------------------------- Docker ----
if (-not (Have 'docker')) {
    Log 'Docker Desktop is not installed'
    Write-Host 'Swarm tasks run in Docker sandboxes; without it the agent registers but takes no work.'
    Write-Host 'Install from https://www.docker.com/products/docker-desktop/ (WSL 2 backend), enable "Start at login", then re-run this installer.'
}

# Runs in the pinned Node; deploy/install.sh embeds the same text (tests/install checks it).
$VerifyJs = @'
// ---- BEGIN verify-release.js ----
// usage: node verify-release.js PUBKEY SHA256SUMS SHA256SUMS.minisig TARBALL TAG
const crypto = require("crypto"), fs = require("fs"), path = require("path");
const [pub, sumsPath, sigPath, file, tag] = process.argv.slice(2);
const fail = (m) => { console.error("verify: " + m + "; not installing it"); process.exit(1); };
const pk = Buffer.from(pub || "", "base64");
if (pk.length !== 42 || pk.toString("latin1", 0, 2) !== "Ed") fail("no valid release public key is pinned in this installer");
const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pk.subarray(10)]), format: "der", type: "spki" });
const lines = fs.readFileSync(sigPath, "utf8").split("\n").map((l) => l.replace(/\r$/, ""));
if (lines.length < 4 || !lines[2].startsWith("trusted comment: ")) fail("malformed signature file");
const sig = Buffer.from(lines[1], "base64");
if (sig.length !== 74 || sig.toString("latin1", 0, 2) !== "ED") fail("unsupported signature algorithm");
if (!sig.subarray(2, 10).equals(pk.subarray(2, 10))) fail("SHA256SUMS is signed by a different key");
const sums = fs.readFileSync(sumsPath);
if (!crypto.verify(null, crypto.createHash("blake2b512").update(sums).digest(), key, sig.subarray(10))) fail("BAD SIGNATURE on SHA256SUMS");
const comment = lines[2].slice("trusted comment: ".length);
if (!crypto.verify(null, Buffer.concat([sig.subarray(10), Buffer.from(comment, "utf8")]), key, Buffer.from(lines[3], "base64"))) fail("BAD SIGNATURE on the trusted comment");
if (!comment.split(/\s+/).includes("tag:" + tag)) fail("the signature is for '" + comment + "', not " + tag);
const name = path.basename(file);
const entry = sums.toString("utf8").split("\n").map((l) => /^([0-9a-f]{64}) [ *](.+?)\r?$/.exec(l)).find((m) => m && m[2] === name);
if (!entry) fail(name + " is not listed in the signed SHA256SUMS");
const hash = crypto.createHash("sha256"), fd = fs.openSync(file, "r"), buf = Buffer.alloc(1 << 20);
for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) hash.update(buf.subarray(0, n));
fs.closeSync(fd);
const got = hash.digest("hex");
if (got !== entry[1]) fail("CHECKSUM MISMATCH for " + name + " (signed " + entry[1] + ", downloaded " + got + ")");
console.log("verified " + name + ": signed by release key, " + comment);
// ---- END verify-release.js ----
'@

function Set-App($dir) {
    New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir) | Out-Null
    if (Test-Path "$InstallDir.old") { Remove-Item -Recurse -Force "$InstallDir.old" }
    if (Test-Path $InstallDir) { Move-Item $InstallDir "$InstallDir.old" }
    Move-Item $dir $InstallDir
    if (Test-Path "$InstallDir.old") { Remove-Item -Recurse -Force "$InstallDir.old" }
}

if ($FromSource) {
    # ------------------------------------------------- UNVERIFIED: developers ----
    $url = if ($env:EDGECODER_REPO_URL) { $env:EDGECODER_REPO_URL } else { "https://github.com/$Repo.git" }
    Write-Warning "--from-source installs UNVERIFIED code: $url at '$SourceRef' is cloned and built without any signature check."
    if (-not (Have 'git')) { throw '--from-source needs git (https://git-scm.com/download/win)' }
    $tmp = New-TempDir
    git clone -q --depth 1 --branch $SourceRef $url "$tmp\src"
    if ($LASTEXITCODE -ne 0) { throw 'git clone failed' }
    Push-Location "$tmp\src"
    try {
        & "$NodeDir\npm.cmd" ci --no-audit --no-fund --loglevel=error; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
        & "$NodeDir\npm.cmd" run build --silent; if ($LASTEXITCODE -ne 0) { throw 'build failed' }
        & "$NodeDir\npm.cmd" prune --omit=dev --no-audit --no-fund --loglevel=error
    } finally { Pop-Location }
    Remove-Item -Recurse -Force "$tmp\src\.git"
    Set-App "$tmp\src"
    Remove-Item -Recurse -Force $tmp
} else {
    # ------------------------------------------------------- signed release ----
    if ($Version) {
        $v = $Version -replace '^agent-', '' -replace '^v', ''
        if ($v -notmatch '^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$') { throw "not a release version: $Version" }
        $Tag = "agent-v$v"
    } else {
        # The newest published, non-prerelease agent-v* release (GitHub's "latest" is the desktop app).
        $releases = Invoke-RestMethod -UseBasicParsing -Uri $ReleaseApiUrl
        $r = $releases | Where-Object { -not $_.draft -and -not $_.prerelease -and $_.tag_name -match '^agent-v\d+\.\d+\.\d+$' } | Select-Object -First 1
        if (-not $r) { throw "no agent release found at $ReleaseApiUrl (pass --version)" }
        $Tag = $r.tag_name
    }
    $asset = "edgecoder-agent-$Tag-$Target.tar.gz"
    Log "EdgeCoder $Tag ($Target) -> $InstallDir"
    $tmp = New-TempDir
    Fetch "$ReleaseBaseUrl/$Tag/$asset" "$tmp\$asset"
    Fetch "$ReleaseBaseUrl/$Tag/SHA256SUMS" "$tmp\SHA256SUMS"
    Fetch "$ReleaseBaseUrl/$Tag/SHA256SUMS.minisig" "$tmp\SHA256SUMS.minisig"
    [IO.File]::WriteAllText("$tmp\verify-release.js", $VerifyJs)
    & $Node "$tmp\verify-release.js" $ReleasePubKey "$tmp\SHA256SUMS" "$tmp\SHA256SUMS.minisig" "$tmp\$asset" $Tag
    if ($LASTEXITCODE -ne 0) { Remove-Item -Recurse -Force $tmp; throw 'release verification failed' }
    # Only a verified tarball is unpacked (tar.exe ships with Windows 10 1803 and later).
    New-Item -ItemType Directory -Path "$tmp\x" | Out-Null
    & "$env:SystemRoot\System32\tar.exe" -xzf "$tmp\$asset" -C "$tmp\x"
    if ($LASTEXITCODE -ne 0) { throw "could not unpack $asset" }
    if (-not (Test-Path "$tmp\x\edgecoder\dist\install\cli.js")) { throw "$asset has no edgecoder\dist\install\cli.js" }
    Set-App "$tmp\x\edgecoder"
    Remove-Item -Recurse -Force $tmp
}

# Make `edgecoder-install` available in every shell.
$binDir = "$env:ProgramFiles\EdgeCoder\bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Set-Content -Path (Join-Path $binDir 'edgecoder-install.cmd') -Value "@echo off`r`n`"$Node`" `"$InstallDir\dist\install\cli.js`" %*`r`n"
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
foreach ($d in @($binDir, $OllamaDir)) {
    if ((Test-Path $d) -and $machinePath -notlike "*$d*") { $machinePath = "$machinePath;$d" }
}
[Environment]::SetEnvironmentVariable('Path', $machinePath, 'Machine')
$env:Path = "$env:Path;$OllamaDir"

Log 'Installer'
& $Node "$InstallDir\dist\install\cli.js" apply --app-dir $InstallDir @InstallerArgs
exit $LASTEXITCODE
