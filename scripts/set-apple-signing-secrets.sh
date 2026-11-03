#!/usr/bin/env bash
# scripts/set-apple-signing-secrets.sh — load the Apple Developer ID signing and notarization
# secrets into GitHub Actions for the desktop release workflow, without the values ever being
# printed, written to a file in the repo, or kept in shell history.
#
#   bash scripts/set-apple-signing-secrets.sh ~/Desktop/developer-id.p12
#
# Needs: the exported Developer ID Application .p12, its export password, your Apple ID and an
# app-specific password (account.apple.com → Sign-In and Security → App-Specific Passwords),
# and `gh` signed in with access to the repo. See docs/macos-installer.md.

set -euo pipefail

P12="${1:-$HOME/Desktop/developer-id.p12}"
REPO="${EDGECODER_REPO:-codyrs82/Edgecoder}"
[ -f "$P12" ] || { echo "No .p12 at $P12 (pass its path as the first argument)."; exit 1; }
command -v gh >/dev/null || { echo "Install the GitHub CLI (brew install gh) and run gh auth login."; exit 1; }

# The certificate's name from the login keychain, e.g. "Developer ID Application: Name (TEAMID)".
IDENTITY="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)"
[ -n "$IDENTITY" ] || { echo "No 'Developer ID Application' certificate in your keychain. Create it first (Xcode → Settings → Accounts → Manage Certificates)."; exit 1; }
TEAM_ID="$(printf '%s' "$IDENTITY" | sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p')"
echo "Certificate: $IDENTITY"
echo "Team ID:     $TEAM_ID"

read -rsp "Password you set when exporting the .p12: " P12_PASSWORD; echo
read -rp  "Apple ID email: " APPLE_ID
read -rsp "App-specific password (xxxx-xxxx-xxxx-xxxx): " APPLE_PASSWORD; echo

# Check the .p12 password before uploading anything.
openssl pkcs12 -in "$P12" -passin "pass:$P12_PASSWORD" -nokeys -legacy >/dev/null 2>&1 \
  || openssl pkcs12 -in "$P12" -passin "pass:$P12_PASSWORD" -nokeys >/dev/null 2>&1 \
  || { echo "That password doesn't open $P12."; exit 1; }

base64 -i "$P12" | gh secret set APPLE_CERTIFICATE --repo "$REPO"
printf '%s' "$P12_PASSWORD"   | gh secret set APPLE_CERTIFICATE_PASSWORD --repo "$REPO"
printf '%s' "$IDENTITY"       | gh secret set APPLE_SIGNING_IDENTITY --repo "$REPO"
printf '%s' "$APPLE_ID"       | gh secret set APPLE_ID --repo "$REPO"
printf '%s' "$APPLE_PASSWORD" | gh secret set APPLE_PASSWORD --repo "$REPO"
printf '%s' "$TEAM_ID"        | gh secret set APPLE_TEAM_ID --repo "$REPO"
unset P12_PASSWORD APPLE_PASSWORD

echo "Done: six APPLE_* secrets set on $REPO. The next desktop release is signed and notarized."
echo "You can delete $P12 now (the certificate stays in your keychain)."
