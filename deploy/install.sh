#!/usr/bin/env bash
# Copyright (c) 2025 EdgeCoder, LLC
# SPDX-License-Identifier: BUSL-1.1
#
# EdgeCoder installer for Linux and macOS (docs/install.md).
#
#   curl -fsSLo install.sh https://edgecoder.io/install.sh && sudo bash install.sh --mesh-token <token> [options]
#
# Installs a signed, prebuilt EdgeCoder agent release and runs the shared installer
# (`edgecoder-install apply`), which detects the hardware and creates one agent per GPU. Options
# not listed below go to edgecoder-install unchanged (`edgecoder-install help` lists them).
#
#   --version X     install release agent-vX (default: the latest agent release on GitHub)
#   --from-source   UNVERIFIED developer install: clone and build --ref (default main) as the
#                   invoking (non-root) user instead of installing a signed release
#
# What it trusts, and how (docs/install.md, "How the installer verifies what it installs"):
#   - Node.js: the official nodejs.org tarball of NODE_VERSION, checked against the SHA-256
#     pinned below, unpacked into /opt/edgecoder/node.
#   - EdgeCoder: the release's SHA256SUMS must carry a valid minisign (Ed25519) signature by
#     RELEASE_PUBKEY below, for this exact tag; then the tarball must match its SHA256SUMS line.
#     The check runs in the pinned Node (verify-release.js below): no extra tools needed.
#   - Ollama: the official GitHub release archive of OLLAMA_VERSION, checked against a pinned SHA-256.
#   - Docker (Linux): the distribution's own signed package (docker.io / moby-engine), or instructions.
#   - NVIDIA container toolkit: NVIDIA's apt repo, its key checked against a pinned fingerprint.
# Nothing downloaded is piped into a shell, and nothing is built as root.
set -euo pipefail

REPO="${EDGECODER_REPO:-codyrs82/Edgecoder}"
INSTALL_DIR="${EDGECODER_INSTALL_DIR:-/opt/edgecoder/app}"
NODE_DIR="${EDGECODER_NODE_DIR:-/opt/edgecoder/node}"
# Where releases are fetched from. Changing these cannot weaken verification: every release is
# still checked against RELEASE_PUBKEY.
RELEASE_BASE_URL="${EDGECODER_RELEASE_BASE_URL:-https://github.com/$REPO/releases/download}"
RELEASE_API_URL="${EDGECODER_RELEASE_API_URL:-https://api.github.com/repos/$REPO/releases?per_page=100}"

# ------------------------------------------------------------- trust anchors ----
# The minisign public key that signs agent releases (scripts/set-release-signing-key.sh
# writes this line; the same key is in deploy/install.ps1 and docs/install.md).
RELEASE_PUBKEY="RWSpn4RH5/e5O8Qd9rasofZ9OVjMNPlvimRunFeWb0LEMylKCiS9kwgI" # release-pubkey
# The only override, for the installer's own tests (tests/install, tests/install-dryrun). It
# replaces the key above, so whoever sets it decides what gets installed as root. Never set it.
if [ -n "${EDGECODER_INSECURE_TEST_ONLY_RELEASE_PUBKEY:-}" ]; then
  echo "WARNING: EDGECODER_INSECURE_TEST_ONLY_RELEASE_PUBKEY is set: releases are checked against a TEST key, not EdgeCoder's. Do not use this outside tests." >&2
  RELEASE_PUBKEY="$EDGECODER_INSECURE_TEST_ONLY_RELEASE_PUBKEY"
fi

NODE_VERSION=22.23.4
node_sha256() {
  case "$1" in
    linux-x64)    echo b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406 ;;
    linux-arm64)  echo f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9 ;;
    darwin-x64)   echo efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819 ;;
    darwin-arm64) echo c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428 ;;
    *) return 1 ;;
  esac
}

OLLAMA_VERSION=0.40.7
ollama_asset() {
  case "$1" in
    linux-x64)    echo "ollama-linux-amd64.tar.zst 7f082e625b4c334df84ed1558fe282d6d8091fe3545790aef30b3a9c50d44d41" ;;
    linux-arm64)  echo "ollama-linux-arm64.tar.zst c74249e87795b1437ce0f484adfd05b4628d7497472c475b13ec6db69ecc69cf" ;;
    darwin-*)     echo "ollama-darwin.tgz 6c8b378e423a4c959b586c0bb62865d20ae057e817f1a8ee10abcc44bde6abab" ;;
    *) return 1 ;;
  esac
}

# NVIDIA CORPORATION (Open Source Projects) <cudatools@nvidia.com>, the libnvidia-container repo key.
NVIDIA_REPO_FINGERPRINT=C95B321B61E88C1809C4F759DDCAE044F796ECB0
# Docker Release (CE deb) <docker@docker.com>, for the manual instructions only.
DOCKER_REPO_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }
warn() { echo "warning: $*" >&2; }

# https only (file:// for local test fixtures), including redirects (GitHub's go to its CDN).
fetch() { curl -fsSL --proto '=https,file' --proto-redir '=https' --retry 3 -o "$2" "$1"; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# Download $1 to $2 and stop unless its SHA-256 is $3.
fetch_pinned() {
  fetch "$1" "$2" || die "download failed: $1"
  local got; got="$(sha256_of "$2")"
  [ "$got" = "$3" ] || die "checksum mismatch for $1 (expected $3, got $got); not installing it"
}

detect_target() {
  local os arch
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) die "unsupported OS $(uname -s) (Windows: deploy/install.ps1)" ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
  echo "$os-$arch"
}

root_group() { [ "$(uname -s)" = Darwin ] && echo wheel || echo root; }

# Root-owned and not writable by anyone else: the services run these files (src/install/binaries.ts).
secure_tree() {
  [ "$(id -u)" -eq 0 ] || return 0
  chown -R "root:$(root_group)" "$1" && chmod -R go-w "$1"
}

# ------------------------------------------------------------ base tools ----
# zstd: Ollama's Linux release is a .tar.zst. gnupg: checking the NVIDIA repo key fingerprint.
ensure_base() {
  [ "$(uname -s)" = Linux ] || return 0
  export DEBIAN_FRONTEND=noninteractive
  local pkgs="ca-certificates curl gnupg tar gzip zstd"
  [ "$FROM_SOURCE" = 1 ] && pkgs="$pkgs git sudo"
  if command -v apt-get >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    apt-get update -qq && apt-get install -y -qq $pkgs >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    dnf install -y -q ${pkgs/gnupg/gnupg2}
  fi
}

# ----------------------------------------------------------------- Node ----
# The pinned nodejs.org build in a root-owned dir, on every OS: it is self-contained (Homebrew's
# node links user-writable dylibs, which edgecoder-install refuses), it matches the Node the
# release was built with (native modules), and it runs the signature check below.
ensure_node() {
  if [ -x "$NODE_DIR/bin/node" ] && [ "$("$NODE_DIR/bin/node" -p process.versions.node 2>/dev/null || true)" = "$NODE_VERSION" ]; then
    NODE="$NODE_DIR/bin/node"; return
  fi
  log "Installing Node.js $NODE_VERSION (nodejs.org build) into $NODE_DIR"
  local sum tmp tarball
  sum="$(node_sha256 "$TARGET")" || die "no pinned Node.js build for $TARGET"
  tarball="node-v$NODE_VERSION-$TARGET.tar.gz"
  tmp="$(mktemp -d)"
  fetch_pinned "https://nodejs.org/dist/v$NODE_VERSION/$tarball" "$tmp/$tarball" "$sum"
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xzf "$tmp/$tarball" -C "$NODE_DIR" --strip-components 1 --no-same-owner
  secure_tree "$NODE_DIR"
  rm -rf "$tmp"
  NODE="$NODE_DIR/bin/node"
}

# --------------------------------------------------------------- Ollama ----
OLLAMA_BIN_ARG=()
ensure_ollama() {
  if command -v ollama >/dev/null 2>&1; then return; fi
  if [ "$(uname -s)" = Darwin ] && [ -x /opt/edgecoder/ollama/ollama ]; then OLLAMA_BIN_ARG=(--ollama-bin /opt/edgecoder/ollama/ollama); return; fi
  log "Installing Ollama $OLLAMA_VERSION (official release archive)"
  local spec name sum tmp
  spec="$(ollama_asset "$TARGET")" || die "no pinned Ollama build for $TARGET"
  name="${spec%% *}"; sum="${spec##* }"
  tmp="$(mktemp -d)"
  fetch_pinned "https://github.com/ollama/ollama/releases/download/v$OLLAMA_VERSION/$name" "$tmp/$name" "$sum"
  if [ "$(uname -s)" = Darwin ]; then
    # Root-owned, outside /usr/local (which Homebrew makes user-writable on Intel Macs).
    rm -rf /opt/edgecoder/ollama && mkdir -p /opt/edgecoder/ollama
    tar -xzf "$tmp/$name" -C /opt/edgecoder/ollama --no-same-owner
    secure_tree /opt/edgecoder/ollama
    OLLAMA_BIN_ARG=(--ollama-bin /opt/edgecoder/ollama/ollama)
  else
    # The layout Ollama's own installer uses: /usr/local/bin/ollama and /usr/local/lib/ollama.
    rm -rf /usr/local/lib/ollama
    zstd -q -dc "$tmp/$name" | tar -xf - -C /usr/local --no-same-owner
    secure_tree /usr/local/lib/ollama
  fi
  rm -rf "$tmp"
}

# --------------------------------------------------------------- Docker ----
docker_instructions() {
  cat >&2 <<EOF

Docker is not installed. Swarm tasks run in Docker sandboxes; without it the agents register but
take no swarm work. Install it from your distribution's signed packages, for example:
  Debian/Ubuntu:  sudo apt-get install docker.io
  Fedora:         sudo dnf install moby-engine
or from Docker's own apt/dnf repository (https://docs.docker.com/engine/install/), checking that
its signing key fingerprint is $DOCKER_REPO_FINGERPRINT.
Then re-run this installer (or \`sudo edgecoder-install apply\`).
EOF
}

ensure_docker() {
  [ "$(uname -s)" = Linux ] || return 0
  if ! command -v docker >/dev/null 2>&1; then
    log "Installing Docker from the distribution's packages (swarm task sandbox)"
    if command -v apt-get >/dev/null 2>&1; then apt-get install -y -qq docker.io >/dev/null || true
    elif command -v dnf >/dev/null 2>&1; then dnf install -y -q moby-engine || true
    fi
    if command -v docker >/dev/null 2>&1; then systemctl enable --now docker >/dev/null 2>&1 || true
    else docker_instructions; fi
  fi
  if command -v nvidia-smi >/dev/null 2>&1 && ! command -v nvidia-ctk >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
    log "Installing the NVIDIA container toolkit"
    local tmp fpr keyring=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    tmp="$(mktemp -d)"
    fetch https://nvidia.github.io/libnvidia-container/gpgkey "$tmp/key.asc" || die "could not download NVIDIA's repo key"
    fpr="$(gpg --show-keys --with-colons "$tmp/key.asc" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')"
    [ "$fpr" = "$NVIDIA_REPO_FINGERPRINT" ] || die "NVIDIA repo key fingerprint is '$fpr', expected $NVIDIA_REPO_FINGERPRINT"
    gpg --dearmor < "$tmp/key.asc" > "$keyring.new" && mv "$keyring.new" "$keyring"
    # The repo line is written here, not downloaded: the same one NVIDIA's .list file contains.
    # shellcheck disable=SC2016
    echo "deb [signed-by=$keyring] https://nvidia.github.io/libnvidia-container/stable/deb/\$(ARCH) /" > /etc/apt/sources.list.d/nvidia-container-toolkit.list
    rm -rf "$tmp"
    apt-get update -qq && apt-get install -y -qq nvidia-container-toolkit >/dev/null
    if command -v docker >/dev/null 2>&1; then nvidia-ctk runtime configure --runtime=docker >/dev/null && systemctl restart docker; fi
  fi
}

# ------------------------------------------------------- release lookup ----
# "1.2.3", "v1.2.3" and "agent-v1.2.3" all mean the tag agent-v1.2.3.
normalize_tag() {
  local v="${1#agent-}"; v="${v#v}"
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] || die "not a release version: $1"
  echo "agent-v$v"
}

# The newest published, non-prerelease agent-v* release. (GitHub's "latest" is the desktop app.)
latest_tag() {
  local json; json="$(mktemp)"
  fetch "$RELEASE_API_URL" "$json" || die "could not list releases at $RELEASE_API_URL (pass --version)"
  "$NODE" -e '
    const rs = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const r = rs.find((r) => !r.draft && !r.prerelease && /^agent-v\d+\.\d+\.\d+$/.test(r.tag_name));
    if (!r) process.exit(1);
    console.log(r.tag_name);' "$json" || { rm -f "$json"; die "no agent release found at $RELEASE_API_URL"; }
  rm -f "$json"
}

# Runs in the pinned Node; deploy/install.ps1 embeds the same text (tests/install checks it).
# Exit 0 only when SHA256SUMS carries a valid signature by the pinned key whose trusted comment
# names this tag, and the tarball matches its SHA256SUMS line.
write_verifier() {
  cat > "$1" <<'VERIFY_JS'
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
VERIFY_JS
}

# Download, verify and unpack release $1 into INSTALL_DIR (replacing what is there).
install_release() {
  local tag="$1" tmp asset
  asset="edgecoder-agent-$tag-$TARGET.tar.gz"
  log "EdgeCoder $tag ($TARGET) -> $INSTALL_DIR"
  tmp="$(mktemp -d)"
  fetch "$RELEASE_BASE_URL/$tag/$asset" "$tmp/$asset" || { rm -rf "$tmp"; die "download failed: $RELEASE_BASE_URL/$tag/$asset"; }
  fetch "$RELEASE_BASE_URL/$tag/SHA256SUMS" "$tmp/SHA256SUMS" || { rm -rf "$tmp"; die "download failed: SHA256SUMS for $tag"; }
  fetch "$RELEASE_BASE_URL/$tag/SHA256SUMS.minisig" "$tmp/SHA256SUMS.minisig" || { rm -rf "$tmp"; die "download failed: SHA256SUMS.minisig for $tag"; }
  write_verifier "$tmp/verify-release.js"
  "$NODE" "$tmp/verify-release.js" "$RELEASE_PUBKEY" "$tmp/SHA256SUMS" "$tmp/SHA256SUMS.minisig" "$tmp/$asset" "$tag" \
    || { rm -rf "$tmp"; die "release verification failed"; }
  # Only a verified tarball is unpacked.
  mkdir "$tmp/x"
  tar -xzf "$tmp/$asset" -C "$tmp/x" --no-same-owner
  [ -f "$tmp/x/edgecoder/dist/install/cli.js" ] || { rm -rf "$tmp"; die "$asset has no edgecoder/dist/install/cli.js"; }
  place_app "$tmp/x/edgecoder"
  rm -rf "$tmp"
}

# Swap a prepared app dir into INSTALL_DIR, root-owned.
place_app() {
  secure_tree "$1"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  rm -rf "$INSTALL_DIR.new" "$INSTALL_DIR.old"
  mv "$1" "$INSTALL_DIR.new"
  [ -e "$INSTALL_DIR" ] && mv "$INSTALL_DIR" "$INSTALL_DIR.old"
  mv "$INSTALL_DIR.new" "$INSTALL_DIR"
  rm -rf "$INSTALL_DIR.old"
}

# UNVERIFIED: for developers. Builds as the user who ran sudo, never as root; only the copy into
# INSTALL_DIR runs as root.
install_from_source() {
  local ref="$1" url="${EDGECODER_REPO_URL:-https://github.com/$REPO.git}" user="${SUDO_USER:-}" tmp
  echo "WARNING: --from-source installs UNVERIFIED code: $url at '$ref' is cloned and built without any signature check." >&2
  [ -n "$user" ] && [ "$user" != root ] || die "--from-source builds as the user who ran sudo; run it as: sudo bash install.sh --from-source ..."
  command -v git >/dev/null 2>&1 || die "--from-source needs git"
  log "Building $ref from $url as $user (unverified)"
  tmp="$(mktemp -d)"; chown "$user" "$tmp"
  sudo -u "$user" git clone -q --depth 1 --branch "$ref" "$url" "$tmp/src"
  sudo -u "$user" env PATH="$NODE_DIR/bin:$PATH" bash -c 'cd "$1" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent && npm prune --omit=dev --no-audit --no-fund --loglevel=error' _ "$tmp/src"
  rm -rf "$tmp/src/.git"
  place_app "$tmp/src"
  rm -rf "$tmp"
}

usage() {
  sed -n '5,17p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null | sed 's/^# \{0,1\}//' || true
  echo "Other options go to edgecoder-install: run 'edgecoder-install help' after installing, or see docs/install.md."
}

main() {
  VERSION="" FROM_SOURCE=0 SOURCE_REF=main
  local args=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || die "--version needs a value"; VERSION="$2"; shift 2 ;;
      --version=*) VERSION="${1#--version=}"; shift ;;
      --from-source) FROM_SOURCE=1; shift ;;
      --ref) [ $# -ge 2 ] || die "--ref needs a value"; SOURCE_REF="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) args+=("$1"); shift ;;
    esac
  done
  [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
  TARGET="$(detect_target)"

  ensure_base; ensure_node; ensure_ollama; ensure_docker
  if [ "$FROM_SOURCE" = 1 ]; then
    install_from_source "$SOURCE_REF"
  else
    local tag
    if [ -n "$VERSION" ]; then tag="$(normalize_tag "$VERSION")"; else tag="$(latest_tag)"; fi
    install_release "$tag"
  fi

  # A wrapper, not a symlink: dist/install/cli.js finds the app relative to its own path.
  mkdir -p /usr/local/bin
  rm -f /usr/local/bin/edgecoder-install
  printf '#!/bin/sh\nexec "%s" "%s/dist/install/cli.js" "$@"\n' "$NODE" "$INSTALL_DIR" > /usr/local/bin/edgecoder-install
  chmod 755 /usr/local/bin/edgecoder-install

  log "Installer"
  set -- ${OLLAMA_BIN_ARG[@]+"${OLLAMA_BIN_ARG[@]}"} ${args[@]+"${args[@]}"}
  export PATH="$NODE_DIR/bin:$PATH"
  exec "$NODE" "$INSTALL_DIR/dist/install/cli.js" apply --app-dir "$INSTALL_DIR" "$@"
}

# EDGECODER_INSTALL_LIB=1 defines the functions without running anything (tests/install).
# Wrapping everything in main() also means a truncated download runs nothing.
if [ "${EDGECODER_INSTALL_LIB:-}" != 1 ]; then main "$@"; fi
