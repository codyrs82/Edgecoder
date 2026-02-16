# macOS Installer and Deployment

This guide packages EdgeCoder into a `.pkg` that installs a managed `launchd` service on macOS machines.

## What gets installed

- Runtime files under `/opt/edgecoder/app`
- Service launcher script at `/opt/edgecoder/bin/edgecoder-runtime.sh`
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

After installation, edit runtime config:

```bash
sudo nano /etc/edgecoder/edgecoder.env
```

Recommended worker config:

```dotenv
EDGE_RUNTIME_MODE=worker
AGENT_ID=mac-worker-001
AGENT_OS=macos
AGENT_MODE=swarm-only
AGENT_REGISTRATION_TOKEN=<token-from-portal-node-enrollment>
COORDINATOR_URL=http://<coordinator-host>:4301
MESH_AUTH_TOKEN=<token-if-required>
LOCAL_MODEL_PROVIDER=edgecoder-local
```

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
