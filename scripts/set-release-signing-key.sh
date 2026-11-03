#!/usr/bin/env bash
# scripts/set-release-signing-key.sh — create the Ed25519 (minisign) key that signs agent
# releases, store the private half as the AGENT_RELEASE_SIGNING_KEY GitHub Actions secret, and pin
# the public half in the installers.
#
#   bash scripts/set-release-signing-key.sh                 # first time
#   bash scripts/set-release-signing-key.sh --rotate        # replace an existing key
#   bash scripts/set-release-signing-key.sh --backup FILE   # also keep a copy of the private key
#
# The private key is generated in memory by Node and piped straight into `gh secret set`; it is
# never written to disk, printed, or kept in shell history (unless you pass --backup, which
# writes it mode 0600 to a path outside this repository). Without a backup, a lost key is
# replaced with --rotate, and installers from before the rotation stop accepting new releases.
#
# Then: review and commit the files it changed (deploy/install.sh, deploy/install.ps1,
# docs/install.md), merge, and tag a release: git tag agent-v1.0.0 && git push origin agent-v1.0.0
# (.github/workflows/agent-release.yml builds, signs and publishes it). See docs/install.md.
# Needs: node 22+, and `gh` signed in with admin access to the repo.
set -euo pipefail

REPO="${EDGECODER_REPO:-codyrs82/Edgecoder}"
SECRET=AGENT_RELEASE_SIGNING_KEY
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROTATE=0 BACKUP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rotate) ROTATE=1; shift ;;
    --backup) BACKUP="${2:?--backup needs a file}"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done

command -v node >/dev/null || { echo "Install Node.js 22+ first."; exit 1; }
command -v gh >/dev/null || { echo "Install the GitHub CLI (brew install gh) and run gh auth login."; exit 1; }
if gh secret list --repo "$REPO" | awk '{print $1}' | grep -qx "$SECRET" && [ "$ROTATE" != 1 ]; then
  echo "$SECRET is already set on $REPO. Pass --rotate to replace it (installers pinning the old key"
  echo "will reject releases signed with the new one)."
  exit 1
fi
if [ -n "$BACKUP" ]; then
  case "$(cd "$(dirname "$BACKUP")" 2>/dev/null && pwd)/" in
    "$ROOT"/*) echo "--backup must be outside the repository ($ROOT)."; exit 1 ;;
  esac
  [ ! -e "$BACKUP" ] || { echo "$BACKUP already exists."; exit 1; }
fi

KEY_JSON="$(node "$ROOT/scripts/release/minisign.mjs" keygen)"
field() { printf '%s' "$KEY_JSON" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s)[process.argv[1]]))' "$1"; }
PUBKEY="$(field publicKey)"
KEY_ID="$(field keyId)"

field secretKeyPem | gh secret set "$SECRET" --repo "$REPO"
if [ -n "$BACKUP" ]; then
  (umask 077 && field secretKeyPem > "$BACKUP")
  echo "Private key backup: $BACKUP (mode 0600). Keep it offline."
fi
unset KEY_JSON

# Pin the public key in both installers and the docs.
node - "$ROOT" "$PUBKEY" "$KEY_ID" <<'NODE'
const fs = require("fs"), path = require("path");
const [root, pub, id] = process.argv.slice(2);
const edits = [
  ["deploy/install.sh", /^RELEASE_PUBKEY="[^"]*" # release-pubkey(?=\r?$)/m, `RELEASE_PUBKEY="${pub}" # release-pubkey`],
  // install.ps1 is checked out with CRLF line endings (.gitattributes); the lookahead keeps the \r.
  ["deploy/install.ps1", /^\$ReleasePubKey = '[^']*' # release-pubkey(?=\r?$)/m, `$ReleasePubKey = '${pub}' # release-pubkey`],
  ["docs/install.md", /<!-- release-pubkey -->[\s\S]*?<!-- \/release-pubkey -->/, `<!-- release-pubkey -->\n\`\`\`\nuntrusted comment: minisign public key ${id}\n${pub}\n\`\`\`\n\nKey ID: \`${id}\`\n<!-- /release-pubkey -->`]
];
for (const [rel, re, text] of edits) {
  const file = path.join(root, rel);
  const before = fs.readFileSync(file, "utf8");
  if (!re.test(before)) { console.error(`could not find the release key marker in ${rel}`); process.exit(1); }
  fs.writeFileSync(file, before.replace(re, text));
}
NODE

echo
echo "Done: $SECRET set on $REPO."
echo "Public key (minisign, key ID $KEY_ID):"
echo "  $PUBKEY"
echo "Pinned in deploy/install.sh, deploy/install.ps1 and docs/install.md: review and commit them,"
echo "then tag the first release: git tag agent-v1.0.0 && git push origin agent-v1.0.0"
