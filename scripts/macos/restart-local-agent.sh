#!/usr/bin/env bash
# Restart the local EdgeCoder macOS agent (LaunchDaemon).
# Run with: sudo bash scripts/macos/restart-local-agent.sh
set -euo pipefail

SERVICE="io.edgecoder.runtime"

echo "Restarting EdgeCoder runtime service ($SERVICE)..."
launchctl kickstart -k "system/$SERVICE"
echo "Done. Tailing log (Ctrl-C to exit):"
sleep 1
tail -f /var/log/edgecoder/runtime.log
