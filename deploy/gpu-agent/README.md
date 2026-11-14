# GPU agent hosts (Vultr VM, Vast.ai container)

Runbook for running EdgeCoder compute agents on two rented GPU hosts, to prove the network end to
end before any real money moves.

> **Regtest only.** Point these agents at a coordinator running on regtest (or signet/testnet)
> until every item in [docs/going-to-mainnet.md](../../docs/going-to-mainnet.md) is done. Nothing
> here is reviewed for mainnet: the agents would earn and the coordinator would pay real sats.

| Host | What runs | Takes work today? |
| --- | --- | --- |
| Vultr GPU VM (full Linux VM) | Full agent: Ollama on the GPU **and** the Docker sandbox for code tasks (`SANDBOX_MODE=docker`) | Yes |
| Vast.ai GPU container (no Docker inside) | Inference-only agent: Ollama on the GPU, never runs task code (`SANDBOX_MODE=none`, `AGENT_INFERENCE_ONLY=1`) | **No, not yet** (see below) |

> **The Vast agent will not receive work until inference-only mode lands.** Today an agent with
> `SANDBOX_MODE=none` registers and heartbeats but pulls nothing: the worker does not call `/pull`
> (`src/swarm/worker-runner.ts`) and the coordinator refuses sandbox-less agents
> (`pullSandboxRejection` in `src/swarm/sandbox-enforcement.ts`). `AGENT_INFERENCE_ONLY=1` is
> reserved for the change that will let such agents pull `kind: "inference"` subtasks only; until
> it ships, running the Vast container proves registration, GPU detection and model pull, and costs
> money for no work. Rent it last, or only for a short registration check.

Files:

- `vm-bootstrap.sh`: one-shot, re-runnable setup for an Ubuntu 24.04 GPU VM.
- `Dockerfile.inference`, `inference-entrypoint.sh`: the inference-only agent image for container hosts.

## What to rent

The default model is `qwen3.5:9b` (`src/model/catalog.ts`): its weights are 6.6 GB on disk and
in VRAM, and the catalog sets `minMemoryGb: 12` for it, the headroom for the KV cache (it has a
long context) and the CUDA runtime on top of the weights. So:

- **GPU memory: 12 GB or more on one card.** 16 GB (e.g. a full NVIDIA A16 16 GB, A4000, T4 is
  16 GB too) is comfortable. Below 12 GB Ollama offloads layers to the CPU and inference becomes
  slow; pick a smaller model (`OLLAMA_MODEL`) instead. On a 24 GB+ card `edgecoder-install`
  would pick `qwen3-coder:30b` by itself; the bootstrap pins `OLLAMA_MODEL` (default
  `qwen3.5:9b`) so both hosts serve the same model.
- **NVIDIA driver 550 or newer** (Ollama's requirement; GPUs of compute capability 5.0+).
- Disk: 40 GB or more (the Ollama runtime with its CUDA libraries is about 2.5 GB, the model
  6.6 GB, Docker sandbox images and the app a few GB more).
- RAM: 16 GB or more.

**Vultr.** A Cloud GPU instance with a whole GPU of at least 12 GB, Ubuntu 24.04 x64. Vultr also
sells fractions of a card (vGPU slices); make sure the slice you pick shows at least 12 GB in
`nvidia-smi`. Use an image that ships the NVIDIA driver: the bootstrap checks for it and stops
if it is missing, it does not install drivers.

**Vast.ai.** An offer with one GPU of at least 12 GB VRAM and a max CUDA version of 12.4 or newer
(that is, driver 550+), 40 GB disk. Use the launch mode that runs the image's own entrypoint
(not the SSH/Jupyter modes, which replace it).

## Portal API key and node enrolment

Both hosts join with a portal account whose email is verified (agents of unverified accounts are
not approved).

1. Sign in to the portal (`$PORTAL_URL`), **Settings → API keys**, create a key. It starts with
   `eck_` and is shown once. It acts as your account: keep it off shared machines.
2. The **Vultr VM** uses this key directly: `edgecoder-install --enroll` self-enrols the node
   (`POST /nodes/enroll`) and writes the node's registration token into the service env file.
   The key itself is not written to the VM.
3. The **Vast container** does not get the API key (it is a host you do not control). Mint a
   node-scoped registration token for it from your own machine instead, then pass only that:

   ```bash
   read -rs EDGECODER_ENROLL_KEY            # paste the eck_ key; not echoed, not in history
   curl -fsS -X POST "$PORTAL_URL/nodes/enroll" \
     -H "authorization: Bearer $EDGECODER_ENROLL_KEY" -H 'content-type: application/json' \
     -d '{"nodeId":"vast-gpu-1","nodeKind":"agent"}'
   # -> {"registrationToken":"...", ...}: keep it for AGENT_REGISTRATION_TOKEN
   ```

   Or use the portal dashboard's **Enroll node** form with the same node id. Enrolling the same
   node id again issues a new token and the old one stops working.

## 1. Vultr GPU VM (full agent)

Create the VM (Ubuntu 24.04, GPU plan as above, your SSH key), then from a checkout of this repo
on your machine:

```bash
VM=root@<vm-ip>
ssh "$VM" nvidia-smi                               # the driver must already be there
ssh "$VM" mkdir -p /root/edgecoder/gpu-agent
scp deploy/install.sh "$VM":/root/edgecoder/
scp deploy/gpu-agent/vm-bootstrap.sh "$VM":/root/edgecoder/gpu-agent/
ssh "$VM"
```

On the VM:

```bash
read -rs EDGECODER_ENROLL_KEY                      # paste the eck_ key
COORDINATOR_URL=https://<your-regtest-coordinator> \
PORTAL_URL=https://<your-portal> \
EDGECODER_ENROLL_KEY="$EDGECODER_ENROLL_KEY" \
AGENT_ID_PREFIX=vultr-a16 \
  bash /root/edgecoder/gpu-agent/vm-bootstrap.sh
unset EDGECODER_ENROLL_KEY
```

(If you are not root, put the variables after `sudo`: `sudo COORDINATOR_URL=... bash ...`.)

Optional inputs: `OLLAMA_MODEL` (default `qwen3.5:9b`), `MESH_AUTH_TOKEN` (the coordinator hands
it out at registration, so normally unset), `EDGECODER_VERSION` (agent release, default the
newest `agent-v*`), `EDGECODER_FROM_SOURCE_REF=<branch>` to build an **unverified** branch instead
of a signed release (built as the unprivileged `edgecoder-build` user). A regtest network running
code newer than the last agent release needs the latter.

What it does, in order (details in the script header):

1. Checks `nvidia-smi` works and the driver is 550+; stops with instructions otherwise.
2. Installs Docker Engine from `download.docker.com`, after checking the repo key's fingerprint
   is `9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88` (the only key in the keyring).
3. Runs `deploy/install.sh`: Node.js 22 from nodejs.org and Ollama from its GitHub release, both
   checked against pinned SHA-256s; the EdgeCoder agent release checked against the pinned
   minisign key; the NVIDIA container toolkit from NVIDIA's repo (pinned key; `install.sh` adds it
   on every NVIDIA host, the agent itself does not need it since Ollama runs on the host); then
   `edgecoder-install apply --sandbox docker --model ... --pull-models`, which enrols the node,
   writes `/etc/edgecoder/agent-<n>.env` and the systemd units `edgecoder-ollama-<n>` (pinned to
   its GPU) and `edgecoder-agent-<n>`, both running as the non-root `edgecoder` user, which is
   added to the `docker` group (that group is root-equivalent on the host: the cost of the
   container sandbox, see docs/install.md).
4. Sets `LOCAL_MODEL_PROVIDER=ollama-local` in the agent env files (the installer writes the
   offline `edgecoder-local` provider) and restarts the agents.

The node id is `<AGENT_ID_PREFIX>-gpu` (one GPU; `<prefix>-gpu<N>` per card on multi-GPU plans,
one agent each). Re-running the script is safe: it keeps Docker, reuses the registration token
already in `/etc/edgecoder/agent-0.env` (so it does not rotate it), and re-applies the services.

On the VM afterwards:

```bash
edgecoder-install status
journalctl -fu edgecoder-agent-0      # registration, then "preparing sandbox images" on first start
nvidia-smi                            # ollama should hold ~7 GB once a request has loaded the model
```

## 2. Vast.ai container (inference-only agent)

Build the image from the repo root and push it to a registry Vast can pull from (a private
registry needs Vast's registry login):

```bash
docker build --platform linux/amd64 -f deploy/gpu-agent/Dockerfile.inference \
  -t <registry>/edgecoder-agent-inference:<git-sha> .
docker push <registry>/edgecoder-agent-inference:<git-sha>
```

The image: pinned `node:22-bookworm-slim` digest, Ollama 0.40.12 checked against its SHA-256
(the same pin as `deploy/docker/Dockerfile.agent`), runs as the non-root `node` user, sets
`SANDBOX_MODE=none`, `AGENT_INFERENCE_ONLY=1`, `LOCAL_MODEL_PROVIDER=ollama-local`, and stores
models and the agent's identity under `/data` (a volume). Ollama's linux-amd64 archive carries
its own CUDA 12 and 13 runtime libraries; the driver (`libcuda`) and `nvidia-smi` come from the
host through the NVIDIA container runtime, as with Ollama's official image.

Create the instance with that image, a GPU, and these environment variables (Vast's "env" field,
or `-e` on a plain `docker run --gpus all`):

| Variable | Value |
| --- | --- |
| `COORDINATOR_URL` | `https://<your-regtest-coordinator>` |
| `PORTAL_URL` | `https://<your-portal>` |
| `AGENT_ID` | the node id you enrolled (e.g. `vast-gpu-1`) |
| `AGENT_REGISTRATION_TOKEN` | the token from the enrolment above |
| `OLLAMA_MODEL` | optional, default `qwen3.5:9b` |

On first start the entrypoint starts Ollama on `127.0.0.1:11434`, pulls the model into
`/data/ollama` (several minutes), logs the GPU `nvidia-smi` sees and whether Ollama found CUDA,
then starts the agent (`node dist/cli/edgecoder.js agent`). It refuses to start without the
variables above, or with any `SANDBOX_MODE` other than `none`. Expect, in the log:

```
[agent:vast-gpu-1] SANDBOX_MODE=none: not pulling swarm tasks ...
```

That line is correct today (see the note at the top).

The same image on any Docker host with an NVIDIA GPU, for a local check:

```bash
docker run -d --name edgecoder-inference --gpus all -v edgecoder-inference:/data \
  -e COORDINATOR_URL -e PORTAL_URL -e AGENT_ID -e AGENT_REGISTRATION_TOKEN \
  <registry>/edgecoder-agent-inference:<git-sha>
docker logs -f edgecoder-inference
```

## Check the agent registered

- **Portal:** the dashboard's node list shows the enrolled node id and its status.
- **Coordinator** (operator, with the mesh token):

  ```bash
  curl -fsS -H "x-mesh-token: $MESH_AUTH_TOKEN" "$COORDINATOR_URL/capacity" \
    | jq '.agents[] | {agentId, sandboxMode, localModelProvider, swarmEnabled, lastSeenMs}'
  ```

  The Vultr agent should show `sandboxMode: "docker"` and `localModelProvider: "ollama-local"`;
  the Vast agent `sandboxMode: "none"`. `lastSeenMs` should stay within the last minute.
- **Agent log:** `journalctl -u edgecoder-agent-0` (VM) or the container log (Vast): look for
  `coordinator selected` and no repeated registration errors.

## Stop and destroy (stop billing)

Both providers keep billing for a stopped machine (Vultr bills an instance until it is destroyed;
Vast bills storage of a stopped instance), so **destroy** when done:

- Vultr: control panel → the instance → **Destroy** (or `vultr-cli instance delete <id>`).
  To stop only the agent first: `sudo edgecoder-install remove` on the VM.
- Vast.ai: console → Instances → **Destroy** (trash icon), or `vastai destroy instance <id>`.
- Portal: delete the node ids you no longer use (dashboard node list), which also invalidates
  their registration tokens. Revoke the API key if you created it only for this test.
