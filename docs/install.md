# Installing EdgeCoder agents

One installer, every platform. The macOS package, the Linux package, the Windows installer and
the one-line bootstraps all run the same program, `edgecoder-install`
(`src/install/cli.ts`). It detects the hardware, plans one agent (and one Ollama server) per
GPU, writes the env files and the platform services, and starts them. Adding an installer
feature means adding it to `src/install/options.ts`; `tests/install/parity.test.ts` fails if a
platform entry point or this page falls behind.

## One line

| Platform | Command |
| --- | --- |
| Linux (Debian, Ubuntu, Fedora) | `curl -fsSL https://edgecoder.io/install.sh \| sudo bash -s -- --mesh-token <token>` |
| macOS | `curl -fsSL https://edgecoder.io/install.sh \| sudo bash -s -- --mesh-token <token>` |
| Windows (admin PowerShell) | `irm https://edgecoder.io/install.ps1 -OutFile install.ps1; .\install.ps1 -- --mesh-token <token>` |

The bootstrap installs Node 22, Ollama, Docker (Linux; Docker Desktop is required by hand on
Windows and macOS) and the NVIDIA container toolkit when an NVIDIA GPU is present, builds
EdgeCoder into `/opt/edgecoder/app` (Windows: `C:\Program Files\EdgeCoder\app`), and runs
`edgecoder-install apply` with every option you passed. Packages (`.pkg`, `.deb`, `.msi`) run
`edgecoder-install apply --from-package` in their post-install step and leave the same
`edgecoder-install` command on the PATH.

## What gets created

For a host with N discrete GPUs, N instances; otherwise one:

| Instance | Linux (systemd) | macOS (launchd) | Windows (scheduled tasks) |
| --- | --- | --- | --- |
| Ollama server n, bound to `127.0.0.1:1143(4+n)`, pinned with `CUDA_VISIBLE_DEVICES=n` | `edgecoder-ollama-n.service` | `io.edgecoder.ollama.n` | `EdgeCoder\ollama-n` |
| Agent n (`AGENT_ID=<host>-gpu<n>`), env in `agent-n.env` | `edgecoder-agent-n.service` | `io.edgecoder.agent.n` | `EdgeCoder\agent-n` |

Env files live in `/etc/edgecoder` (Windows `C:\ProgramData\EdgeCoder`); models are shared in
`/var/lib/edgecoder/ollama` so each model downloads once. The model per instance is the best
catalog model that fits the GPU's memory (recommended first, coding before general: 24 to 80 GB →
`qwen3-coder:30b`, 12 to 16 GB → `qwen3.5:9b`, 8 GB → `qwen3.5:4b`); override with `--model`.

The agent reports the GPU it owns (`nvidia-smi`, `rocm-smi`, or Apple silicon's unified memory),
so the coordinator prices it in the right class (an RTX 6000 Ada is `gpu.dc40`, an H100
`gpu.dc80`). `AGENT_GPU_*` variables still override detection inside containers.

## Enrolment

Every instance needs a registration token from the portal (Dashboard → Enroll node, node id =
the agent id the plan prints). Pass them with `--token <agent-id>=<token>` (repeatable), a
`--tokens-file`, or one `--token <token>` for all instances. Running `apply` again with tokens
rewrites the env files and restarts the services; nothing else changes.

To do it in one run, create a portal API key (edgecoder.io → Settings → API keys, it starts
with `eck_`) and pass it as `--enroll <api-key>`, or better, in the `EDGECODER_API_KEY`
environment variable so it stays out of shell history and process listings. The installer
self-registers every instance that has no `--token` with the portal (`POST /nodes/enroll`,
authenticated as `Authorization: Bearer <api-key>`) and applies each returned registration token
automatically. The nodes are owned by the key's account; its email must be verified for agents
to be approved. A portal session token still works in place of the key. The key is only sent to
the portal and is never printed or written to the service env files. A node that already has a
`--token` is left alone, and a node whose enrolment fails is skipped with a warning so the rest
still install.

`sudo` drops most environment variables, so put the variable after `sudo`:

```bash
read -rs EDGECODER_API_KEY   # paste the key; nothing is echoed or saved in history
curl -fsSL https://edgecoder.io/install.sh | sudo EDGECODER_API_KEY="$EDGECODER_API_KEY" bash -s -- --mesh-token "$MESH" --pull-models
# later runs: sudo EDGECODER_API_KEY="$EDGECODER_API_KEY" edgecoder-install apply
```

## Commands

| Command | Does |
| --- | --- |
| `detect` | Print the detected CPU, RAM and GPUs. |
| `plan` | Show the instances, models and services `apply` would create. |
| `apply` | Write env files and services for every instance, enable and start them. |
| `status` | Show the state of every EdgeCoder service on this host. |
| `remove` | Stop and remove the EdgeCoder services and env files (keeps models). |
| `help` | Show the options. |

## Options (identical on every platform)

| Option | Meaning |
| --- | --- |
| `--coordinator-url URL` | Coordinator to join (default `https://coordinator.edgecoder.io`). |
| `--portal-url URL` | Portal for enrolment and discovery (default `https://edgecoder.io`). |
| `--mesh-token TOKEN` | Mesh auth token for the coordinator. |
| `--token [AGENT_ID=]TOKEN` | Registration token; repeatable. Without `AGENT_ID=` it applies to every instance. |
| `--tokens-file PATH` | File of `AGENT_ID=TOKEN` lines. |
| `--enroll API_KEY` | Portal API key (`eck_...`) or session token; `EDGECODER_API_KEY` is the same without the flag. Self-enrol each un-tokened instance and apply the registration token the portal returns, so install and enrolment happen in one run. |
| `--model TAG` | Ollama model for every instance (default: largest coding model that fits). |
| `--per-gpu` | One agent and one Ollama server per discrete GPU (default when GPUs are present). |
| `--single` | One agent for the whole host. |
| `--instances N` | Exact number of instances (overrides `--per-gpu` / `--single`). |
| `--sandbox auto\|docker\|none` | Swarm task sandbox; `auto` uses Docker when present. |
| `--agent-id-prefix NAME` | Node id prefix (default: hostname). |
| `--pull-models` | Pull each instance's model after the services start. |
| `--dry-run` | Print what would be written and run; change nothing. |
| `--json` | Machine-readable output. |
| `--from-package` | Non-interactive mode used by the package post-install hooks. |
| `--config-dir DIR` | Config directory. |
| `--app-dir DIR` | Installed app directory containing `dist/`. |
| `--node-bin PATH` | Node binary for the services. |
| `--ollama-bin PATH` | Ollama binary. |

Environment defaults: `EDGECODER_COORDINATOR_URL`, `EDGECODER_PORTAL_URL`,
`EDGECODER_MESH_TOKEN`, `EDGECODER_REGISTRATION_TOKEN`, `EDGECODER_ENROLL_TOKEN`,
`EDGECODER_API_KEY` (same as `--enroll`; takes precedence over `EDGECODER_ENROLL_TOKEN`).

## Example: an 8× RTX 6000 Ada host

```bash
read -rs EDGECODER_API_KEY   # eck_... from Settings → API keys
curl -fsSL https://edgecoder.io/install.sh | sudo EDGECODER_API_KEY="$EDGECODER_API_KEY" bash -s -- --mesh-token "$MESH" --pull-models
# detects box-gpu0 … box-gpu7 (48 GB each, qwen3-coder:30b) and enrols all eight with the key
sudo edgecoder-install status
```

The host must not be rented out on a GPU marketplace at the same time: the marketplace's host
daemon and EdgeCoder's Ollama instances would compete for the same cards, and a marketplace
container has no Docker daemon for the task sandbox.

## Building the packages

`npm run build:macos-installer`, `npm run build:linux-deb`, `npm run build:windows-msi` stage
`dist/` (including `dist/install/`) with production dependencies. Their post-install hooks call
`edgecoder-install apply --from-package`.
