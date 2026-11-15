# Load Testing the Network

`scripts/loadgen/` drives realistic traffic at the live **regtest** network through the public
OpenAI-compatible API (`https://edgecoder.io/v1/chat/completions`), from a temporary Fly app with
one machine per region, so the owner can push the network and watch it on **edgecoder.io →
Settings → Network**. It has no dependencies (Node 22) and ships to Fly as a base64 tarball in the
machine environment on a stock `node:22-slim` image (no image build).

It is not the stress harness: `scripts/stress/` simulates agents locally against a docker cluster;
this one uses the real agents on the real network and only plays the buyers.

## What it does

Each test account (`st1`–`st10`, `~/.config/edgecoder/e2e/accounts/*.json`) is a virtual user, so
the agents' owners are also the network's customers and their machines serve each other. Users get
a persona (coder, chatter, integrator) that weights three behaviours:

| behaviour | what | models (weighted) |
|---|---|---|
| chat | short questions with one checkable answer (accuracy is measured) | `network/qwen2.5-coder:1.5b`, `:7b@apple`, `qwen3-coder:30b`, `auto` |
| coding | an agent-style session: system prompt with tools (`read_file`, `search`, `edit_file`, `answer`), a stable session id (`user` field and `x-session-id`), and turn after turn of pasted source with a checkable "what does this function return" question; the conversation grows from ~2K to ~20K tokens (8K on smaller models), with 5–20 s of think time between turns | `qwen3-coder:30b` (the GPU), `:7b@apple`, `auto` |
| burst | 2–5 concurrent one-offs | mostly `1.5b`, some `auto` |

### Capacity-aware model choice

The network's slots are uneven (about 20 CPU slots hold `qwen2.5-coder:1.5b`, one GPU slot holds
`qwen3-coder:30b`, a Mac or two hold the 7b). A first ramp with a fixed mix put most of its
pressure on the one GPU slot and one Mac, collected `no_capacity` there, and stopped itself at
~1 call/s per region while the CPU fleet sat idle. So (`planner.mjs`):

- `fly.sh run` takes a snapshot of slots per model and the classes that hold each model
  (`capacity.mjs`, from the coordinators' `/admin/network` with the admin token on the operator's
  host) and passes it to the machines as `LOADGEN_CAPACITY`. The admin token does not leave the
  host; with `LOADGEN_ADMIN_TOKEN` set on the app the machines refresh it before every stage
  (optional, off by default). Without a snapshot: 1.5b 16 slots, 30b 1, 7b 1.
- Each model has a network-wide in-flight cap: its slot count for scarce models (fewer than 5
  slots), slots × `--oversub` (default 1.5) for the bulk ones so they can queue, and
  `--auto-slots` (default 3) for `auto`. The cap is split over the machines in whole slots.
- A model is chosen with weight = mix weight × this machine's free allowance, so the bulk of the
  load lands on the 1.5b CPU fleet. An arrival with no model free is shed (`droppedBy.capacity`).
- A class nobody holds the model in (e.g. `7b@apple` while the Mac registers as `cpu`) is sent
  without the class (`class_unavailable` event); a model nobody holds is not picked.
- **Per-model backoff**: `no_capacity` (or a timeout) while this machine already uses its whole
  share of the model is recorded as `over_capacity` (`timeout_over_capacity`), does not count
  toward the global stop, and takes one slot off that model for 30 s.

Arrivals are open-loop (Poisson) at the stage's rate; a burst of k calls uses k arrivals, and a
coding turn whose think time is over takes the next arrival. **Code tasks** (sandboxed jobs) are not
generated: `/submit` needs a signed agent identity enrolled under the buyer's account (the stress
harness does this), which would add phantom agents to the network, and every live agent today is
inference-only (`SANDBOX_MODE=none`), so jobs would never run.

## Limits

- **16 calls/s across the whole network**, hard-coded (`HARD_MAX_RATE`). Each machine starts at
  most `floor(cap / machines)` calls in any sliding second; `--max-rate` can only lower the cap.
  With 4 regions that is 4/s each; a split that cannot fit (e.g. 5 machines under a 3/s cap)
  refuses to start.
- The smoke profile is capped at 3 calls/s and 2 minutes.
- At most 48 calls in flight per machine; arrivals beyond that are counted as `dropped`.
- **Global backoff**: when real failures (5xx, stream errors, network errors, 429, auth and billing
  errors, timeouts and `no_capacity` on a model with free slots) pass the profile's threshold over
  30 s, the machine drops to the previous stage's rate for the rest of the stage and then stops; a
  second breach stops it at once. `over_capacity` and gaps (`no_agent_has_model`,
  `no_agent_in_class`) do not count.
- **Budget**: a user is skipped below `--min-balance` (default 1500 cSats: every network call sets
  aside up to ~750 cSats up front, refunded after); a `402` pauses that user for a minute; each
  machine stops after its share of `--budget` cSats (default 2000 for the run).
- This tool generates no agents (the owner's limit is ≤ 60 agents on the network).
- Regtest only: top-ups refuse any invoice that is not `lnbcrt…`.

## Profiles

| profile | schedule (network-wide calls/s) | backoff threshold |
|---|---|---|
| `smoke` | 1.5 for 2 min | 50 % |
| `steady` | 4 (or `--rate`) for `--duration` (default 30 min) | 15 % |
| `ramp` | 0.5 → 2 → 4 → 8 → 12 → 16, `--stage-minutes` each (default 5) | 10 % |
| `saturate` | 2 → 4 → 8 → 12 (2 min each), then 16 for 20 min | 40 % |
| `soak` | 2 → 4 → 6 → 4 (15 min each), looped for `--duration` (default 2 h) | 10 % |

`--loop` repeats any schedule until `--duration`; `--duration` also cuts a schedule short.
`node scripts/loadgen/loadgen.mjs --profile ramp --dry-run` prints the schedule without sending anything.

## Running it

Prerequisites: `fly` logged in (or `FLY_API_TOKEN`, else `~/.config/edgecoder/fly.token`), the
account files with API keys, and the coordinator admin token in
`~/.config/edgecoder/coordinator-admin-token` for the server-side report. No command prints a key.

```sh
# 0. Once: the app and its only secret (LOADGEN_KEYS, built from the account files on stdin)
scripts/loadgen/fly.sh create

# 1. Budget: balances, then top up every account below 1500 to 3000 cSats (at most 21000 sats)
node scripts/loadgen/budget.mjs check
node scripts/loadgen/budget.mjs topup --min 1500 --to 3000 --max-total 21000 [--dry-run]

# 2. Run (all machines start together ~150 s after the deploy; the generated fly.toml goes to
#    $LOADGEN_FLY_DIR, default $TMPDIR/edgecoder-loadgen, never into the repo)
scripts/loadgen/fly.sh run smoke    --regions iad,lhr
scripts/loadgen/fly.sh run steady   --rate 4 --duration 30m
scripts/loadgen/fly.sh run ramp     --stage-minutes 5               # add --max-rate 8 to stop at 8/s
scripts/loadgen/fly.sh run saturate --budget 6000
scripts/loadgen/fly.sh run soak     --duration 2h --loop

# 3. Watch: per-model / per-class slot samples for the report (leave it running), live JSON lines,
#    and the admin page (below)
scripts/loadgen/fly.sh watch &
scripts/loadgen/fly.sh logs

# 4. Results: merges every machine's stages and adds the coordinators' series for the same window
scripts/loadgen/fly.sh report --out /tmp/loadgen-report.json

# 5. Tear down (results on the machines are gone after this, so report first)
scripts/loadgen/fly.sh stop        # fly scale count 0: no machines, no cost
scripts/loadgen/fly.sh destroy     # delete the app and its secret
```

Locally, one process plays every user (useful for a quick check):
`node scripts/loadgen/loadgen.mjs --profile smoke --users st1,st2 --duration 60s`.

Machines stop on their own `LOADGEN_LINGER_SEC` (default 30 min) after their run ends (restart
policy `never`), so a forgotten app costs at most that.

## Reading Settings → Network during a run

- **Utilization** should climb with each stage. If it stays low while the client sees
  `no_capacity`, slots are idle but not picked up: compare pickup p90.
- **Queue / waiting inference** rising and not draining between ticks means arrivals exceed
  service; the saturation point is the stage where client throughput stops tracking offered rate.
- **Pickup p90** is dispatch latency (queued → claimed); client TTFT minus pickup is model time.
- **Gaps** list models asked for with no holder or no free slot: expect `qwen2.5-coder:7b` (apple)
  when the Macs are offline or registered as `cpu`.
- Coding sessions land on the GPU (`qwen3-coder:30b`, one slot): it saturates first.