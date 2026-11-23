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

## Initial setup — Mac and Windows (desktop app)

1. Download the desktop app (version 1.4.53 at the time of writing; the links always point at the newest release):
   - Mac (Apple silicon): [`EdgeCoder_aarch64.dmg`](https://github.com/codyrs82/Edgecoder/releases/latest/download/EdgeCoder_aarch64.dmg)
   - Windows (x64): [`EdgeCoder_x64-setup.exe`](https://github.com/codyrs82/Edgecoder/releases/latest/download/EdgeCoder_x64-setup.exe)

   The same links are on edgecoder.io under **Settings → Install agent**.
2. Mac: open the `.dmg` and drag EdgeCoder to Applications. Windows: run the setup program and allow admin access if asked.
3. Open EdgeCoder and sign in with your EdgeCoder account. The app bundles the agent and Ollama, so there is nothing else to install and no env file to edit: signing in links this computer to your account.
4. Confirm it shows up on edgecoder.io under **Settings → Nodes**.

Details: [Install the desktop app](/guide/install-desktop).

## Initial setup — Linux and GPU servers

1. On edgecoder.io create an install key (**Settings → Getting started → Add your other machines → Create install key**, or an `eck_` API key under **Settings → Connect your tools**).
2. On the server run the installer with the key:

   ```bash
   curl -fsSLo install.sh https://edgecoder.io/install.sh && sudo EDGECODER_API_KEY=YOUR_INSTALL_KEY bash install.sh --pull-models
   ```

   It verifies a signed agent release, installs Node.js, Ollama and Docker, sets up one agent per GPU (or one for the CPU) as `systemd` services, enrols each one with your account, and leaves the `edgecoder-install` command on the PATH.
3. Check it with `sudo edgecoder-install status`, then confirm the agents under **Settings → Nodes**.
4. Revoke the install key once the machines are online; each machine keeps its own credential.

Step by step: [Run EdgeCoder on a cloud GPU or Linux server](/guide/cloud-gpu-server).

## Initial setup — iOS

1. Install EdgeCoder from the App Store.
2. Sign in with your EdgeCoder account. The app enrolls the device with your account by itself after sign-in; there is no coordinator URL or token to paste.
3. The tabs are **Chat**, **Bots**, **Wallet**, **Machines** and **Network**. See the [iOS app guide](/guide/ios-app).

Your own machines run your own work for free. Running other people's work needs host approval: see [Hosting](/guide/hosting).

## Ongoing

- Desktop app: it updates itself. Linux hosts installed with `install.sh` check for a new signed release every 6 hours (`sudo edgecoder-install update` updates now). iOS updates from the App Store.
- Monitor local resource usage and scheduling constraints.
- Linux logs: `journalctl -u edgecoder-agent-0 -f` (agent), `journalctl -u edgecoder-ollama-0 -f` (Ollama). Status: `sudo edgecoder-install status`.
- Revoke install keys you no longer need (Settings → Connect your tools).

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
| 1 | `ADMIN_API_TOKEN` | control plane, seed nodes | Update the operator tooling that calls `/admin/*` in the same change. |
| 2 | `MESH_AUTH_TOKEN` / `COORDINATOR_MESH_TOKEN` | seed nodes, control plane, every worker | All coordinators and workers must move together; a mixed mesh partitions. Roll seeds first, then workers. |
| 3 | `PORTAL_SERVICE_TOKEN` | portal, seed nodes, control plane | Same value on both sides of every portal to coordinator call. |
| 4 | OAuth client secrets (`OAUTH_GOOGLE_CLIENT_SECRET`, `OAUTH_MICROSOFT_CLIENT_SECRET`) | portal | Create the new secret in the provider console, set it, then delete the old one in the console. |
| 5 | `RESEND_API_KEY` | portal | Create a new key in Resend, set it, revoke the old one. |
| 6 | `GODADDY_API_KEY` / `GODADDY_API_SECRET` | portal | Issue a new key pair in the GoDaddy developer portal, set both, delete the old pair. Used only by `src/portal/dns-manager.ts`. |
| 7 | `FLY_API_TOKEN` | GitHub Actions secret (`deploy-fly.yml`) | `fly tokens create deploy -x 999999h`, update the Actions secret, revoke the old token with `fly tokens revoke`. |
| 8 | LND macaroons (`LND_MACAROON_HEX`) / `CLN_API_TOKEN` | seed nodes | Bake a new invoice-scoped macaroon (`lncli bakemacaroon`), set it, revoke the old one with `lncli deletemacaroonid`. Never use the admin macaroon. |

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
