# Role-based Runbooks

This page gives concrete responsibilities and recurring actions by role.

## Role Matrix

| Role | Primary Surfaces | Owns | Does Not Own |
|---|---|---|---|
| System Admin | Portal ops, control-plane APIs | policy defaults, admin approvals, security posture | day-to-day contributor node operations |
| Coordinator Owner | coordinator ops view, coordinator config | coordinator health, peer topology, queue behavior | user account auth lifecycle |
| Node Contributor | worker runtime, enrollment workflow | node uptime, registration token handling, local runtime health | global policy and treasury controls |
| Application User | portal user dashboard, wallet views | submitting workload, account-level workflow | mesh internals and deployment policy |

## System Admin Runbook

## Daily

- Verify coordinator, inference, and control-plane health endpoints.
- Review pending approvals and blacklist changes.
- Validate pricing and issuance windows have current recalculation data.

## Weekly

- Review rollout controls and model source policy.
- Verify ledger and blacklist audit checks.
- Confirm disaster recovery and backup paths are current.

## Incident

1. Restrict high-risk paths (policy + approval gates).
2. Isolate affected nodes or coordinators.
3. Reconcile ledger/audit state before reopening traffic.

## Coordinator Owner Runbook

## Daily

- Check coordinator runtime health and queue behavior.
- Confirm peer discovery and mesh connectivity.
- Review assignment quality and worker failure rates.

## Weekly

- Validate coordinator bootstrap/discovery configuration.
- Tune capacity and assignment controls.
- Review coordinator fee and treasury policy alignment with admin.

## Incident

1. Pause new assignments if integrity is uncertain.
2. Drain or isolate unhealthy workers.
3. Resume in staged mode with increased observability.

## Node Contributor Runbook

## Initial setup — macOS

1. Download `EdgeCoder-{version}-macos-installer.pkg` from [portal Downloads](/portal/download) or [GitHub Releases](https://github.com/edgecoder-io/edgecoder/releases).
2. Install: double-click the `.pkg` or `sudo installer -pkg EdgeCoder-*.pkg -target /`.
3. Enroll node in portal → Nodes → copy registration token.
4. Edit `/etc/edgecoder/edgecoder.env` — set `EDGE_RUNTIME_MODE=worker`, `AGENT_ID`, `AGENT_REGISTRATION_TOKEN`.
5. Restart: `sudo launchctl kickstart -k system/io.edgecoder.runtime`
6. Confirm node appears in Nodes → approve it.

## Initial setup — Linux (Debian/Ubuntu)

1. Install Node.js 20+: `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt-get install -y nodejs`
2. Download and install `.deb`: `sudo dpkg -i EdgeCoder-{version}-linux-amd64.deb`
3. Enroll node in portal → Nodes → copy registration token.
4. Edit `/etc/edgecoder/edgecoder.env` — set `EDGE_RUNTIME_MODE=worker`, `AGENT_ID`, `AGENT_REGISTRATION_TOKEN`.
5. Restart: `sudo systemctl restart edgecoder`
6. Confirm node appears in Nodes → approve it.

## Initial setup — iOS

1. Install EdgeCoder from App Store (or TestFlight for beta).
2. Sign in with EdgeCoder account.
3. Go to Swarm tab → set Coordinator URL.
4. Enroll device in portal → Nodes → copy registration token.
5. Paste token in Swarm tab → tap **On** to start contributing.
6. Optionally tap **Bluetooth Local** to serve nearby Mac nodes without internet.

## Ongoing

- Keep runtime updated (re-run installer for new releases; iOS auto-updates from App Store).
- Monitor local resource usage and scheduling constraints.
- Rotate `AGENT_REGISTRATION_TOKEN` when required by policy.
- View logs: `tail -f /var/log/edgecoder/runtime.log` (macOS) or `journalctl -u edgecoder -f` (Linux).
- Service status: `launchctl print system/io.edgecoder.runtime` (macOS) or `systemctl status edgecoder` (Linux).

## Application User Runbook

## Usage flow

1. Authenticate and verify account.
2. Submit workload from portal or integrated surface.
3. Track status and review outputs.
4. Manage wallet/credits for sustained usage.

## Cross-links

- [Public Mesh Operations](/operations/public-mesh-operations)
- [Deployment Topology](/operations/deployment-topology)
- [Trust and Security](/security/trust-and-security)
