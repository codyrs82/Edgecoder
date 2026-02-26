# macOS Installer and Deployment

This guide packages EdgeCoder into a `.pkg` that installs a managed `launchd` service on macOS machines.

For full multi-node rollout (self-installed agents + additional coordinators), use:

- `docs/agent-and-coordinator-install.md`

## What gets installed

- Runtime files under `/opt/edgecoder/app`
- Service launcher script at `/opt/edgecoder/bin/edgecoder-runtime.sh`
- Ollama bootstrap helper at `/opt/edgecoder/bin/edgecoder-install-ollama.sh`
- Default config template at `/etc/edgecoder/edgecoder.env.example`
- Active config file at `/etc/edgecoder/edgecoder.env` (created on first install)
- LaunchDaemon at `/Library/LaunchDaemons/io.edgecoder.runtime.plist`
- Logs in `/var/log/edgecoder/`

## Prerequisites

- macOS with Xcode Command Line Tools (`pkgbuild` available)
- Node.js 20+ installed on target machines

## Build installer package

From repo root:

```bash
npm run build:macos-installer
```

Output:

- `build/EdgeCoder-<version>-macos-installer.pkg`

You can also pass a custom version:

```bash
bash scripts/macos/build-installer.sh 1.0.0
```

## Install on a machine

```bash
sudo installer -pkg build/EdgeCoder-<version>-macos-installer.pkg -target /
```

Note: macOS package scripts run in a non-interactive PackageKit sandbox, so they cannot prompt in-line.
After install, run:

```bash
sudo /opt/edgecoder/bin/edgecoder-configure.sh
```

This interactive wizard prompts for each config value and writes `/etc/edgecoder/edgecoder.env`.

One-command local flow (install + prompts + service restart):

```bash
bash scripts/macos/install-local.sh
```

Ollama bootstrap:

- Installer now attempts to install Ollama automatically (best-effort).
- You can re-run manually:

```bash
sudo /opt/edgecoder/bin/edgecoder-install-ollama.sh
```

## Associate local macOS agent to your portal account

1. Sign in at `https://portal.edgecoder.io/portal`.
2. Verify your email address from the Resend email link.
3. In the portal dashboard, enroll a node (agent kind) and copy the returned `registrationToken`.
4. Set that token in the local runtime config as `AGENT_REGISTRATION_TOKEN`.
5. Restart local service and wait for first registration.
6. Approve the node in portal coordinator operations (`https://portal.edgecoder.io/portal/coordinator-ops`) if not auto-approved by policy.

The agent is associated to your portal account through the enrollment token minted for your authenticated user.

After installation, edit runtime config:

```bash
sudo nano /etc/edgecoder/edgecoder.env
```

Re-run wizard anytime:

```bash
sudo /opt/edgecoder/bin/edgecoder-configure.sh
```

Recommended worker config:

```dotenv
EDGE_RUNTIME_MODE=worker
AGENT_ID=mac-worker-001
AGENT_OS=macos
AGENT_MODE=swarm-only
AGENT_REGISTRATION_TOKEN=<token-from-portal-node-enrollment>
COORDINATOR_URL=https://coordinator.edgecoder.io
MESH_AUTH_TOKEN=<token-if-required>
LOCAL_MODEL_PROVIDER=edgecoder-local
```

Where values come from:

- `AGENT_ID` and `AGENT_REGISTRATION_TOKEN`:
  - create/sign in account at `https://portal.edgecoder.io/portal`
  - verify email
  - enroll node and copy node id + registration token
- `MESH_AUTH_TOKEN`:
  - shared secret for mesh-auth endpoints
  - managed enrollment: can be blank on agent; coordinator can auto-provision on register
  - if your environment requires manual value, get from coordinator operator/admin
  - if you self-host coordinator, generate one:
    - `openssl rand -hex 32`
  - set the same token on coordinator and all agents that join it
- `LOCAL_MODEL_PROVIDER`:
  - `edgecoder-local`: default/recommended for most installs
  - `ollama-local`: choose only if using local Ollama on that machine
  - if unsure, keep `edgecoder-local`
- `OLLAMA_MODEL` (only when `LOCAL_MODEL_PROVIDER=ollama-local`):
  - model tag for Ollama to run/pull (for example `qwen2.5:7b`)
  - common options: `qwen2.5:7b`, `llama3.1:8b`, `deepseek-coder-v2:16b`
  - larger models generally improve quality but need more RAM/CPU/GPU
- `OLLAMA_HOST` (only when `LOCAL_MODEL_PROVIDER=ollama-local`):
  - blank = local default `http://127.0.0.1:11434`
  - explicit local: `http://127.0.0.1:11434`
  - remote/shared Ollama: `http://<host-or-ip>:11434`
- `MAX_CONCURRENT_TASKS`:
  - how many coordinator tasks a single agent can run in parallel
  - `1` is safest/recommended default
  - higher values can increase throughput but also CPU/RAM contention
  - increase gradually only if host has clear resource headroom
- `PEER_OFFER_COOLDOWN_MS`:
  - cooldown between peer-direct work offers when agent is idle (milliseconds)
  - lower value = more aggressive peer offers and more network chatter
  - higher value = calmer mesh behavior but slower peer-direct utilization
  - `20000` is a balanced default for most environments

Model compatibility across agents/coordinators:

- Mixed providers/models are supported and can work together in one mesh.
- Coordinator scheduling and mesh protocols are model-agnostic.
- Differences mainly impact quality/latency/cost per node, not protocol compatibility.
- For consistent output quality, standardize model rollouts via control-plane orchestration.

Activation notes:

- Node owners must verify email in the user portal before nodes can activate.
- Agents/coordinators remain dormant until approved by coordinator admin in control-plane UI/API.

Then restart service:

```bash
sudo launchctl kickstart -k system/io.edgecoder.runtime
```

## Runtime modes

`EDGE_RUNTIME_MODE` supports:

- `worker`
- `all-in-one`
- `coordinator`
- `control-plane`
- `inference`
- `ide-provider`

`AGENT_MODE` (when `EDGE_RUNTIME_MODE=worker`) supports:

- `swarm-only` (default)
- `ide-enabled`

`AGENT_CLIENT_TYPE`:

- Purpose: runtime flavor label used in coordinator/control-plane telemetry.
- Default: `edgecoder-native` (recommended for standard installs).
- Change only when integrating a non-standard runtime profile.
- Example values: `edgecoder-native`, `openclaw`, `claude-local`.

If you want one machine to do both mesh work and IDE provider duties:

- Set primary service as worker:
  - `EDGE_RUNTIME_MODE=worker`
  - `AGENT_MODE=ide-enabled`
- Also run a second process/service with:
  - `EDGE_RUNTIME_MODE=ide-provider`

The single packaged launchd unit runs one runtime mode at a time, so dual-role requires a second process or service unit.

## Service operations

Check status:

```bash
sudo launchctl print system/io.edgecoder.runtime
```

Tail logs:

```bash
sudo tail -f /var/log/edgecoder/runtime.log /var/log/edgecoder/runtime.err.log
```

Stop service:

```bash
sudo launchctl bootout system /Library/LaunchDaemons/io.edgecoder.runtime.plist
```

Start service:

```bash
sudo launchctl bootstrap system /Library/LaunchDaemons/io.edgecoder.runtime.plist
```

## Common local install issues

- Installer fails in script phase:
  - Usually root cannot find your Node install (common with `nvm`).
  - Ensure Node 20+ exists at a system path (for example `/opt/homebrew/bin/node`), or set:
    - `NODE_BIN=/opt/homebrew/bin/node` in `/etc/edgecoder/edgecoder.env`
- Service bootstraps but worker does not run:
  - Check logs in `/var/log/edgecoder/runtime.err.log`
  - Re-run:
    - `sudo launchctl kickstart -k system/io.edgecoder.runtime`
