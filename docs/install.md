# Installing EdgeCoder agents

One installer, every platform. The macOS package, the Linux package, the Windows installer and
the one-line bootstraps all run the same program, `edgecoder-install`
(`src/install/cli.ts`). It detects the hardware, plans one agent (and one Ollama server) per
GPU, writes the env files and the platform services, and starts them. Adding an installer
feature means adding it to `src/install/options.ts`; `tests/install/parity.test.ts` fails if a
platform entry point or this page falls behind.

**Setting up a rented cloud GPU or another Linux server for the first time?** Follow
[Run EdgeCoder on a cloud GPU or Linux server](https://docs.edgecoder.io/guide/cloud-gpu-server)
(source: [site-docs/guide/cloud-gpu-server.md](../site-docs/guide/cloud-gpu-server.md)): SSH keys,
providers and GPU sizes, the install key, the vLLM switch, checks, removal and troubleshooting,
step by step. This page is the reference behind it.

## One line

| Platform | Command |
| --- | --- |
| Linux (Debian, Ubuntu, Fedora) | `curl -fsSLo install.sh https://edgecoder.io/install.sh && sudo bash install.sh --mesh-token <token>` |
| macOS | `curl -fsSLo install.sh https://edgecoder.io/install.sh && sudo bash install.sh --mesh-token <token>` |
| Windows (admin PowerShell) | `irm https://edgecoder.io/install.ps1 -OutFile install.ps1; .\install.ps1 -- --mesh-token <token>` |

Download the script, check it, then run it. Do not pipe it into a shell: downloading first lets
you read what will run as root.

```bash
curl -fsSLo install.sh https://edgecoder.io/install.sh
# check: it must be identical to deploy/install.sh in this repository
curl -fsSL https://raw.githubusercontent.com/codyrs82/Edgecoder/main/deploy/install.sh | diff - install.sh && echo identical
less install.sh                      # optional: read it
sudo bash install.sh --mesh-token <token>
```

The script itself then verifies everything it downloads (next section). It does nothing until
its last line, so a truncated download runs nothing.

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
```
untrusted comment: minisign public key 3BB9F7E747849FA9
RWSpn4RH5/e5O8Qd9rasofZ9OVjMNPlvimRunFeWb0LEMylKCiS9kwgI
```

Key ID: `3BB9F7E747849FA9`
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
| Ollama server n, bound to `127.0.0.1:1143(4+n)` (or the next free port), pinned with `CUDA_VISIBLE_DEVICES=n` | `edgecoder-ollama-n.service` | `io.edgecoder.ollama.n` | `EdgeCoder\ollama-n` |
| Agent n (`AGENT_ID=<host>-gpu<n>`), env in `agent-n.env` | `edgecoder-agent-n.service` | `io.edgecoder.agent.n` | `EdgeCoder\agent-n` |

A port another program already holds (the distribution's own `ollama.service`, the Ollama app) is
skipped: on Linux and macOS `plan`/`apply` check who listens on each port (`ss` / `lsof`) and give
that instance the next free one, with a note naming the holder (`sudo systemctl disable --now
ollama` frees 11434 for the next run). `edgecoder-install status` shows the holder next to an Ollama
service that isn't running, e.g. `edgecoder-ollama-0.service: activating (port 11434 in use by
ollama.service ...)`. After an `apply` with tokens or an install key, each agent gets a line
`Enrolled as <id> ✓`, or why it isn't (no token, a token for another node id, key enrolment failed).

Env files live in `/etc/edgecoder` (Windows `C:\ProgramData\EdgeCoder`); models are shared in
`/var/lib/edgecoder/ollama` so each model downloads once. The model per instance is the best
catalog model that fits the GPU's memory (recommended first, coding before general: 24 to 80 GB →
`qwen3-coder:30b`, 12 to 16 GB → `qwen3.5:9b`, 8 GB → `qwen3.5:4b`); override with `--model`.
Parallel model calls are sized by the same memory and the model: as many 8k-token contexts as fit
next to the model (90% of a GPU's VRAM, 60% of RAM), at most 2 below 31 GB and 4 above, and on a
host without a GPU at most one per two CPUs (`src/swarm/parallelism.ts`). The agent gets `AGENT_PARALLEL_INFERENCE` and its Ollama server the
matching `OLLAMA_NUM_PARALLEL`.

The agent reports the GPU it owns (`nvidia-smi`, `rocm-smi`, or Apple silicon's unified memory),
so the coordinator prices it in the right class (an RTX 6000 Ada is `gpu.dc40`, an H100
`gpu.dc80`). An instance whose Ollama pools several cards (`CUDA_VISIBLE_DEVICES=0,1`) reports the
first card's model with the pool's summed VRAM and a `count`. The installer does not write
`AGENT_GPU_*`: those override detection inside containers, and an overridden profile re-proves its
tier every session.

### AMD and Intel GPUs without ROCm (Vulkan)

Cards that ROCm does not support (for example the RX 5700 XT, `gfx1010`), or hosts without the ROCm
tools, are still found: from sysfs (`/sys/class/drm/card*/device/{vendor,mem_info_vram_total}`),
with the ROCm target from the KFD topology and the Vulkan device numbers from
`vulkaninfo --summary` when it is installed. `edgecoder-install detect`, `plan` and `apply` then
print the flags that run Ollama on those cards through Vulkan, for example:

```bash
sudo edgecoder-install apply --keep-config --ollama-env OLLAMA_VULKAN=1 --ollama-env GGML_VK_VISIBLE_DEVICES=1,2,3,4
```

`--ollama-env KEY=VALUE` (repeatable) is written into every instance's Ollama unit and recorded in
`EDGECODER_INSTALL_ARGS`, so every later run, `update` and package upgrade keeps it; `KEY=` removes
one. With `OLLAMA_VULKAN=1` and no `GGML_VK_VISIBLE_DEVICES`, each instance gets its own cards'
Vulkan device numbers.

The agent claims a GPU class for such a card only once the GPU is confirmed: Ollama's `/api/ps`
shows the served model (or the largest loaded one) at least 90% in VRAM, or, with nothing loaded,
the agent's own GPU benchmark clears the GPU class floor. Until then (or when the model runs
mostly on the CPU) it registers as CPU, and the coordinator's benchmark challenge still decides the
tier above a class's base ([hardware verification](../src/swarm/hardware-verification.ts)).
NVIDIA, ROCm-supported AMD and Apple silicon are claimed as detected, as before.

**Your own settings survive updates.** `apply` and `update` rewrite
`/etc/systemd/system/edgecoder-ollama-<n>.service` but never touch the files in its drop-in
directory, `/etc/systemd/system/edgecoder-ollama-<n>.service.d/` (the only one they manage there is
`vllm-switch.conf`, for `--engine vllm`). Put custom `Environment=` lines in a drop-in such as
`override.conf` (`sudo systemctl edit edgecoder-ollama-0`); a drop-in wins over the unit's own lines.

### vLLM instead of Ollama on a GPU server

The installer sets every instance up with Ollama. On a datacenter GPU host whose model slots are
the bottleneck, an instance can run its model on **vLLM** instead (continuous batching: several
calls at once on the same cards):

```bash
sudo edgecoder-install apply --vllm-profile auto                    # picks the profile from nvidia-smi, installs vLLM if needed
sudo edgecoder-install apply --engine vllm --vllm-profile a16x2     # a named profile
sudo edgecoder-install apply --engine vllm --vllm-model QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ --vllm-slots 2
sudo edgecoder-install apply --engine ollama                        # back to Ollama
```

`--engine vllm` writes `EDGECODER_ENGINE=vllm`, `VLLM_URL`, `VLLM_MODEL` and `VLLM_MAX_SLOTS` into
`agent-<n>.env`, creates `/etc/edgecoder/vllm-<n>.active` and the drop-in
`edgecoder-ollama-<n>.service.d/vllm-switch.conf` (`ConditionPathExists=!` that marker, so the
instance's Ollama cannot start, not even through the agent unit's `Wants=`), enables and starts
`edgecoder-vllm@<n>` (installing it with `scripts/linux/vllm/install-vllm.sh` when
`--vllm-profile` is given and it is missing), stops Ollama and restarts the agent.
`--vllm-profile auto` picks each instance's profile from its GPUs (`nvidia-smi`): one card of 80 GB
or more `a100-80`, 44 to 48 GB `gpu-48gb`, 38 to 43 GB `a100-40`, 22 to 37 GB `gpu-24gb`, two
15 to 21 GB cards pooled with `--single` `a16x2`; anything smaller (or not NVIDIA) is refused with
the reason, before anything changes. `plan --vllm-profile auto` shows the pick
(`[installs vLLM, profile ...]`). A running vLLM is
never restarted by a re-run. **Every later run without `--engine`** (a package upgrade, a re-run
with new tokens) reads the engine back from `agent-<n>.env` and the marker and keeps it, settings
included. `--engine ollama` stops vLLM, removes the marker, the drop-in and the engine lines, and
starts Ollama again; `vllm-<n>.env`, the venv and the weights stay for the next switch. Sizing for 2× A16 and A100 80 GB, the variables, and the way back to
Ollama: [docs/inference-engines.md](inference-engines.md). Apple silicon's equivalent is MLX
(`EDGECODER_ENGINE=mlx`), described there too.

## Memory safety

EdgeCoder never lets network work push a host into memory exhaustion. (On 2026-11-16 a load test
sent calls for six models to a 48 GB Mac; its Ollama kept about ten models loaded, ~120 GB, and the
Mac was force-restarted.) Three layers, all on by default:

**1. The Ollama EdgeCoder starts** (the desktop app's bundled Ollama, the installer's service units,
the agent's own auto-start) gets, unless the environment already sets them:

| RAM | `OLLAMA_MAX_LOADED_MODELS` | `OLLAMA_NUM_PARALLEL` (desktop app) | other |
| --- | --- | --- | --- |
| up to 32 GB | 1 | 1 below 15 GB, else 2 | `OLLAMA_KEEP_ALIVE=5m` (desktop app), `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0` |
| 33 to 63 GB | 2 | 2 | same |
| 64 GB and more | 2 | 4 | same |

Flash attention with a `q8_0` cache roughly halves the KV cache (Ollama 0.5 and newer; the bundled
Ollama is 0.40.x). The installer's GPU instances keep their per-instance `OLLAMA_NUM_PARALLEL` and
keep-alive (dedicated hosts) and get the loaded-model cap by the instance's memory.

**2. A memory budget in the agent** (`src/swarm/memory-budget.ts`): 60% of RAM
(`AGENT_MEMORY_BUDGET_PCT`), or 90% of a discrete GPU's VRAM. A model needs its weights (its file
size), 0.5 GB runtime, and a KV cache per 8k tokens per parallel slot (Ollama allocates `num_ctx` ×
`OLLAMA_NUM_PARALLEL`): the model's own, read from Ollama (`/api/show`: layers × KV heads × head
size, f16), else max(0.25, params × 0.12) GB. The agent:

- lowers its context window, then its parallel slots, until its model fits, even an explicit
  `AGENT_CONTEXT_WINDOW`, and logs and reports the effective values;
- advertises to the coordinator only the installed models that fit the budget on their own, and
  serves at most as many distinct models as fit together (`AGENT_MAX_NETWORK_MODELS`, never past
  `OLLAMA_MAX_LOADED_MODELS`); the rest stay local-only. Loaded models come first, so the
  coordinator keeps sending the model already in memory;
- before a network call loads a model, checks it fits next to what Ollama has loaded (`/api/ps`),
  unloads idle network models first (`keep_alive: 0`), and otherwise hands the call back (a
  `memory_` error: the coordinator gives it to another agent). The owner's own chat model is never
  unloaded to make room: local chats come first;
- reports its memory (pressure, budget, loaded models, served models with their footprint) with
  each heartbeat; an updated coordinator uses it for admission control.

**The context window** every network call is served with (Ollama runs the model with that
`num_ctx`, and the agent reports it with each pull and heartbeat) is sized by the agent itself; no
host needs to set it:

- `AGENT_CONTEXT_WINDOW` (or `--context-window`, or a remote change from the portal) wins;
- a **discrete GPU** (NVIDIA, AMD, Intel; a pool of cards counts their VRAM together): the KV cache
  gets what is left of 90% of the VRAM after the model's weights, 0.5 GB runtime and 0.5 GB per
  card. The window is the largest of 64k / 32k / 16k / 8k that fits for every slot, never past the
  model's own context length. Below 32k with several slots, the slots come down when one slot
  reaches 32k (an agentic call is a 7-19k prompt and a 4k reply), unless `AGENT_PARALLEL_INFERENCE`
  fixes them. The agent reads the model's size and KV geometry from Ollama a few seconds after it
  starts, before loading it; a card only Vulkan drives is sized this way once Ollama is seen
  running the model on it (until then, by RAM);
- a CPU-only host, Apple silicon (unified memory), or a model too big for the VRAM: by RAM, as in
  the table below.

The memory budget then has the last word (above). Examples: four 8 GB AMD cards (32 GB) with
`qwen3-coder:30b` (19 GB, 0.75 GB of KV per 8k) and 23 GB of RAM (one slot): 64k, or 32k with two
slots (`OLLAMA_NUM_PARALLEL=2`); an 8 GB RTX A2000 with an 8B
model (5 GB, about 1.1 GB of KV per 8k): 8k; the same card with `qwen2.5-coder:7b`: 32k with one
slot.

Default budgets and what fits at the served window on a CPU or Apple silicon host (2 slots up to
63 GB, 4 above):

| RAM | Budget | 7B | 9B | 14B | 30B |
| --- | --- | --- | --- | --- | --- |
| 16 GB | 9.6 GB | 16k | 8k | no | no |
| 32 GB | 19.2 GB | 32k | 32k | 16k | no |
| 48 GB | 28.8 GB | 32k | 32k | 32k | 8k |
| 64 GB | 38.4 GB | 32k (4 slots) | 32k (4 slots) | 32k (4 slots) | 8k (4 slots) |

**3. A memory pressure guard** (`src/swarm/memory-pressure.ts`, `AGENT_MEMORY_GUARD`): macOS
`kern.memorystatus_vm_pressure_level` and `vm_stat`, Linux `MemAvailable` and PSI
(`/proc/pressure/memory`).

| Level | macOS | Linux | The agent |
| --- | --- | --- | --- |
| warning | kernel level 2, under 8% available, or the compressor holding 40% of RAM | under 10% `MemAvailable`, or PSI some avg10 ≥ 25 | takes no new network work, unloads its idle models |
| critical | kernel level 4, or under 3% available | under 5%, or PSI full avg10 ≥ 10 | also cancels its running network calls and hands its claims back, unloads all but the owner's active model |

It resumes once the pressure has stayed lower for 30 s. The desktop app shows "Paused: this Mac is
low on memory" in Active work and Settings → Models, and Settings → Models lists what this machine
serves ("Serving on the network: qwen3.5:9b") and what stays local-only.

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

On Windows, `C:\ProgramData\EdgeCoder` is owned by Administrators, does not inherit the
ProgramData ACL (Administrators and SYSTEM full control, the task user read), and is locked before
any token is written. If that folder, or its `ollama`, `logs` or `state` subfolder, already exists
and is owned by an account other than Administrators, SYSTEM or the installing user, or is a
junction, `apply` stops: another user may have created it. Inspect and remove it, then re-run.

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

## Updates

Hosts installed with `install.sh` (Linux, and macOS without the `.pkg`) **update themselves**:
nobody has to re-run the installer for a fix. Every hour (plus a random delay of up to 10 minutes,
so a fleet does not restart at once), and within minutes of a release when the coordinator
announces it (the **nudge**, below), the host runs `edgecoder-install update`, which:

1. asks GitHub for the newest published, non-prerelease `agent-v*` release and stops if it is not
   newer than the installed one (it never downgrades);
2. downloads its tarball, `SHA256SUMS` and `SHA256SUMS.minisig` over HTTPS into a root-only (0700)
   staging directory beside `/opt/edgecoder/app`, and checks them exactly as `install.sh` does,
   against the release key pinned in the installed app (`src/install/release-key.ts`, the same key
   as in "Release public key" below; never one downloaded with the release). Nothing is unpacked
   before that check passes;
3. asks the new version's `plan --keep-config` whether it would run the same agents; if not (a new
   layout or naming), it stops and leaves the change to you;
4. asks each agent to stop taking new work and waits up to 10 minutes for running work to finish.
   Still busy: the agents take work again and the update waits for the next run;
5. moves `/opt/edgecoder/app` to `/opt/edgecoder/app.prev`, puts the new release in its place and
   runs its `apply --from-package --keep-config`, which keeps everything this host was set up with
   (env files, node ids, tokens, coordinator and portal URLs, mesh token, engines, tuning, models,
   `AGENT_REMOTE_CONTROL` / `AGENT_MODEL_ALLOWLIST`) and restarts the services;
6. checks that every agent service is running again and that each agent registered before the
   update registers again within 3 minutes. If not, it **rolls back** to `app.prev`, restarts that,
   and skips that release on later scheduled runs (`sudo edgecoder-install update` tries it again).

One previous version is kept in `/opt/edgecoder/app.prev`. Each run logs one line
(`edgecoder-update: updated agent-v1.2.0 -> agent-v1.3.0 ...`; Linux: `journalctl -u
edgecoder-update`, macOS: `/var/log/edgecoder/io.edgecoder.update.log`) and records the result in
`/etc/edgecoder/update-state.json`. `edgecoder-install status` shows the version, whether automatic
updates are on, and the last check with its result:

```
version: 1.3.0 (agent-v1.3.0, linux-x64)
auto-update: on (default; ...), edgecoder-update.timer active, next run Tue 2026-11-17 18:41:07 UTC
last update check: 2026-11-17T12:22:40.118Z: updated: updated agent-v1.2.0 -> agent-v1.3.0 (signature verified, agents healthy); ...
```

**Update now:** `sudo edgecoder-install update` (`--check` only reports whether a newer release
exists). **Turn automatic updates off:** `sudo edgecoder-install apply --auto-update off` (writes
`EDGECODER_AUTO_UPDATE=off` to `/etc/edgecoder/auto-update.env`, which every later run keeps, and
disables the timer); `--auto-update on` turns them back on. `EDGECODER_AUTO_UPDATE=off` in any
`/etc/edgecoder/*.env` also stops scheduled runs.

| Platform | Schedule |
| --- | --- |
| Linux | `edgecoder-update.timer` (`OnCalendar=hourly`, `RandomizedDelaySec=10min`, `Persistent=true`) starts `edgecoder-update.service`, a root oneshot. `edgecoder-update.path` starts the same service when an agent asks (the nudge). |
| macOS | `/Library/LaunchDaemons/io.edgecoder.update.plist` (root, every hour, up to 10 min of jitter inside the run when there is something to install; `WatchPaths` on the agents' request files for the nudge). |
| Windows | Not yet: the agents are scheduled tasks of the installing user and the app lives in `C:\Program Files`. Re-run `install.ps1` to update. |
| `.deb`, `.pkg`, `.msi`, `--from-source` | No schedule: update them the way they were installed. |

**The nudge: updates within minutes of a release.** Each coordinator looks up the newest
published, non-prerelease `agent-v*` release on GitHub (in the background, at most every 10
minutes; after a GitHub rate limit, not before its reset). When an agent registers or heartbeats
with an older version, the answer carries `updateAvailable: "agent-v1.3.0"`. The agent (which runs
unprivileged) then waits a random 0 to 10 minutes, so a fleet does not restart at once, and writes
`update-request` in its own state directory (`/var/lib/edgecoder/agent-<n>/update-request`). The
path unit (Linux) or `WatchPaths` (macOS) starts the usual root update run above, early. That is
all a nudge can do:

- the updater never reads the request file and never takes a version from the coordinator: it asks
  GitHub itself and installs only a release signed by the pinned key, with all the steps above
  (waiting for running work, `plan --keep-config`, health check, rollback);
- the agent ignores a hint that is not a plain `agent-vX.Y.Z` newer than what it runs (never equal
  or older), and asks at most once every 30 minutes whatever the coordinator says;
- the updater does nothing (not even the GitHub call) when it checked less than 5 minutes ago, so
  even an agent that writes the file nonstop causes at most 12 extra checks an hour;
- after GitHub answers 403 or 429 (rate limit; unauthenticated calls are limited to 60 an hour per
  IP, and a host makes about one an hour), scheduled runs wait until GitHub's reset (at least 15
  minutes, at most 6 hours) and record that in `update-state.json`.

A run that finds nothing newer stops there: agents are only drained and restarted when a newer,
verified release is installed. With automatic updates off (`EDGECODER_AUTO_UPDATE=off`) the agent
does not ask, the path unit (Linux) is disabled and the launchd job removed, and a run that starts
anyway does nothing. A coordinator operator can turn the hint off with `AGENT_UPDATE_HINTS=off`.

Worst case from a release to a host running it: about 10 minutes for the coordinator to see it,
up to 10 minutes of agent delay (plus up to 10 minutes of jitter on macOS), then the update itself
(up to 10 minutes waiting for running work, the download, 3 minutes of health check). Without a
coordinator nudge, the hourly check gets it within 70 minutes. Agents still busy after 10 minutes
are retried on the next hourly run.

**Hosts on the 6-hour schedule** (installed before this change) move to the hourly schedule and the
nudge with their next update, which still comes from the old timer (up to 7 hours). On macOS the
new schedule is written then but launchd loads it at the next reboot or `sudo edgecoder-install
apply` (an update cannot reload the job it runs in).

How the agent is asked to finish its work: an installed agent writes `agent-status.json` in its
own state directory (`/var/lib/edgecoder/agent-<n>`: registered, draining, running work) and handles
`SIGUSR2` (take no new work; lapses by itself after 15 minutes) and `SIGHUP` (take work again). No
port is opened for this. An agent that does not write the file (one from before this feature) is
restarted as before, handing its claims back on `SIGTERM`.

**Hosts installed before automatic updates** need one last manual run of the install command, with
the options they were installed with (it records the layout and model flags in each env file as
`EDGECODER_INSTALL_ARGS`, so later updates plan the same agents):

```bash
curl -fsSLo install.sh https://edgecoder.io/install.sh && sudo bash install.sh --mesh-token <token> [the options you installed with]
```

## Enrolment

Every instance needs a registration token from the portal (Settings → Nodes → Enroll a node).
A token belongs to one node id, and a coordinator refuses an agent whose id is not exactly that
enrolled name (`node_not_enrolled`), so the agent id must match the enrolment:

- **One instance** (one GPU, `--single`, or CPU only): the agent takes the node id the token was
  issued for. `apply` asks the portal (`GET /nodes/token-node`, authenticated with the token itself)
  and names the agent after the answer, printing a note when that differs from the id it would
  compute from the hostname. When the portal can't be reached, `--token <node-id>=<token>` names it.
  The Nodes page prints the install command with both filled in.
- **Several instances**: pass one `--token <agent-id>=<token>` per instance (repeatable) or a
  `--tokens-file`, with the agent ids `plan` prints. A bare `--token <token>` is refused there (one
  token can't be several node ids); a token for an id the host doesn't run is ignored with a warning.

Running `apply` again with tokens rewrites the env files and restarts the services; nothing else
changes. Running it again **without** tokens (an update with `install.sh`, `--vllm-profile`, a
package upgrade) keeps each instance's token from its `agent-<n>.env`, when that file is for the
same agent id; a one-instance host also keeps the node id its `agent-0.env` was written with.

An agent whose id isn't enrolled logs one line saying so (`This machine's id "<id>" isn't
enrolled ...`) and retries after 1, 2, 4 ... up to 15 minutes, and the owner's Settings → Nodes
lists the refused name when the agent presented one of the owner's tokens.

Tokens (`--token`, `--tokens-file`, `--mesh-token` and the ones the portal returns to `--enroll`)
may only contain `A-Z a-z 0-9 . _ ~ + / = -`, and `--portal-url` / `--coordinator-url` must be
`https://` (plain `http://` is accepted only for `localhost`, `127.x.x.x` and `[::1]`). `plan` and
`apply` refuse anything else before they change the host.

Command-line arguments are visible to every local user in the process list. Prefer
`--tokens-file` (mode 0600) or the `EDGECODER_REGISTRATION_TOKEN` / `EDGECODER_MESH_TOKEN`
environment variables over `--token` / `--mesh-token` on shared machines. `--json` output shows
token values as `<redacted>`.

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
curl -fsSLo install.sh https://edgecoder.io/install.sh   # check it as in "One line" above
sudo EDGECODER_API_KEY="$EDGECODER_API_KEY" bash install.sh --mesh-token "$MESH" --pull-models
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
| `update` | Update to the newest signed agent release (Linux, macOS): verify, wait for idle agents, swap, re-apply, health-check, roll back on failure ([Updates](#updates)). |
| `help` | Show the options. |

## Options (identical on every platform)

| Option | Meaning |
| --- | --- |
| `--coordinator-url URL` | Coordinator to join (default `https://coordinator.edgecoder.io`). |
| `--portal-url URL` | Portal for enrolment and discovery (default `https://edgecoder.io`). |
| `--mesh-token TOKEN` | Mesh auth token for the coordinator. |
| `--token [AGENT_ID=]TOKEN` | Registration token; repeatable. On a one-instance host the agent takes the token's node id; several instances need `AGENT_ID=` per token. |
| `--tokens-file PATH` | File of `AGENT_ID=TOKEN` lines. |
| `--enroll API_KEY` | Portal API key (`eck_...`) or session token; `EDGECODER_API_KEY` is the same without the flag. Self-enrol each un-tokened instance and apply the registration token the portal returns, so install and enrolment happen in one run. |
| `--model TAG` | Ollama model for every instance (default: the strongest that fits each instance's VRAM, see the table below; on a Mac or CPU host the recommended model for its memory). |
| `--context-window N\|auto` | Context window (tokens, 2048 to 131072) every network call is served with: `AGENT_CONTEXT_WINDOW`. Default: sized by the model and the GPU's free VRAM (RAM without a discrete GPU). `auto` clears a value set earlier, so this and later runs size it again. |
| `--parallel N\|auto` | Parallel model calls per instance, 1 to 16: the agent's `AGENT_PARALLEL_INFERENCE` and the instance's Ollama `OLLAMA_NUM_PARALLEL`. Default: sized by VRAM and model. `auto` clears a value set earlier. |
| `--ollama-env KEY=VALUE` | Extra environment for every instance's Ollama server; repeatable (for example `OLLAMA_VULKAN=1` for AMD cards ROCm does not support). Recorded in `EDGECODER_INSTALL_ARGS` and kept by later runs and updates; `KEY=` removes one. Systemd drop-ins in `edgecoder-ollama-<n>.service.d/` also survive updates and win over these. |
| `--keep-alive DUR` | How long Ollama keeps the model loaded after a call: a duration (`30m`, `1h30m`), seconds, or `-1` to never unload. Written as the agent's `AGENT_MODEL_KEEP_ALIVE` and the instance's Ollama `OLLAMA_KEEP_ALIVE`. Default `30m`. |
| `--engine ollama\|vllm\|mlx` | Engine that serves each instance's model ([inference engines](inference-engines.md)). `vllm` (Linux, NVIDIA): `edgecoder-vllm@<n>` serves it and the instance's Ollama stays off. `mlx` (Apple silicon): you run `mlx_lm.server`. Default: every instance keeps the engine it runs now (Ollama on a first install), so re-runs and upgrades never switch engines. |
| `--vllm-model ORG/REPO` | vLLM: the Hugging Face id it serves (`VLLM_MODEL`). Implies `--engine vllm`. Default: the value already set, else `VLLM_MODEL_ID` from `vllm-<n>.env`. |
| `--vllm-slots N` | vLLM: model calls at once, 1 to 16 (`VLLM_MAX_SLOTS`). Implies `--engine vllm`. Default: the value already set, else derived from vLLM's KV cache. |
| `--vllm-url URL` | vLLM: the server (`VLLM_URL`). Implies `--engine vllm`. Default `http://127.0.0.1:<8000+n>`. |
| `--vllm-profile auto\|a16x2\|a100-80\|a100-40\|gpu-48gb\|gpu-24gb` | vLLM: when it is not installed for an instance yet, run `scripts/linux/vllm/install-vllm.sh` with this profile (serve flags, model, slots) and download the weights. `auto` picks it from each instance's GPUs (`nvidia-smi`). Implies `--engine vllm`. |
| `--layout per-gpu\|mixed\|single` | How GPUs become instances. `per-gpu`: one model per card (the most parallel work). `mixed`: half the cards one per card, the rest in pairs for a bigger model (default on 4+ cards of 40 GB or more). `single`: every card pooled for the biggest model. |
| `--gpus-per-instance N` | Pool N GPUs per instance (overrides `--layout`): e.g. 2 for `qwen3-coder-next` on 48 GB cards, 4 for `qwen3:235b`, 8 for `qwen3-coder:480b`. |
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
| `--searxng on\|off`, `--no-searxng` | Local web search for your own chats (Linux; default `on`): SearXNG on `127.0.0.1:18888` (`edgecoder-searxng.service`, pinned and hash-verified), so your own chats search from this machine for free with no daily limit ([docs/web-tool.md](web-tool.md#searches-on-your-own-machine)). Kept in `/etc/edgecoder/searxng.env`, so later runs and updates keep it. |
| `--auto-update on\|off` | Scheduled updates to new signed releases (Linux, macOS; default `on`). Kept in `/etc/edgecoder/auto-update.env`, so later runs keep it ([Updates](#updates)). |
| `--keep-config` | Re-run with this host's configuration from its env files: coordinator and portal URLs, mesh token, the recorded layout and model flags (`EDGECODER_INSTALL_ARGS`), each instance's model and `MAX_CONCURRENT_TASKS`. Flags given now still win. `update` runs `apply --from-package --keep-config`. |
| `--check` | `update` only: report whether a newer release exists, change nothing. |
| `--scheduled` | `update` only: the timer's run. Does nothing when automatic updates are off; skips a release that already failed its health check here. |
| `--jitter SECONDS` | `update` only: wait a random time up to `SECONDS` first (the macOS schedule uses 3600). |

The tuning flags (`--context-window`, `--parallel`, `--keep-alive`) are recorded in each instance's
env file (`EDGECODER_INSTALL_TUNING`). A later run without them, such as a package upgrade's
`apply --from-package`, keeps the recorded values; pass a flag again to change its value. Edit
them through the flags rather than in the env file, which every run rewrites.

To go back to automatic sizing after pinning a value, pass `auto`: for example
`sudo edgecoder-install apply --keep-config --context-window auto` removes `AGENT_CONTEXT_WINDOW`
from every instance's env file and from the record, so later runs and updates keep sizing it
(`--parallel auto` does the same for the parallel count). A context window applied from the portal
is a separate override; see [Where changes are kept](#changing-models-from-the-portal). The portal's
**Automatic** box clears that override from the browser (agent 1.2.8 or later).

Environment defaults: `EDGECODER_COORDINATOR_URL`, `EDGECODER_PORTAL_URL`,
`EDGECODER_MESH_TOKEN`, `EDGECODER_REGISTRATION_TOKEN`, `EDGECODER_ENROLL_TOKEN`,
`EDGECODER_API_KEY` (same as `--enroll`; takes precedence over `EDGECODER_ENROLL_TOKEN`).

## Changing models from the portal

A headless host's models can be managed without SSH: sign in to the portal and open
**Settings > Nodes**. Under "Your machines' models" each agent enrolled to your account shows its
installed models (with sizes), the active model, its Ollama version, GPU and VRAM, RAM, free disk,
and its context window, parallel slots and keep-alive. For a connected machine you can:

- **Pull** a model, with download progress. Only models the host allows (below) are offered, and a
  pull that does not fit the free disk (download + 10% + 2 GiB) or the machine's memory (VRAM plus
  half the RAM on a GPU host, 75% of the RAM otherwise) is refused before it starts.
- **Use** an installed model as the active (network) model. The old model is unloaded and the new
  one loaded before the agent takes more work.
- **Remove** an installed model (never the active one).
- **Apply** a context window (2048 to 131072 tokens), parallel slots (1 to 8) and keep-alive (`-1`
  never unload, `0`, or up to `24h`). Context and keep-alive are sent with each Ollama request, so
  they take effect at once. Parallel slots are how many calls the agent sends at once; Ollama's own
  `OLLAMA_NUM_PARALLEL` lives in the Ollama unit, which the agent cannot change: above it, calls
  queue inside Ollama. Re-run `edgecoder-install apply --parallel N` to raise it.
- **Automatic** (next to the context window and the slots): tick it and press **Apply** to drop the
  value set from the portal, so the agent sizes it again (from the GPU's free VRAM after the
  weights, or the RAM without a discrete GPU), reloads the model if the window changed, and reports
  the new value. Each field shows the value in force and whether it is automatic, pinned here (the
  portal) or pinned by the machine's own config. A value the machine's own config sets
  (`AGENT_CONTEXT_WINDOW` / `AGENT_PARALLEL_INFERENCE` in `agent-N.env`, or the desktop app) wins
  over the portal, so Automatic is not offered for it: run
  `sudo edgecoder-install apply --keep-config --context-window auto` (or `--parallel auto`) on the
  machine, or change it in the app. Automatic needs agent 1.2.8 or later (or a desktop app with that
  agent); for an older agent the box is greyed out with a note to update it, because the older agent
  would refuse the command.
- **Reload model**: unload and load it again (after an Ollama upgrade, or to free memory).

Every command is listed under the machine with who sent it, when, and the result.

**Who can do this.** Only the account the machine is enrolled to. The portal names the account
from your session; the coordinator checks the machine's verified ownership and signs the command
with its identity key; the agent acts only on a command signed by the coordinator it pinned, for its
own id, within two minutes, once. See [the threat model](security/agent-threat-model.md#remote-model-control).

**Where changes are kept.** The agent runs as the unprivileged `edgecoder` user and cannot rewrite
`/etc/edgecoder/agent-N.env`. Remote changes go to
`/var/lib/edgecoder/agent-N/.config/edgecoder/model-overrides.json` (the agent's own state
directory, mode 0600) and are layered over the env file at startup. Each entry records the env value
it replaced; if that value later changes (you edit the env file, or re-run the installer with
`--model`, `--context-window`, `--parallel` or `--keep-alive`), **the local value wins** and the
remote one is dropped. Delete the file and restart the agent to return to the env file alone.
`--context-window auto` (or `--parallel auto`) also removes that setting's portal override from
every instance's `model-overrides.json` before the agents restart, so the value is sized
automatically again; other portal choices in the file (such as the model) stay. The portal's
**Automatic** does the same for one machine without a restart: the agent removes that entry from
its own `model-overrides.json` and re-sizes at once. It leaves the env file alone, so a value set
there stays in force (local wins).
An `update` (`apply --keep-config`) keeps the env file's model, so a model chosen in the portal stays
in force through updates. A model loaded by hand (`ollama run`) is not the agent's model: press
**Use** on it in the portal, or run `sudo edgecoder-install apply --keep-config --model <tag>`.

**Host controls** (in `agent-N.env`):

| Variable | Effect |
| --- | --- |
| `AGENT_REMOTE_CONTROL=off` | View only: the state is still shown, no remote command changes anything (an operator's model rollout included). |
| `AGENT_MODEL_ALLOWLIST=qwen3-coder:30b,qwen3.5:9b` | Only these models may be pulled or selected remotely. Unset: the curated catalog. `catalog,<tag>` adds to the catalog; `none` allows nothing. |

Desktop machines (macOS, Windows) take the same commands, and their app stays authoritative. The
remote "active model" is the model the machine serves to the network; the app's Model Manager
still picks the model for local chat. A model loaded in Ollama (in use on the machine) cannot be
removed remotely, a setting the app's own configuration changes replaces the remote value, and the
portal always shows what the machine reports.

## Example: an 8× RTX 6000 Ada host

```bash
read -rs EDGECODER_API_KEY   # eck_... from Settings → API keys
curl -fsSLo install.sh https://edgecoder.io/install.sh   # check it as in "One line" above
sudo EDGECODER_API_KEY="$EDGECODER_API_KEY" bash install.sh --mesh-token "$MESH" --pull-models
sudo edgecoder-install status
```

By default the eight cards run the **mixed** layout: `box-gpu0` … `box-gpu3` each run
`qwen3-coder:30b` (fast, four parallel calls per card) and `box-gpu4-5` / `box-gpu6-7` each pool two
cards for `qwen3-coder-next` (80B MoE, 3B active). The network gets both quick agent work and a much stronger model. Each
instance's model is the strongest that fits its VRAM:

| VRAM per instance | Model |
|---|---|
| 320 GB+ (7–8 cards) | `qwen3-coder:480b` (290 GB) |
| 160 GB+ (4 cards) | `qwen3:235b` (142 GB) |
| 80 GB+ (2 cards) | `qwen3-coder-next:latest` (52 GB) |
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
