#!/bin/sh
# #96: worker entrypoint for the scale stack (tests/e2e/docker-compose.scale.yml).
# Each replica enrols itself with the stack's portal using the owner's portal API key, the same
# call `edgecoder-install --enroll eck_...` makes (src/install/cli.ts enrollNodes), then starts the
# worker with the registration token the portal returned. The seed validates that token against
# the portal like any production registration; nothing here relaxes that check.
# CI/local test only: SCALE_ENROLL_KEY is a throwaway key created by scripts/e2e/scale-nonroot.sh.
set -eu
: "${SCALE_PORTAL_URL:?SCALE_PORTAL_URL is required}"
: "${SCALE_ENROLL_KEY:?SCALE_ENROLL_KEY is required (scripts/e2e/scale-nonroot.sh creates one)}"

# Same default as src/swarm/worker-runner.ts, made explicit so the enrolled id is the one that registers.
AGENT_ID="${AGENT_ID:-$(node -e 'const h=require("os").hostname().replace(/[^a-zA-Z0-9_-]/g,"").slice(0,16)||"1";process.stdout.write("worker-"+h)')}"
export AGENT_ID

AGENT_REGISTRATION_TOKEN="$(node -e '
const [url, key, nodeId] = process.argv.slice(1);
(async () => {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const res = await fetch(url.replace(/\/+$/, "") + "/nodes/enroll", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + key },
        body: JSON.stringify({ nodeId, nodeKind: "agent" })
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.registrationToken) {
        if (!body.active) console.error("[enroll] warning: " + nodeId + " enrolled but not active (emailVerified=" + body.emailVerified + " nodeApproved=" + body.nodeApproved + ")");
        process.stdout.write(body.registrationToken);
        return;
      }
      console.error("[enroll] attempt " + attempt + ": HTTP " + res.status + " " + JSON.stringify(body));
    } catch (e) {
      console.error("[enroll] attempt " + attempt + ": " + e.message);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  process.exit(1);
})();
' "$SCALE_PORTAL_URL" "$SCALE_ENROLL_KEY" "$AGENT_ID")" || { echo "[enroll] could not enrol $AGENT_ID at $SCALE_PORTAL_URL" >&2; exit 1; }
export AGENT_REGISTRATION_TOKEN
unset SCALE_ENROLL_KEY
echo "[enroll] $AGENT_ID enrolled with $SCALE_PORTAL_URL"
exec node dist/swarm/worker-runner.js
