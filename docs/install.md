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
| Linux (Debian, Ubuntu, Fedora) | `curl -fsSLo install.sh https://edgecoder.io/install.sh && sudo bash install.sh --mesh-token <token>` |
| macOS | `curl -fsSLo install.sh https://edgecoder.io/install.sh && sudo bash install.sh --mesh-token <token>` |
| Windows (admin PowerShell) | `irm https://edgecoder.io/install.ps1 -OutFile install.ps1; .\install.ps1 -- --mesh-token <token>` |

`curl -fsSL https://edgecoder.io/install.sh | sudo bash -s -- --mesh-token <token>` still works,
but downloading first lets you read the script (and compare it with `deploy/install.sh` in this
repository) before it runs as root. The script does nothing until its last line, so a
truncated download runs nothing.

The bootstrap installs the pinned Node.js build into `/opt/edgecoder/node` (Windows:
`C:\Program Files\EdgeCoder\node`), Ollama, Docker on Linux from the distribution's packages
(Docker Desktop is installed by hand on Windows and macOS) and the NVIDIA container toolkit
when an NVIDIA GPU is present. It then installs a **signed, prebuilt agent release** into
`/opt/edgecoder/app` (Windows: `C:\Program Files\EdgeCoder\app`) and runs
`edgecoder-install apply` with every option you passed. Nothing is cloned or built on your
machine. Packages (`.pkg`, `.deb`, `.msi`) run `edgecoder-install apply --from-package` in their
post-install step and leave the same `edgecoder-install` command on the PATH.

Options of the bootstrap itself (everything else goes to `edgecoder-install`):

| Option | Meaning |
| --- | --- |
| `--version X` | Install release `agent-vX` (default: the newest `agent-v*` release on GitHub). |
| `--from-source [--ref REF]` | **Unverified**, for developers: clone and build `REF` (default `main`) instead of a signed release. On Linux and macOS it builds as the user who ran `sudo`, never as root. |

## How the installer verifies what it installs

Every download is checked before anything from it runs or is unpacked:

| What | From | Checked against |
| --- | --- | --- |
| Node.js 22.23.4 | `nodejs.org/dist/v22.23.4/` official tarball / zip | SHA-256 pinned in the script, per OS and arch |
| EdgeCoder agent | GitHub release `agent-vX`: `edgecoder-agent-agent-vX-<os>-<arch>.tar.gz` | `SHA256SUMS`, whose minisign signature must verify with the release key below **and** name this tag |
| Ollama 0.40.7 | `github.com/ollama/ollama/releases/download/v0.40.7/` official archive | SHA-256 pinned in the script |
| Docker (Linux) | the distribution's `docker.io` / `moby-engine` package | the distribution's own apt/dnf package signatures |
| NVIDIA container toolkit | NVIDIA's apt repository | repo key fingerprint `C95B 321B 61E8 8C18 09C4 F759 DDCA E044 F796 ECB0`, pinned |

If Docker is missing and no distribution package is available, the installer prints how to
install it instead. Docker's own repository key has fingerprint
`9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88`; check it if you add that repository.

The release check runs in that pinned Node (`verify-release.js`, embedded in both
`install.sh` and `install.ps1`), because the obvious tools are not everywhere: macOS ships
LibreSSL, which cannot verify Ed25519, and minisign is rarely installed. Node's crypto verifies
Ed25519 and BLAKE2b on every platform, and the Node binary itself is trusted through the
SHA-256 in the script. Order: download Node and check its hash; download the release tarball,
`SHA256SUMS` and `SHA256SUMS.minisig`; verify the signature on `SHA256SUMS` with the pinned key
and check the signed comment says `tag:<this tag>`; check the tarball's SHA-256 against
`SHA256SUMS`; only then unpack it. Any failure stops the install with nothing changed.

Releases are built in CI by `.github/workflows/agent-release.yml` when an `agent-v*` tag is
pushed: one tarball per target (`linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`,
`win-x64`), `SHA256SUMS`, and a signature made with the `AGENT_RELEASE_SIGNING_KEY` secret. The
workflow checks the result with the installer's own verifier and pinned key before publishing.
`scripts/set-release-signing-key.sh` creates the key, stores the private half as that secret
(it is never written to disk) and pins the public half in the installers and on this page.

### Release public key

<!-- release-pubkey -->
Not set yet: run `scripts/set-release-signing-key.sh`, which writes the key here.
<!-- /release-pubkey -->

### Verifying a release by hand

With [minisign](https://jedisct1.github.io/minisign/) (`brew install minisign`,
`apt install minisign`):

```bash
TAG=agent-v1.0.0; T=linux-x64     # or linux-arm64, darwin-arm64, darwin-x64, win-x64
BASE=https://github.com/codyrs82/Edgecoder/releases/download/$TAG
curl -fsSLO "$BASE/SHA256SUMS" -O "$BASE/SHA256SUMS.minisig" -O "$BASE/edgecoder-agent-$TAG-$T.tar.gz"
minisign -Vm SHA256SUMS -P <release public key above>   # prints the trusted comment: tag:agent-v1.0.0 ...
sha256sum -c SHA256SUMS --ignore-missing                  # macOS: shasum -a 256 -c SHA256SUMS --ignore-missing
```

Check that the trusted comment names the tag you downloaded. Without minisign, `node
scripts/release/minisign.mjs verify SHA256SUMS <public key>` in a checkout does the same check.

### Testing the installer

`EDGECODER_INSECURE_TEST_ONLY_RELEASE_PUBKEY` replaces the pinned key. It exists only for
`tests/install/signed-release.test.ts` and `tests/install-dryrun/run.sh`, which sign fixture
releases with a throwaway key; the installer prints a warning when it is set. **Never set it on
a real host**: whoever chooses that key chooses what the installer runs as root.
`EDGECODER_RELEASE_BASE_URL` and `EDGECODER_RELEASE_API_URL` change where releases are fetched
from, which cannot weaken the check.

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
Parallel model calls are sized by the same memory (4 at 32 GB or more, 2 at 16 GB, else 1): the
agent gets `AGENT_PARALLEL_INFERENCE` and its Ollama server the matching `OLLAMA_NUM_PARALLEL`.

The agent reports the GPU it owns (`nvidia-smi`, `rocm-smi`, or Apple silicon's unified memory),
so the coordinator prices it in the right class (an RTX 6000 Ada is `gpu.dc40`, an H100
`gpu.dc80`). The installer does not write `AGENT_GPU_*`: those override detection inside
containers, and an overridden profile re-proves its tier every session.

## Service accounts

No service runs as root or SYSTEM.

| | Runs as | Binaries | Writable by the service |
| --- | --- | --- | --- |
| Linux | `edgecoder` system user (`useradd --system`, no login shell) | root-owned node, ollama and app dir | its own `/var/lib/edgecoder/agent-n` (systemd `StateDirectory`), the model store, `/var/log/edgecoder` |
| macOS | `_edgecoder` role account (hidden, uid/gid 300-399, shell `/usr/bin/false`), LaunchDaemons so the agents start at boot without a login | root-owned node, ollama and app dir | `/var/lib/edgecoder/agent-n` (its `HOME`), the model store, `/var/log/edgecoder` |
| Windows | the user who ran the installer, at that user's logon, with a limited (non-elevated) token | Ollama from that user's profile, as installed | `ProgramData\EdgeCoder\ollama`, `logs`, `state` |

On Linux and macOS, `edgecoder-install apply` checks that node, ollama and the app dir can only be
changed by root: every path component up to `/` is root-owned and not group- or world-writable,
and on macOS so is every library the binary links (dylibs and rpaths). A binary that fails (nvm
under `$HOME`, Homebrew under `/opt/homebrew`, `/Applications`, which admin users can write) is
copied into `/opt/edgecoder/libexec/<node|ollama>`, owned by root, and the services run the copy.
If the copy still links libraries a user can replace, apply stops. Homebrew's `node` does (it
links `/opt/homebrew/opt/*` dylibs), so on macOS `install.sh` installs the self-contained
nodejs.org build into `/opt/edgecoder/node`. Re-run `apply` after upgrading Ollama to refresh
the copy. `/etc/edgecoder` and its env files (tokens) stay root's, mode 0600.

The Linux units are sandboxed: `NoNewPrivileges`, `ProtectSystem=strict` (only the paths above
are writable), `ProtectHome`, `PrivateTmp`, `ProtectKernelTunables`, `ProtectKernelModules`,
`ProtectControlGroups`, `RestrictSUIDSGID`, `LockPersonality`. GPUs (`/dev/nvidia*`) and the V8
JIT are left alone.

Windows has no passwordless service identity without `SeImpersonatePrivilege` (Local Service and
Network Service have it, which leads back to SYSTEM), and Docker Desktop is per user, so the tasks
run as the installing user. Run the installer from an elevated prompt of the account the agents
should use; it refuses to run as SYSTEM. The agents start when that user logs on.

**Docker tradeoff.** With `SANDBOX_MODE=docker` the Linux `edgecoder` user joins the `docker`
group. Access to the Docker socket is equivalent to root on the host, so the sandbox for swarm
tasks costs this isolation: a compromised agent can become root through Docker. Use
`--sandbox none` on hosts where that is not acceptable (the agents then take no swarm tasks).
On macOS, Docker Desktop's socket belongs to the logged-in user and `_edgecoder` cannot use it;
the plan warns, and the agents register but take no swarm tasks until a Docker daemon the
account can reach is set up.

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
| `--model TAG` | Ollama model for every instance (default: the strongest that fits each instance's VRAM, see the table below; on a Mac or CPU host the recommended model for its memory). |
| `--layout per-gpu\|mixed\|single` | How GPUs become instances. `per-gpu`: one model per card (the most parallel work). `mixed`: half the cards one per card, the rest in pairs for a bigger model (default on 4+ cards of 40 GB or more). `single`: every card pooled for the biggest model. |
| `--gpus-per-instance N` | Pool N GPUs per instance (overrides `--layout`): e.g. 2 for `gpt-oss:120b` on 48 GB cards, 4 for `qwen3:235b`, 8 for `qwen3-coder:480b`. |
| `--per-gpu` | Same as `--layout per-gpu`. |
| `--single` | Same as `--layout single`: one agent with every GPU pooled. |
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
sudo edgecoder-install status
```

By default the eight cards run the **mixed** layout: `box-gpu0` … `box-gpu3` each run
`qwen3-coder:30b` (fast, four parallel calls per card) and `box-gpu4-5` / `box-gpu6-7` each pool two
cards for `gpt-oss:120b`. The network gets both quick agent work and a much stronger model. Each
instance's model is the strongest that fits its VRAM:

| VRAM per instance | Model |
|---|---|
| 320 GB+ (7–8 cards) | `qwen3-coder:480b` (290 GB) |
| 160 GB+ (4 cards) | `qwen3:235b` (142 GB) |
| 80 GB+ (2 cards) | `gpt-oss:120b` (65 GB) |
| 24 GB+ (1 card) | `qwen3-coder:30b` (19 GB) |

Other layouts: `--layout per-gpu` (eight instances, the most throughput), `--layout single`
(one instance with all eight cards: `qwen3-coder:480b`), `--gpus-per-instance 4` (two instances of
`qwen3:235b`). `--model TAG` picks the model yourself, e.g. `--gpus-per-instance 1 --model
llama3.3:70b`. Run `sudo edgecoder-install plan` first to see the ids, cards and models.

The host must not be rented out on a GPU marketplace at the same time: the marketplace's host
daemon and EdgeCoder's Ollama instances would compete for the same cards, and a marketplace
container has no Docker daemon for the task sandbox.

## Building the packages

`npm run build:macos-installer`, `npm run build:linux-deb`, `npm run build:windows-msi` stage
`dist/` (including `dist/install/`) with production dependencies. Their post-install hooks call
`edgecoder-install apply --from-package`.
