# Cloud host: hosted models on the network

A cloud host is an EdgeCoder agent that answers model calls by forwarding them to a hosted model
API with one platform API key, instead of running the model on its own GPU. It lets the network
offer large open models (GLM-5.3, DeepSeek V4.1 Flash) without renting an 8×H200 node.

To the rest of the network it is an ordinary host: it registers, heartbeats, pulls model calls,
streams the reply in pieces (`/inference/chunks`) and is paid for each call like any host. What
differs:

| | Ordinary host | Cloud host |
| --- | --- | --- |
| Runs the model on | its own Ollama / vLLM / MLX | the provider's API (Fireworks first), `src/cloud-host/backend.ts` |
| Compute class | `cpu` / `apple` / `gpu` / `gpu.dc`, from its hardware | `cloud`, granted only to `CLOUD_HOST_OWNER_EMAILS` |
| Models | whatever it has installed | the cloud catalog (`src/cloud-host/catalog.ts`) |
| Price of a call | token price by model size (job-pricing.ts) | provider's USD price + margin (`src/economy/cloud-pricing.ts`) |
| Cost to the owner | electricity | provider bill, capped by the spend guard |

Users see the models as `glm-5.3 · cloud` and `deepseek-v4.1-flash · cloud`, and call them as
`network/glm-5.3@cloud` (or `network/glm-5.3`, which only a cloud host serves).

## Models and prices

Read from [fireworks.ai/pricing](https://fireworks.ai/pricing) and the model pages on 2026-11-23.
USD per million tokens, serverless standard tier.

| Network id | Fireworks model id | Input | Cached input | Output | Context (served) | Origin |
| --- | --- | --- | --- | --- | --- | --- |
| `glm-5.3` | `accounts/fireworks/models/glm-5p3` | 1.40 | 0.26 | 4.40 | 1,000,000 (Fireworks: 1040k) | Z.ai (Zhipu AI), CN |
| `deepseek-v4.1-flash` | `accounts/fireworks/models/deepseek-v4p1-flash` | 0.30 | 0.006 | 1.20 | 1,000,000 (Fireworks: 1040k) | DeepSeek, CN |

DeepSeek V4.1 Flash is the default cloud model (owner decision, 2026-11-23). Each catalog entry
has a `rank` (lower is listed first), an optional `hint` and an `autoEligible` flag:

| Network id | `rank` | `hint` | `autoEligible` | Shown as |
| --- | --- | --- | --- | --- |
| `deepseek-v4.1-flash` | 1 | `recommended` | yes | Cloud · recommended |
| `glm-5.3` | 2 | `premium` | yes (premium: see Auto routing) | Cloud · premium |

`GET /inference/models` lists the cloud models in rank order among themselves (other models keep
their order by machines online) with `cloudRank`, `cloudHint` and `paramsB`, and the web chat
picker, `GET /portal/api/models` (the iPhone picker) and the desktop compute picker follow it.

Each catalog entry carries `origin: { vendor, country }`, and `GET /inference/models` returns it
(with `hostedBy: "fireworks"`) for every cloud model, so a "no models of origin X" filter can be
built on it later. No filter is applied today.

## How a call is priced

The coordinator prices a cloud-model call from the catalog, never from anything the host says:

```
price per token (USD)  = provider price × (1 + margin)          for input, cached input, output
cost (msat)            = ceil( Σ tokens × price × 1e11 / btcUsd )
```

- **Margin**: `CLOUD_MARGIN_PCT` on the coordinators, default 30. It is never below the margin at
  which the host's share after the network fee still covers the provider's cost:
  `(1 + margin) × (1 − NETWORK_FEE_BPS / 10000) ≥ 1`, about 5.3 % at the 5 % fee. Prices are
  rounded up, never down.
- **BTC/USD**: the latest rate epoch, the same rate every other price uses. Nothing is stored in
  sats: when BTC moves, the next call is priced at the new rate, and `cSatsPerMTokens` in
  `/inference/models` follows.
- **Tokens**: the provider's own counts (`usage`), relayed by the host with the last chunk,
  including `cachedPromptTokens` (`usage.prompt_tokens_details.cached_tokens`), which are billed at
  the cached-input price. Output tokens of a cloud call are bounded by the call's `max_tokens`, not
  by the reply's bytes, because tool calls and a reasoning pass are billed by the provider but
  never appear in the reply text.

**How it fits the existing formula.** Model calls were already priced per token
(`inferenceCostMsat` in `src/economy/job-pricing.ts`), at a USD price per million tokens chosen by
model size, with a power floor. The extension is one optional input, `price`: a model's own USD
token price (with `cachedInput`). When it is set (a cloud model) it replaces the size band, the
power floor does not apply, and the cost is rounded up. Everything after that is unchanged: the
reserve at submit (`inferenceReserveMsat`, same `price`), settlement against the reserve, and the
95 / 5 split (`splitJobCost`, `NETWORK_FEE_BPS`). The best-fit estimate and the listing use the
same price.

Worked example, GLM-5.3 at 30 % and BTC = 100,000 USD: 20,000 prompt tokens (15,000 cached) and
1,000 output tokens cost 5,000 × 1.82 + 15,000 × 0.338 + 1,000 × 5.72 = 19,890 USD/M ≈ 0.0199 USD
≈ 19.9 cSats. The provider bills 0.0153 USD; the host account gets 95 % (≈ 0.0189 USD), EdgeCoder
5 %.

## Spend guard

The host keeps what the platform's key has spent (provider counts × provider price) per UTC day
and month, in `CLOUD_HOST_STATE_FILE` so a restart does not forget it.

| When | What happens |
| --- | --- |
| 80 % of a cap (`CLOUD_HOST_ALERT_PCT`) | one warning alert per period |
| 100 % of the daily (`CLOUD_HOST_DAILY_CAP_USD`, 200) or monthly (`CLOUD_HOST_MONTHLY_CAP_USD`, 2000) cap | critical alert; the host advertises no models, takes no calls, and refuses a call that still reaches it with `cloud_capacity_paused: … resumes at <time>` |
| the next UTC day / month | resumes by itself, with a "serving again" alert |
| 3 provider 401 / 403 in a row (`CLOUD_HOST_AUTH_FAILURES`) | critical alert; paused the same way until the key works again (checked every `CLOUD_HOST_AUTH_PROBE_MINUTES`, 15) |
| the provider refuses a call for the account: HTTP 412 (Fireworks: account suspended), 402, or an error saying the account is suspended, out of credit or over its spending limit | critical alert (`cloud_provider_account`), at most once an hour per host; the host is not paused (the call fails as `cloud_provider_error` and the coordinator's breaker handles it as before). Fix the account in the provider's console |

Alerts go through `src/alerting` (email via Resend to `ALERT_EMAILS`, and/or `ALERT_WEBHOOK_URL`),
configured on the cloud host's app. A reply that breaks off before the provider's counts is
still counted, estimated from its text. Keep a spending limit on the provider account as well:
the guard counts what this host spent, not other uses of the key.

Provider errors: 429 and 5xx are retried with exponential backoff (Retry-After honoured) up to
`CLOUD_HOST_MAX_RETRIES` (3) before anything was streamed; after that the call fails with
`cloud_provider_error: …` / `cloud_provider_rate_limited: …` and the coordinator may give it to
another host. A prompt longer than the model's window fails as `context_too_long`.

Reasoning: GLM-5.3 and DeepSeek V4.1 Flash stream their thinking (`reasoning_content`) before the
answer, and the provider counts it as output: Fireworks' `max_tokens` covers the thinking and the
answer together (network runs 3 and 4: calls at `max_tokens` 1024 and 2048 ended inside the
thinking). So the host gives a reasoning model room to think:

- it asks the provider for the call's `max_tokens` plus a reasoning allowance
  (`CLOUD_HOST_REASONING_ALLOWANCE`; 4096 for Flash and 2048 for GLM-5.3 by default);
- it passes on at most the call's own `max_tokens` of answer (estimated from the stream: a piece is
  about a token, at least one per 4 characters). At the cap it closes the stream and the reply ends
  with finish `length`. The provider's counts then never arrive, so the tokens streamed so far
  (thinking and answer) are estimated the same way;
- for a model whose provider takes an integer `reasoning_effort` as a hard thinking budget
  (catalog `thinkingBudget`; DeepSeek V4.1 Flash: Fireworks ends the thinking after that many
  tokens when the integer is 1024 or more), the allowance is also sent as that budget (at least
  1024), so the answer always gets its room. Network run 5: without it, Flash thought past 6144 and
  then 10240 tokens on a standard refactor at `max_tokens` 2048, and 3 of 8 calls ended
  reasoning-only. If the provider refuses the integer, the call is asked again without it and the
  host stops sending it for that model. GLM-5.3 ignores integers, so it gets no budget. When
  `CLOUD_HOST_REASONING_EFFORT` is `none`, no budget is sent;
- a reply that is still reasoning only is asked once more with twice the allowance (nothing has
  reached the caller yet). A second reasoning-only reply fails as `cloud_reasoning_overrun: …`
  (HTTP 503). That is the host's limit, not the request's, so the coordinator may give the call to
  another host and charges nothing for it. The host never ends a call with an allowance as
  `reasoning_only`; that error (HTTP 400, never retried) now comes only from a call without
  `max_tokens` or a model without an allowance.

**Billing reasoning tokens.** The buyer is billed on the completion tokens the provider reports,
the thinking included, through the usual pricing path, but never more than the call's own
`max_tokens` (+64): the coordinator bounds a cloud call's output by its `max_tokens`
(`boundTokenCounts`), which is also what the hold at submit was sized on. Thinking past that, and
an attempt asked again after a reasoning-only reply, are the platform's cost: the host adds every
attempt the provider billed to its spend guard, and nothing of it reaches the buyer or the ledger.
This keeps the ledger as it was (settlement never exceeds the hold) and the buyer's bill within the
cap they set; billing only the answer's tokens would price most calls below the provider's cost.
`CLOUD_HOST_REASONING_EFFORT` (unset: the provider's default) is sent as `reasoning_effort` with
every call, e.g. `low`, or `none` where the provider can turn thinking off for the model. On a model
with a thinking budget (above) the integer budget is sent in its place, unless the word is `none`.

Circuit breaker (coordinator, `memory-admission.ts`): a host trips after consecutive failed calls,
3 or half its slots (8 for a 16-slot cloud host). While open it gets no placements: a named call
whose only hosts are cooling down is answered at once with `503 no_capacity` (`reason:
cooling_down`, Retry-After), Auto places elsewhere, and calls already waiting for it are re-placed
or refunded when it trips. After the cool-down (60 s, doubling to 5 min) it takes one call at a
time; a success closes the circuit, a failure opens it again.

## Who may run one

A cloud host spends the platform's provider budget and is paid at the cost-plus price, so the
coordinator decides who runs one:

- a registration whose hardware profile claims `cloud` is refused (`403 cloud_host_not_allowed`)
  unless the agent's owner email is in `CLOUD_HOST_OWNER_EMAILS` on the coordinator **and** the
  owner is an approved host (`HOST_APPROVED_EMAILS`, or approved in Settings > Admin);
- cloud model ids are dropped from every other agent's reported models, so no machine can
  advertise `glm-5.3` and answer with something else at the cloud price; a cloud host in turn
  serves only cloud models;
- payouts go to the owner account of the enrolled node, like any host.

### Auto routing

Auto (`model: "auto"`, the coordinator's best fit) considers cloud models on its own: nobody has
to pick or pin one when the network's models change. The coordinator variable `AUTO_CLOUD_MODELS`
only narrows it:

- unset or empty (the default): every catalog cloud model flagged `autoEligible` (Flash and
  GLM-5.3; `CLOUD_MODELS_JSON` entries default to true) whose cloud host is online;
- a comma list (e.g. `deepseek-v4.1-flash`): only those (named models count even when not
  `autoEligible`);
- `off`: none, the emergency switch.

An allowed cloud model is a best-fit candidate for a job only when

- the job wants the network's top tier: not a light job (summarize, extract, classify) and
  complexity at least 0.75 (`AUTO_CLOUD_MIN_COMPLEXITY` in `src/swarm/coordinator/best-fit.ts`),
  where best fit asks for a 30B-class model, **or**
- no other machine meets the job's hard requirements: a model that calls tools when it needs
  them, a context window that holds it, within the price ceiling, and at least the size floor
  (complexity's `minParamsB`, or the client's own floor: a bot's agent step sends
  `minParamsB` = `BOT_AGENT_MIN_PARAMS_B`). The cloud is then the automatic fallback.

A light or simple job that a network machine can serve never goes to the cloud. Among cloud
models the standard one (Flash) is kept over the premium one (catalog `hint: "premium"`,
GLM-5.3): the premium one is used when it is the only cloud model that fits, or when the job
asks for `quality: best` at top-tier complexity and its estimate is within the price ceiling. A
price ceiling (`maxCSats`, a bot's budget left) below a cloud call's estimate leaves it out, and
the no-route error then names the cheapest fitting model and its estimate.

Both built-in cloud models reason before they answer (`reasoning_content`). The cloud host gives
them room on top of the call's `max_tokens` (Reasoning, above), so best fit no longer keeps a
small-`max_tokens` call off them. `AUTO_REASONING_MIN_TOKENS` still sets a minimum `max_tokens`
for a reasoning model (`2048` for both, `glm-5.3=2048,deepseek-v4.1-flash=1024` per model), for a
cloud host without the allowance; it is off by default. A call without `max_tokens` is never
filtered.

For a simple or standard call the cloud is overflow, decided before anything is scored: it is not
a candidate at all while any network machine in the call's spill band has a free slot that would
finish in time, whatever session affinity or the speed estimate say. In time means an estimated
completion within `BEST_FIT_MAX_COMPLETION_MS` (120 s, two thirds of the 180 s call deadline). A
machine slower than that is not counted as room, so the cloud takes the call. While the cloud can
take it, such a machine is not placed on (network run 4: a 1.5b CPU host given a 2.5k-token tests
call timed out at 180 s). Peers' machines count too: routing keeps using a peer coordinator's last
good view for up to 60 s while a refresh is slow or failing. A decision that sends a call to the
cloud as overflow says so: `(cloud overflow: no machine ≥ 1.5B has a free slot that finishes
within 2.0 min)`.

When nothing fits, the coordinator says why: `No machine on the network can run this job right
now (needs a model ≥ 14B with tools; online: …)`, a price ceiling below every fitting model, or
(after a routed call found no free machine in time) that the machines running the chosen model
are busy.

It then competes with the network's machines on the usual score (quality, latency, price,
reliability). A cloud host's speed is its measured rate, else 60 tokens/s, it never pays a cold
load, and its size is not penalised as oversized. Set the same value on every coordinator.

## Running it

The cloud host is the agent's own entry point, from the existing agent image
(`deploy/docker/Dockerfile.agent`): `node dist/cli/edgecoder.js cloud-host`. That role sets
`EDGECODER_ENGINE=cloud`, `SANDBOX_MODE=none`, `AGENT_INFERENCE_ONLY=1`,
`LOCAL_MODEL_PROVIDER=ollama-local`, `AGENT_BENCHMARK=0`, `AGENT_REMOTE_CONTROL=off` and `EDGECODER_BLE=0` unless set.
No Dockerfile change is needed; set `SKIP_OLLAMA=true` so the entrypoint starts no Ollama.

1. **Coordinators** (both seeds): set `CLOUD_HOST_OWNER_EMAILS=<owner email>` (and optionally
   `CLOUD_MARGIN_PCT`, `CLOUD_MODELS_JSON`), and make sure the owner is an approved host.
2. **Enrol the node** under the owner account (portal **Enroll node**, or
   `POST /nodes/enroll {"nodeId":"cloud-fireworks-1","nodeKind":"agent"}` with an `eck_` key, as in
   `deploy/gpu-agent/README.md`). Keep the registration token.
3. **Create the Fly app** with the proposed config below, its volume, and the secrets.
4. Deploy, then check the log for
   `[cloud-host] Fireworks at https://api.fireworks.ai/inference/v1: serving glm-5.3, deepseek-v4.1-flash`
   and a successful registration, and that `GET /inference/models` on a seed lists both models
   with `classes: ["cloud"]`.

### Proposed `deploy/fly/fly.cloud-host.toml` (not committed; for the owner to approve)

```toml
app = "edgecoder-cloud-host"
primary_region = "ord"

[build]
  dockerfile = "../docker/Dockerfile.agent"

[processes]
  app = "node dist/cli/edgecoder.js cloud-host"

[env]
  NODE_ENV = "production"
  SKIP_OLLAMA = "true"                       # agent image entrypoint: no Ollama
  AGENT_ID = "cloud-fireworks-1"             # the enrolled node id
  AGENT_OS = "debian"
  AGENT_MODE = "swarm-only"
  COORDINATOR_URL = "https://coordinator.edgecoder.io"
  PORTAL_URL = "https://edgecoder.io"
  EDGECODER_CONFIG_DIR = "/data/edgecoder"   # agent keys and the spend file survive deploys
  CLOUD_HOST_PROVIDER = "fireworks"
  CLOUD_HOST_MODELS = "glm-5.3,deepseek-v4.1-flash"
  CLOUD_HOST_MAX_SLOTS = "16"
  CLOUD_HOST_DAILY_CAP_USD = "200"
  CLOUD_HOST_MONTHLY_CAP_USD = "2000"
  CLOUD_HOST_STATE_FILE = "/data/edgecoder/cloud-host-spend.json"
  ALERT_EMAILS = "cody@edgecoder.io"          # who gets the 80 % / cap / bad-key alerts

[mounts]
  source = "cloud_host_data"
  destination = "/data"

[[vm]]
  memory = "1024mb"
  cpu_kind = "shared"
  cpus = 1
```

No `[http_service]`: the cloud host only makes outbound calls (coordinator, provider). One
machine: two would each keep their own spend total, so the caps would double.

```bash
fly apps create edgecoder-cloud-host
fly volumes create cloud_host_data --app edgecoder-cloud-host --region ord --size 1
fly secrets set --app edgecoder-cloud-host \
  CLOUD_HOST_API_KEY=<fireworks key> \
  AGENT_REGISTRATION_TOKEN=<token from step 2> \
  RESEND_API_KEY=<resend key> RESEND_FROM_EMAIL=<sender>
fly deploy --config deploy/fly/fly.cloud-host.toml
# The new volume is root-owned; the agent runs as uid 1000 (as for the seeds' /data/ollama):
fly ssh console --app edgecoder-cloud-host -C "chown -R 1000:1000 /data" && fly machine restart --app edgecoder-cloud-host
```

## Adding a model

1. Find the provider's model id and its input / cached-input / output price per million tokens.
2. Add it, either
   - in code: a `BUILTIN_CLOUD_MODELS` entry in `src/cloud-host/catalog.ts` (id, `providerModel`,
     `usdPerM`, `priceAsOf`, `contextWindow`, `paramsB`, `origin`, `capabilities`, `rank`, `hint`,
     `autoEligible`), or
   - without a release: `CLOUD_MODELS_JSON` on **both** the coordinators and the cloud host, e.g.
     `[{"id":"kimi-k3","providerModel":"accounts/fireworks/models/kimi-k3","usdPerM":{"input":1.0,"cachedInput":0.2,"output":3.0},"contextWindow":256000,"paramsB":1000,"origin":{"vendor":"Moonshot AI","country":"CN"},"priceAsOf":"2026-12-01"}]`.
     Entries replace built-in ones with the same id, which is also how a price change is applied.
     An entry replaces the whole built-in entry: give `rank`, `hint` and `autoEligible` again
     (unset: rank 100, no hint, auto-eligible: Auto may use it as soon as its host serves it;
     `"autoEligible": false` keeps it out of Auto).
3. Add the id to `CLOUD_HOST_MODELS` (or leave it unset to serve every catalog model of the
   provider) and restart the cloud host.

## Known limits

- A buyer's own `maxCSats` ceiling caps the reserve, and settlement never takes more than the
  reserve: a cloud call capped that way can settle below the provider's cost. The spend guard
  still bounds the platform's exposure. A follow-up could lower `max_tokens` to fit the ceiling.
- The spend total is per cloud-host process; run one machine per provider key.
- Auto / best-fit routing uses cloud hosts by default for top-tier jobs and as the fallback when nothing else fits; `AUTO_CLOUD_MODELS=off` stops it (see above).
- The origin field is data only; no filter or UI uses it yet.

Environment variables: [site-docs/reference/environment-variables.md](../site-docs/reference/environment-variables.md)
("Cloud host" and "Economy, payouts and receipts").
