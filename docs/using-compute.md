# Using EdgeCoder compute

This guide covers running models through EdgeCoder from the desktop app and from your own tools: connections, where requests run, reservations, the usage page, persistent bots and pricing.

All amounts are in cSats. 1 cSat = 1 sat of prepaid compute.

## Connections

A connection is a local address on your computer that any OpenAI- or Anthropic-compatible tool can use. Open **Connect your tools** in the desktop app to create one. Each connection has:

| Field | What it is |
| --- | --- |
| Name | Shown in the app and recorded as the "Tool" on the usage page. |
| Port | Its own local port. The endpoint is `http://127.0.0.1:<port>/v1`. |
| Key | Its own key, `ec-...`. Make a new one any time; tools using the old key stop working. |
| Runs on | The target: Auto, This computer, My machines, Network or Reserved (see below). |
| Model | The model it runs. The model name your tool sends is ignored: the connection decides what runs. |
| Budget | Optional cSat limit. Once spent, requests fail with HTTP 402 until you raise or reset it. Offered for the network, reserved and Auto targets. |

Several connections run at once, so different tools (or several copies of one tool) can use different compute in parallel. Connections are saved in `~/.edgecoder/connections.json` (mode 0600).

### Ports

EdgeCoder's own services use 4301-4306 and the portal uses 4310, so those ports are reserved. New connections get the next free port starting at **4311**. You can pick any port from 1024 to 65535 that isn't reserved or used by another connection. A connection saved earlier on 4310 keeps that port when you edit it.

If another program already holds the port, the connection shows "Port N is in use by another program. Pick another port."

### Routes and auth

Every connection serves the same routes:

| Route | API |
| --- | --- |
| `GET /v1/models` | OpenAI. Lists the one model the connection runs. |
| `POST /v1/chat/completions` | OpenAI chat, streamed or not. |
| `POST /v1/messages` | Anthropic Messages, streamed or not. |
| `POST /v1/messages/count_tokens` | Anthropic token count. |
| `GET /health` | Connection name and model. |

Send the key as `Authorization: Bearer <key>` (OpenAI clients, Claude Code's auth token) or `x-api-key: <key>` (Anthropic SDKs).

```sh
curl http://127.0.0.1:4311/v1/chat/completions \
  -H "Authorization: Bearer ec-..." -H "Content-Type: application/json" \
  -d '{"model": "qwen3.5:9b", "stream": true, "messages": [{"role": "user", "content": "hello"}]}'
```

## Targets

| Target | In the app | Where it runs | Needs | Cost |
| --- | --- | --- | --- | --- |
| `auto` | Auto | The cheapest place that fits each request (see [Auto routing](#auto-routing)). | Nothing extra | Free when it lands on your machines or a reservation |
| `local` | This computer | This computer's Ollama. | A local model | Free |
| `mine` | My machines | Your other machines signed in to the same account. | This computer's agent connected to the network | Free |
| `network` | Network | Any agent on the network, optionally one class. | Agent connected | Per token (see [Pricing](#pricing)) |
| `reserved` | Reserved | The machine you reserved. | Agent connected and an active reservation | Prepaid by the reservation |

Network options:

- **Class** (`computeClass`): `any`, `cpu`, `apple`, `gpu` or `gpu.dc` (shown as Any, CPU, Apple, GPU, Datacenter GPU). Defaults to `any`; the app's form starts on GPU.
- **Max price** (`maxCSatsPerSecond`): the most to pay, in cSats per second on the class's base tier. Empty means no limit.

The model name the connection reports is `auto`, the bare model (`local`), `mine/<model>`, `reserved/<model>`, or `network/<model>` with `@<class>` when a class is set.

## Auto routing

Auto picks a place per request (`src/inference-api/auto-route.ts`):

1. **Size the job.** A request that sends tools, or whose prompt is estimated at more than 6,000 tokens, is heavy (agent work). Anything else is a quick task.
2. **Pick a model at each place.** Embedding models are never used. Heavy work needs a model of at least about 6B parameters and prefers ones near 14B, with coder models ranked higher. Quick tasks prefer the smallest model from about 1B up, since bigger models take longer.
3. **Rank places, cheapest first:** an active reservation you hold (already paid), this computer (free), your other online machines (free), then the network. On the network, model calls cost the same per token on every class, so faster classes come first: Datacenter GPU, GPU, Apple, CPU. CPU is skipped for heavy work.
4. **Try in order.** If a place can't start the request, the next one is tried, up to four.

If nothing fits, the request fails with a message asking you to install a coder model (7B or larger) on one of your machines or try again later. The hosted endpoint's `auto` works the same way without "this computer".

## Reservations

A reservation holds one machine of a class for a set time, so it works only for you. Make one on the **Compute** page under **Reserve a machine**:

- Pick a class (the page shows how many machines are free), a duration (15m, 30m, 1h, 2h, 4h or 8h in the app; the network accepts 5 minutes to 24 hours) and optionally a model the machine must already have.
- The price is the class's per-second rate times the machine's tier weight, for every second held, used or not. It is paid up front from your cSats.
- While it runs, jobs on that machine are not billed per second; the reservation covers them.
- It ends when time is up, when you press **End**, or when the machine hasn't been seen for 2 minutes. Unused time is refunded. Ended reservations show what was used and returned.

To use a reservation from a tool, create a connection with **Runs on: Reserved** and pick the reservation, or press **Use in a tool** next to it. When the reservation ends, that connection's requests fail; the app offers **Switch to Auto** (same address and key) or **Reserve again**. Auto also uses any active reservation first.

## Usage page

Open **Usage** from the profile menu. It shows requests settled by the network for your account (network, your machines and reservations; runs on this computer's Ollama aren't recorded there):

- A period of 7, 30 or 90 days, and a **CSV** export of the requests.
- Totals: cSats spent, requests (and how many failed), compute time, tokens in and out, and cSats per million tokens.
- A bar chart of cSats spent per day.
- **Budget**: spend this calendar month against a monthly budget you set. It warns at 80% and when over. This is a warning kept in the app, not a hard limit; for a hard limit, set a budget on a connection.
- A breakdown by **Model**, **Class**, **Tool** (the connection name or other source) and **Where**, with requests, time, tokens, cSats per million tokens and cSats.
- A request log (up to the 200 most recent) with time, model, where it ran, tool, duration, tokens and cost.

## Claude Code

Create a connection, select it on **Connect your tools**, and pick Claude Code. The app fills in the address and key. Note the base URL has no `/v1`:

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:4311
export ANTHROPIC_AUTH_TOKEN=ec-...
export ANTHROPIC_MODEL=qwen3.5:9b
export ANTHROPIC_SMALL_FAST_MODEL=qwen3.5:9b
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
claude
```

The model variables only label requests; the connection decides what runs. The same page has steps for Continue, Cline, aider, Codex CLI, Zed, the OpenAI SDK and curl.

## Cursor and the hosted endpoint

Cursor calls custom models from its own servers, so it can't reach a port on your computer. Use the hosted endpoint instead:

1. Create an API key on the web portal (Settings, API keys). Keys start with `eck_` and are shown once.
2. In Cursor: Settings, Models, turn on OpenAI API Key and paste the key, turn on Override OpenAI Base URL, and add a custom model.

```text
Base URL:  https://edgecoder.io/v1
API key:   eck_...
Model:     auto
```

The hosted endpoint serves the same OpenAI and Anthropic routes and suits servers and computers without the app. Requests are billed to your account in cSats. Name the model per request:

| Model | Runs on |
| --- | --- |
| `auto` | The cheapest place that fits: a reservation, your machines, then the network. |
| `network/<model>` or `network/<model>@<class>` | The network; a bare `<model>` means the same. |
| `mine/<model>` | Your own machines. |
| `reserved/<reservation>/<model>` | A reservation you hold. |

`GET /v1/models` lists what's available. With the same key, `GET /v1/account` returns your balance and recent usage, `GET /v1/account/usage?days=N` the usage records, and `/v1/account/reservations` lists, creates and cancels reservations.

On the desktop, `http://localhost:4304/v1` with this computer's key (under "Other ways in") reaches every model on one address, chosen by the same model names plus local model tags.

## Persistent bots

A bot is a named, long-lived agent that owns a job in one project folder. Each run is one agent turn in that folder on Auto compute. Bots are managed in the desktop app (and over `/v1/ide/bots` on the local IDE server).

| Setting | Details |
| --- | --- |
| Name, Role | Role is shown next to the name. |
| Instructions | Its job, added to the agent's instructions on every run. |
| Memory | Notes the bot saves for itself with a remember tool (kept to 8 KB). You can edit or clear them. |
| Project folder | An absolute path to an existing folder. It reads and edits files only there. |
| Schedule | See below. Empty means it runs only when asked. |
| Daily budget | cSats a day (default 100, or no limit). A run stops when it's spent. Runs on this computer are free. |
| Tools | Reading the project is always on. Optional: Edit files, Run commands, Commit and push. |
| Apply edits without asking | On by default. Each run keeps the originals so you can review and undo. |

Schedules accept `every N minutes`, `every N hours`, `every N days`, `hourly`, `daily` (09:00), `daily at HH:MM` (or `9am`, `6:30pm`), or a 5-field cron expression such as `0 9 * * 1-5`. Bots run at most every 5 minutes. Times are local.

**Approvals.** Shell commands, commits and pushes always ask first. The run pauses with the status **Needs approval** until you approve or reject; an unanswered approval is rejected after 24 hours. Turn off "Apply edits without asking" to make file edits ask too.

**Running.** A bot runs on its schedule, when you press **Run now**, or when you message it, never two runs at once. **Stop** ends the current run (pending approvals are rejected). **Pause** stops the schedule; messages and Run now still work. **Resume** restarts it. The run history lists each run's trigger (Schedule, Message, Run now), status, summary and cost.

Bot config and history live in `~/.edgecoder/bots.json`; each bot's conversation and memory are under `~/.edgecoder/bots/<id>/`.

## Large models

The model catalog's "Large (GPU servers)" category holds models for GPU machines with a lot of memory:

| Model | Size | Disk | Min memory |
| --- | --- | --- | --- |
| `qwen2.5-coder:32b` | 32B | 20 GB | 24 GB |
| `llama3.3:70b` | 70B | 43 GB | 48 GB |
| `deepseek-r1:70b` | 70B | 43 GB | 48 GB |
| `gpt-oss:120b` | 117B (5.1B active) | 65 GB | 80 GB |
| `deepseek-coder-v2:236b` | 236B (21B active) | 133 GB | 160 GB |
| `qwen3:235b` | 235B (22B active) | 142 GB | 160 GB |
| `qwen3-coder:480b` | 480B (35B active) | 290 GB | 320 GB |

The biggest ones need several cards pooled; `qwen3-coder:480b` needs seven or eight 48 GB cards.

## Pricing

- **Model calls** are priced per token by model size, below typical hosted prices for open models of that size (`TOKEN_PRICE_USD_PER_M` in `src/economy/job-pricing.ts`), converted to cSats at a live BTC price. A call never costs less than a per-class electricity floor for the seconds it ran. The price is the same on every class; faster hardware finishes sooner. The Compute page lists cSats per million tokens in and out for each model.
- **Code jobs and reservations** are priced per second at the class's rate times the tier weight. The Compute page lists each class's base-tier rate.
- Your own machines and this computer are free.

See [economy-math.md](economy-math.md) for the full model.
