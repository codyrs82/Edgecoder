# Inference engines: Ollama, vLLM and MLX

An EdgeCoder agent runs its model on one of three local engines, chosen with `EDGECODER_ENGINE`
in the agent's env file:

| Engine | `EDGECODER_ENGINE` | Where | Model calls at once | Who runs the engine |
| --- | --- | --- | --- | --- |
| Ollama | `ollama` (default) | everywhere (laptops, Macs, GPU hosts) | `AGENT_PARALLEL_INFERENCE`, 1-4 typically | the installer / desktop app, and the agent pulls and switches models |
| vLLM | `vllm` | Linux, NVIDIA datacenter GPUs (compute capability 7.0+, best on 8.0+) | many: continuous batching and paged attention | a systemd unit (`scripts/linux/vllm`); the agent only health-checks it |
| MLX | `mlx` | Apple silicon (`mlx_lm.server`) | 1 by default; more with mlx-lm 0.28.4+ | you (or, later, the desktop app); the agent only health-checks it |

Nothing changes for an agent that does not set `EDGECODER_ENGINE`.

## When to use which

- **Ollama** for anything that is not a dedicated GPU server: it is managed for you (install, pull,
  model switches from the portal), and serves one or a few calls at once well.
- **vLLM** on a GPU server whose model slots are busy. Ollama serves the Chicago 2× A16 host's
  `qwen3-coder:30b` one call at a time at 64K context; vLLM serves several at once on the same
  cards (batched decoding reads the weights once per step for every call in the batch), with exact
  token accounting, prefix caching for agent loops that resend the same system prompt and tools,
  and a hard context limit. The cost: you start and size it yourself, it loads one model at start
  (no remote model switches), and the first start takes minutes.
- **MLX** on a Mac only after measuring it against Ollama there: Ollama 0.30+ (the desktop bundles
  0.40.x) already runs supported models through MLX on Macs with 32 GB or more, and falls back to
  llama.cpp below that. See [MLX on a Mac](#mlx-on-a-mac).

## What the agent does with vLLM or MLX

- **Health.** At start and every minute it reads `GET /v1/models` (and vLLM's `/metrics`). While
  the engine is down, still loading, or serving a model that is not in the catalog, the agent logs
  why (`vLLM not serving (...): ...`), reports no installed model and no free model slot, and the
  coordinator hands it no model call. It never starts, stops, pulls or switches the engine's model.
- **Model name.** The served Hugging Face id is mapped to the network's catalog tag
  (`src/model/engine-models.ts`): `QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ`,
  `Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8` and `mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit` are
  all `qwen3-coder:30b`, so buyers, pricing (`paramSizeBillions`) and best-fit routing see the same
  model whatever the engine. Quantization and packaging suffixes (AWQ, GPTQ, FP8, 4bit, MLX, DWQ…)
  are ignored. A name the table does not know: `ENGINE_MODEL_ALIASES="my-org/my-ft=qwen3-coder:30b"`,
  or start vLLM with `--served-model-name qwen3-coder:30b`.
- **Context window.** vLLM's `max_model_len` (from `/v1/models`), lowered by
  `AGENT_CONTEXT_WINDOW` if that is smaller. MLX does not report one: `AGENT_CONTEXT_WINDOW`, else
  the memory estimate Ollama agents use. A call vLLM refuses as too long is reported as
  `context_too_long` before anything streams, and the coordinator gives it to an agent with a
  bigger window.
- **Slots.** `VLLM_MAX_SLOTS` / `MLX_MAX_SLOTS` (1-16), else `AGENT_PARALLEL_INFERENCE`, else:
  MLX 1; vLLM from its KV cache, as many calls as fit if each used half the window
  (`kv_tokens / (window / 2)`), 1 if `/metrics` is off. The agent reports them with every pull
  (`inferenceSlots`, `freeInferenceSlots`); the coordinator hands one agent as many calls as it has
  free slots.
- **Calls.** `POST /v1/chat/completions`, streamed, with tool calls (assembled from the stream),
  `stream_options.include_usage` for exact token counts, temperature and `max_tokens` as asked,
  and `chat_template_kwargs.enable_thinking=false` (Ollama's `think:false`). Code tasks on a
  sandboxed agent use the same engine.
- **Benchmark and hardware verification.** The GPU challenge (`gpu.dc40`, `gpu.dc80`, `apple.*`)
  runs through the engine: the same nonce-tagged prompt, temperature 0, the challenge's seed,
  streamed, with the decode time measured from the first to the last generated piece. The
  coordinator's checks are unchanged: its own clock bounds the time, the tags must be present, a
  speed above the part's peak bandwidth is invalid. The register body now says which engine and
  weights run the model (`inferenceEngine`, `engineModel`), and GPU cross-check witnesses are
  picked among agents with the **same engine and the same served weights**: an AWQ build and a
  Q4_K_M GGUF of one model write different greedy text, so comparing them would read an honest
  agent as a mismatch. A tier above the class base (`gpu.dc80`, `apple.m.hi`, …) needs such a
  witness; until another owner runs the same weights on the same engine, such an agent is paid at
  its class base tier (`gpu.dc40`, `apple.m`). The 2× A16 claims `gpu.dc40`, the base, so this
  does not affect it.

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `EDGECODER_ENGINE` | `ollama` | `ollama`, `vllm` or `mlx`. A typo stops the agent. |
| `VLLM_URL` | `http://127.0.0.1:8000` | vLLM's OpenAI server. |
| `VLLM_MODEL` | first served catalog model | The served id the agent must find in `/v1/models`. |
| `VLLM_MAX_SLOTS` | from the KV cache | Model calls at once (1-16). |
| `VLLM_API_KEY` | none | If vLLM was started with `--api-key`. |
| `MLX_URL` | `http://127.0.0.1:8080` | `mlx_lm.server`. |
| `MLX_MODEL` | first cached catalog model | The id `mlx_lm.server --model` was started with. Set it: MLX lists every MLX model in the Hugging Face cache. |
| `MLX_MAX_SLOTS` | 1 | Model calls at once (1-16). More than 1 only with mlx-lm 0.28.4 or newer. |
| `ENGINE_MODEL_ALIASES` | none | `served-id=catalog-tag,…` for names the built-in table does not know. |
| `AGENT_CONTEXT_WINDOW` | engine's | Lowers the reported window (never above vLLM's `max_model_len`). |

Keep `LOCAL_MODEL_PROVIDER=ollama-local` (implied when an engine is set). `OLLAMA_MODEL`,
`OLLAMA_HOST`, `AGENT_MODEL_KEEP_ALIVE` and remote model control do nothing with vLLM or MLX; the
portal shows the host as view only with a note naming the engine.

## vLLM on Ubuntu with NVIDIA GPUs

Requirements: Ubuntu 22.04 or 24.04, NVIDIA driver 550 or newer (the installer checks it and never
installs one), Python 3.10-3.14, ~15 GB of disk for vLLM and its CUDA libraries plus the weights.

```bash
# on the GPU host, from a checkout of this repository
sudo scripts/linux/vllm/install-vllm.sh --profile a16x2 --download --start   # or --profile a100-80
journalctl -fu edgecoder-vllm@0            # first start: load + compile, a few minutes
curl -s http://127.0.0.1:8000/v1/models    # -> the model and its max_model_len
```

Then point the agent at it, with the installer so that every later run keeps it:

```bash
sudo edgecoder-install apply --engine vllm --vllm-model QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ --vllm-slots 2
```

It writes into `/etc/edgecoder/agent-0.env`:

```bash
EDGECODER_ENGINE=vllm
VLLM_URL=http://127.0.0.1:8000
VLLM_MODEL=QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ
VLLM_MAX_SLOTS=2
```

and restarts the agent, which logs
`vLLM at http://127.0.0.1:8000 serves … as qwen3-coder:30b: context 65536 (max_model_len 65536), 2 slot(s), KV cache … tokens`.
(`edgecoder-install apply --engine vllm --vllm-profile a16x2` does the install-vllm.sh step too
when vLLM is missing.)

The instance's Ollama is held off by `/etc/edgecoder/vllm-0.active` and the drop-in
`/etc/systemd/system/edgecoder-ollama-0.service.d/vllm-switch.conf`
(`ConditionPathExists=!/etc/edgecoder/vllm-0.active`): Ollama holds the GPUs' memory while its
model is loaded, and the agent unit `Wants=` its Ollama, so it would otherwise start again with
every agent restart. Not a mask: the installer rewrites the Ollama unit file on every run, which
would lift a mask. `install-vllm.sh --start` writes the same marker and drop-in.

**Re-runs and upgrades keep vLLM.** Every `edgecoder-install apply` without `--engine` (a package
upgrade, `install.sh --from-source`, a re-run with new tokens) reads the engine back from
`agent-<n>.env` (and the marker, if an older run dropped the lines) and writes the same lines, marker
and drop-in again. It starts `edgecoder-vllm@<n>` if it is down but never restarts a running one, so
only the agent restarts.

The installer puts vLLM in `/opt/edgecoder/vllm/venv` (a pinned `vllm==` from PyPI), the weights
in `/var/lib/edgecoder/hf`, the serve flags in `/etc/edgecoder/vllm-<n>.env`
([example](../scripts/linux/vllm/vllm.env.example)), and runs `edgecoder-vllm@<n>.service` as the
`edgecoder` user on 127.0.0.1 with the same systemd hardening as the Ollama unit. Change flags in
the env file and `systemctl restart edgecoder-vllm@0`.

**Back to Ollama:** `sudo edgecoder-install apply --engine ollama`. It removes the engine lines, the
marker and the drop-in, stops and disables `edgecoder-vllm@0` before Ollama starts, and restarts the
agent. `vllm-0.env`, the venv and the weights stay, so `--engine vllm` later needs no reinstall.

**Memory safety with vLLM.** vLLM preallocates `--gpu-memory-utilization` of the cards' VRAM
(weights plus KV cache) when it starts, so the agent's host memory manager does not fit or unload
models there: it reports the served model as loaded, holding the whole memory budget, with the
slots derived from vLLM's reported KV cache (above). The coordinator then sends calls for that
model up to its slots and never another model on free-looking headroom. The instance's Ollama unit
keeps its memory-safety settings (`OLLAMA_MAX_LOADED_MODELS` etc.) for when it runs again; the
pressure guard applies on either engine.

### Sizing: 2× NVIDIA A16 (16 GB each, compute capability 8.6)

Qwen3-Coder-30B-A3B has 48 layers and 4 KV heads of 128: its KV cache is 96 KiB per token at
fp16 (48 KiB per card with tensor parallel 2). Each A16 shows 15.0 GiB.

| | |
| --- | --- |
| Weights | AWQ 4-bit `QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ`, 16.8 GB, ~7.9 GiB per card with `--tensor-parallel-size 2`. FP8 (31 GB) and BF16 (61 GB) do not fit. GPTQ-Int4 builds also fit; AWQ runs on the Marlin MoE kernels on 8.x. |
| Budget per card | 15.0 GiB × 0.92 = 13.8 GiB; − 7.9 weights − ~1.5 activations / CUDA graphs ≈ **4.2 GiB KV per card ≈ 90K tokens** at fp16 |
| 64K context (`--max-model-len 65536`) | 1 call at the full 64K, 2-3 typical agent calls (10-30K tokens): **`VLLM_MAX_SLOTS=2`** (what the agent derives); 4 with fp8 KV |
| 32K context (`--max-model-len 32768`) | **`VLLM_MAX_SLOTS=5`** at fp16 KV; ~10 with fp8 KV |

```bash
vllm serve QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ \
  --tensor-parallel-size 2 --max-model-len 65536 --gpu-memory-utilization 0.92 \
  --max-num-seqs 8 --max-num-batched-tokens 4096 --enable-prefix-caching \
  --enable-auto-tool-choice --tool-call-parser qwen3_xml \
  --host 127.0.0.1 --port 8000
```

A16 caveats:

- **Compute capability 8.6 (Ampere).** AWQ / GPTQ (Marlin), FlashAttention 2 and CUDA graphs work.
  No FP8 tensor cores (8.9+): FP8 weights would run weight-only; FP8 KV cache
  (`--kv-cache-dtype fp8`) doubles the cache but on Ampere uses a slower attention path; try it
  and keep it only if decode speed holds.
- **PCIe, no NVLink.** The two cards are under one PCIe host bridge (`nvidia-smi topo -m`: PHB).
  Tensor-parallel all-reduce goes over PCIe; if vLLM hangs at start on peer-to-peer, add
  `--disable-custom-all-reduce` (or `NCCL_P2P_DISABLE=1` in the env file).
- **Slow cards.** ~200 GB/s and modest FLOPs per card: long prompts take seconds to prefill (prefix
  caching helps agent loops), and decode stays around Ollama's ~45-50 tok/s per call. The gain is
  concurrency: an estimate of 2-3× the aggregate tokens/s at 2-4 calls, not a faster single call.
  Measure with the agent's self-benchmark and `vllm:` metrics before raising slots.
- **Driver 580 / CUDA 13 driver API** runs vLLM's CUDA 12 wheels.
- Use `qwen3_xml` as the tool parser (vLLM's Qwen3-Coder parser; older vLLM releases call it
  `qwen3_coder`).

### Sizing: 1× NVIDIA A100 80 GB (compute capability 8.0)

| | |
| --- | --- |
| Weights | FP8 `Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8`, 31.2 GB (weight-only FP8 on Ampere, better quality than 4-bit); or AWQ (16.8 GB) for ~30% more cache |
| KV budget | 79 GiB × 0.92 − 29 − ~3 ≈ 41 GiB ≈ **430K tokens** at fp16 (FP8 weights) |
| 64K context | ~6 calls at the full 64K, **`VLLM_MAX_SLOTS=12`** typical (the agent derives 13) |
| 32K context | **16** (the agent's cap) |
| 128K context | `--max-model-len 131072` (the agent's maximum): ~3 at full length, 6 typical |

```bash
vllm serve Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8 \
  --max-model-len 65536 --gpu-memory-utilization 0.92 --max-num-seqs 32 \
  --enable-prefix-caching --enable-auto-tool-choice --tool-call-parser qwen3_xml \
  --host 127.0.0.1 --port 8000
```

A100 caveats: no FP8 tensor cores (8.0), so FP8 is weight-only (Marlin) and saves memory, not
compute; if the FP8 MoE build will not load on your vLLM version, use the AWQ build. `gpu.dc80`
needs 900 GB/s effective in the challenge, which for this MoE (1.98 GB read per token by the
network's estimate) means ~455 tok/s on one call: a single-stream MoE is overhead-bound well below
that, so a 30B-A3B A100 will most likely settle at `gpu.dc40`. A dense model (e.g. AWQ
`Qwen2.5-Coder-32B-Instruct`, `qwen2.5-coder:32b`) is the way to prove `gpu.dc80`, and needs a
second vLLM agent on the same weights as witness.

## MLX on a Mac

```bash
python3 -m venv ~/.edgecoder/mlx && ~/.edgecoder/mlx/bin/pip install 'mlx-lm>=0.29'
~/.edgecoder/mlx/bin/mlx_lm.server --model mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit \
  --host 127.0.0.1 --port 8080 --max-tokens 4096
```

and in the agent's env: `EDGECODER_ENGINE=mlx`,
`MLX_MODEL=mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit`, `AGENT_CONTEXT_WINDOW=32768`,
`MLX_MAX_SLOTS=1` (or 2, below). Notes:

- **Batching.** mlx-lm batches in the server since 0.28.4 (December 2025; `--decode-concurrency`,
  default 32, and `--prompt-concurrency`), but only calls without a `seed` and without
  `--kv-bits`. Network calls carry no seed (only the benchmark does), so with mlx-lm 0.29+ two
  slots are reasonable on a 32 GB Mac; the limit is memory for the KV cache, not the server.
  Older mlx-lm serves one call at a time: keep `MLX_MAX_SLOTS=1`.
- **Context.** `mlx_lm.server` does not report or enforce one; set `AGENT_CONTEXT_WINDOW` to what
  fits in memory next to the weights (Qwen3-Coder-30B: 96 KiB per token, 3 GiB at 32K).
- **Memory.** macOS lets the GPU wire about two thirds to three quarters of unified memory by
  default; `sudo sysctl iogpu.wired_limit_mb=…` raises it until the next reboot.
- `--max-tokens` is the server's default reply cap (512 if not set); the agent sends each call's
  own `max_tokens` when the caller gave one.

Which quant (all `mlx-community`):

| Mac | Model | Build | Weights |
| --- | --- | --- | --- |
| Mac Studio M1 Max 32 GB | `qwen3-coder:30b` | `Qwen3-Coder-30B-A3B-Instruct-4bit` (or `-4bit-DWQ`) | 17.2 GB, 32K context, 1-2 slots |
| 32-36 GB MacBook Pro | `qwen3-coder:30b` | same | as above |
| 16-24 GB MacBook | `qwen2.5-coder:7b` | `Qwen2.5-Coder-7B-Instruct-4bit` (8bit on 24 GB) | 4.3 / 8.1 GB |
| 16 GB MacBook | `qwen3.5:9b` | `Qwen3.5-9B-4bit` | 6.0 GB |

The 6-bit (24.8 GB) and 8-bit (32.4 GB) Qwen3-Coder-30B builds do not fit a 32 GB Mac.

## Memory safety on GPU hosts

With Ollama the agent keeps every network model inside a memory budget: 90% of the instance's GPU
VRAM on a discrete card (60% of RAM on Apple silicon and CPU hosts; `AGENT_MEMORY_BUDGET_PCT`). It
sizes its context window and slots to fit, advertises only models that fit, serves at most
`AGENT_MAX_NETWORK_MODELS` / `OLLAMA_MAX_LOADED_MODELS` distinct models at once (the installer
writes 1 up to 32 GB of instance memory and 2 above, with flash attention and a `q8_0` KV cache),
and stops taking network work under host memory pressure. vLLM and MLX size their own cache at
start (`--gpu-memory-utilization`, the MLX server's model); with them only the pressure guard
applies. Details and thresholds: [Memory safety](install.md#memory-safety).

## Troubleshooting

| Log line | Meaning |
| --- | --- |
| `vLLM not serving (startup): vLLM is not reachable at …` | The unit is stopped, still starting, or on another port. `systemctl status edgecoder-vllm@0`. |
| `… serves no model yet (still loading?)` | Wait for the load; the agent re-checks every minute. |
| `… not the configured VLLM_MODEL=…` | The env file's `VLLM_MODEL` differs from `VLLM_MODEL_ID` in `vllm-0.env`. |
| `… none of them a catalog model; set ENGINE_MODEL_ALIASES` | A fine-tune or an unknown repo name: map it, or `--served-model-name <catalog tag>`. |
| Calls fail with `context_too_long: vLLM: This model's maximum context length is …` | Expected for a call longer than `max_model_len`; the coordinator retries it on a bigger window. Many of them: the network sends this agent calls near its window; lower `AGENT_CONTEXT_WINDOW` slightly. |
