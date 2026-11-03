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

1. Download `EdgeCoder-{version}-macos-installer.pkg` from [portal Downloads](https://portal.edgecoder.io/portal/download) or [GitHub Releases](https://github.com/codyrs82/Edgecoder/releases).
2. Install: double-click the `.pkg` or `sudo installer -pkg EdgeCoder-*.pkg -target /`.
3. Enroll node in portal → Nodes → copy registration token.
4. Edit `/etc/edgecoder/edgecoder.env` — set `EDGE_RUNTIME_MODE=worker`, `AGENT_ID`, `AGENT_REGISTRATION_TOKEN`.
5. Restart: `sudo launchctl kickstart -k system/io.edgecoder.runtime`
6. Confirm node appears in Nodes → approve it.

## Initial setup — Linux (Debian/Ubuntu)

1. Install Node.js 22+: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs`
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

## Credential rotation (#3)

Run this when a secret may have been exposed (a secret-scan finding, a leaked
log, a departed operator) or on the regular schedule. Rotate in this order so
each step is verified before the next widens the blast radius. Secrets live only
in `fly secrets` (and the matching GitHub Actions secrets), never in the repo.

Set a secret per app, then confirm the restart:

```bash
fly secrets set -c deploy/fly/fly.portal.toml    NAME="<new value>"
fly secrets set -c deploy/fly/fly.seed-node.toml NAME="<new value>"
fly secrets set -c deploy/fly/fly.seed-eu.toml   NAME="<new value>"
fly secrets list -c deploy/fly/fly.portal.toml   # digest + created date changed
```

| Order | Secret | Apps | Notes |
| --- | --- | --- | --- |
| 1 | `WALLET_SECRET_PEPPER` | portal | Prerequisite: `WALLET_SECRET_PEPPER_PREVIOUS` is not implemented yet. The pepper derives wallet secret refs, so a bare swap breaks every existing wallet. Before rotating, ship a verify-with-either migration (read `WALLET_SECRET_PEPPER_PREVIOUS`, verify against new then old, re-derive on success), set both, then unset `_PREVIOUS` once every active wallet has re-derived. |
| 2 | `ADMIN_API_TOKEN` | control plane, seed nodes | Update the operator tooling that calls `/admin/*` in the same change. |
| 3 | `MESH_AUTH_TOKEN` / `COORDINATOR_MESH_TOKEN` | seed nodes, control plane, every worker | All coordinators and workers must move together; a mixed mesh partitions. Roll seeds first, then workers. |
| 4 | `PORTAL_SERVICE_TOKEN` | portal, seed nodes, control plane | Same value on both sides of every portal to coordinator call. |
| 5 | OAuth client secrets (`OAUTH_GOOGLE_CLIENT_SECRET`, `OAUTH_MICROSOFT_CLIENT_SECRET`) | portal | Create the new secret in the provider console, set it, then delete the old one in the console. |
| 6 | `RESEND_API_KEY` | portal | Create a new key in Resend, set it, revoke the old one. |
| 7 | `GODADDY_API_KEY` / `GODADDY_API_SECRET` | portal | Issue a new key pair in the GoDaddy developer portal, set both, delete the old pair. Used only by `src/portal/dns-manager.ts`. |
| 8 | `FLY_API_TOKEN` | GitHub Actions secret (`deploy-fly.yml`) | `fly tokens create deploy -x 999999h`, update the Actions secret, revoke the old token with `fly tokens revoke`. |
| 9 | LND macaroons (`LND_MACAROON_HEX`) / `CLN_API_TOKEN` | seed nodes | Bake a new invoice-scoped macaroon (`lncli bakemacaroon`), set it, revoke the old one with `lncli deletemacaroonid`. Never use the admin macaroon. |

After each step: watch the app logs for auth failures for a few minutes, run the
relevant smoke check (portal login, a coordinator `/health`, a test invoice),
then move on. Record the rotation (what, when, who) in the incident log; never
record the values.

### GitHub repository settings to enable

Settings → Code security:

- **Secret scanning** on, so GitHub alerts on known token formats across the repo and history.
- **Push protection** on, so a commit containing a known token format is rejected before it lands.
- **Validity checks** on, so an alert says whether the token is still live, which decides rotation priority.
- `.github/workflows/secret-scan.yml` (gitleaks + trufflehog) runs on every PR and push to `main`; trigger it with **Run workflow** for a full-history scan after a rotation.

## Cross-links

- [Public Mesh Operations](/operations/public-mesh-operations)
- [Deployment Topology](/operations/deployment-topology)
- [Trust and Security](/security/trust-and-security)
