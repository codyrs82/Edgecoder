# Frontier models on your own key

EdgeCoder's network runs open models, such as `qwen3-coder:30b`. They do well on contained tasks,
but they are not strong enough to lead long, real coding work. For that, you can bring your own API
key for a frontier model and make it the **lead**: the model that plans and drives the agent. The
**worker** model (Auto, on the network or this computer) still does helpers and delegated work.

- **Providers:** Anthropic (Claude), plus any OpenAI-compatible API given a base URL. That covers
  OpenAI, OpenRouter, Together, Groq, a local LM Studio, and others.
- **Billing:** the provider bills you directly. EdgeCoder charges no cSats for these calls. It
  keeps a local estimate of what you spent, so you can see it and cap it.

## Set it up in three steps

1. **Add your key.** In the app, open Settings → Frontier models (your keys), choose the provider,
   paste the key and click **Test and save**. In a terminal, run `edgecoder keys add anthropic`;
   it asks for the key without showing it. The key is checked with a request that uses no tokens
   (the provider's model list), then stored in your keychain.
2. **Pick the lead.** In the model picker, choose **Lead: Claude Opus 5.5 · your key**. In a
   terminal, run `edgecoder code --lead frontier/anthropic/claude-opus-5-5 --worker auto`, or use
   `/lead` in a running session.
3. **Set your caps.** The defaults are $5 per session and $25 per day. Change them in Settings, or
   run `edgecoder keys set --session-cap 10 --daily-cap 40`.

## Who can use a key

> Usable only by your account on this computer. Never used for other people's requests or for
> network work. Bits use your key only when only you can start them, and only after you approve
> each use.

Each stored key records the EdgeCoder account (`acct-…`) that added it. EdgeCoder uses the key
only when all of these hold:

- that same account is the one signed in on this computer;
- the request is that account's own:
  - your sessions and chats in the app or `edgecoder code`;
  - your own editor or tools talking to the provider on this computer (loopback, with the IDE
    token);
- for a shared session, the session was created by that account, and the message came from one of
  that account's clients.

The signed-in account is checked with the coordinator. If that check can't get an answer (a slow
coordinator, the agent reconnecting, or the machine busy compiling), the last confirmed account is
kept for up to 10 minutes, so a running turn isn't cut off. A definite "signed out" ends it at once
(`ACCOUNT_UNKNOWN_GRACE_MS` in `src/apps/ide/provider-server.ts`).

If someone else signs in on this computer, your keys show as **belongs to another account**. They
can be removed there but not used, until you sign back in.

A session can be joined by a client from another account. Today that only happens on the same
machine; remote attach is planned. When it does, frontier turns are refused for that client's
messages. The turn runs on the session's worker model instead, with the note "Frontier lead is
limited to <owner>'s own requests." Bits use your key only when only you can start them, and only
after you approve each use: see [Bits and your key](#bits-and-your-key).

Messages sent while a turn runs wait in the session's queue. Each queued message carries the
account of the client that sent it. When the queue drains, the next turn takes only a run of
messages from one account, so another account's message never rides along on a frontier turn.

### Never network work

A frontier model is never served to anyone else through EdgeCoder. Several layers enforce this:

- Frontier ids (`frontier/<provider>/<model>`) never reach a coordinator. They are not in
  `/register` or heartbeat model lists, network model listings, the network world view, or Auto's
  routes. Coordinator best-fit routing can never pick one, for you or for another account.
- If something sends a frontier id anyway, the coordinator refuses the job with
  `frontier_model_not_routable`. An agent handed one refuses it too, with
  `frontier_models_are_not_network_work`, before anything runs.
- Only the IDE provider process imports the frontier backend and the key store. The agent that
  runs network subtasks (`worker-runner.ts`, `inference-runner.ts`) does not, and a test checks
  this.

### Pooling or reselling keys isn't supported

Provider terms, including Anthropic's and OpenAI's, tie an API key to the person or organisation
that holds it. Sharing it with others, pooling it, or reselling access breaks those terms. It
would also make your bill and your rate limits pay for other people's work. EdgeCoder therefore
binds each key to one account on one computer and never routes anyone else's request to it. Use
the network for shared compute. Use your own key for your own work.

## Bits and your key

A desktop bit can lead with your key, the way a coding session does, when you turn on **Lead with
Claude (your key)** in its settings in the app. The switch shows only when your account has a key
on this computer. Bits use your key only when only you can start them, and only after you approve
each use.

**Only you can start it.** A run may use the key when it was started by your message, **Check
now**, the bit's schedule, its check-ins, its own start or its follow-ups. Never a GitHub trigger:
anyone who opens a pull request or an issue could start that run. So:

- the switch can't be turned on while the bit has a GitHub trigger, enabled or not;
- adding a GitHub trigger later turns the switch off, with a note in the bit's chat
  ("Claude lead turned off: GitHub triggers let other people start …").

**Only your account.** A bit records the account that was signed in when it was made
(`ownerAccount`). Each run checks that the account signed in on this computer is the bit's owner
and owns the key. Bits made before this existed have no owner: turning the switch on in the app,
signed in, records you as the owner. Bits made from the web record the account that asked.

**Only from the app.** The switch and its caps are set only in the desktop app (the IDE provider's
routes, behind the IDE token). The web can't turn it on or change its caps, and a bit's compute is
never a frontier model. The web shows whether the switch is on and what it spent today. Cloud bits
never use a key.

**You approve each use.** Before the first model call that would use the key, the run checks, in
order: what started it, no GitHub triggers, the account (signed in here, the bit's owner, the
key's owner), and the caps. If any check fails, the run uses the bit's own compute, with a note
such as "Claude lead off: GitHub trigger". Then the bit asks in its chat:

> Use Claude for this run? Up to $2.00.

- **Approve this run.** Claude leads until the run ends or reaches the run cap.
- **Approve for today.** Every run until local midnight, within the bit's daily cap.
- **Decline.** This run uses the bit's own compute.

The bit shows **Needs approval**, like a tool approval, in the app, on the web and on the phone.
Only the bit's owner can answer: from the app, or from the web (`approve_frontier` and
`decline_frontier` commands). With no answer in 30 minutes, the run goes on without the key. While
the bit waits, the run is paused, so nothing is spent.

**Caps.** Each bit has a run cap (default $2) and a daily cap (default $5). The key's own daily cap
still applies to everything. When a run reaches its run cap, the key stops and the bit asks again,
with the same three choices. The run waits for the answer. The bit's daily cap and the key's daily
cap don't ask: the run carries on with the bit's own compute.

**Lead and worker.** Claude leads: it plans and makes the tool calls. The bit's compute policy is
the worker: it runs compaction summaries, and every call once the key is off.

**Auto.** With **Use my frontier key for Auto** on, a bit on Auto whose switch is off may use the
key for high-complexity steps, judged by the same estimate as sessions. These steps go through the
same checks, approval and caps.

**Spend.** It is logged under `bot:<id>` in `frontier-usage.json`. The bit's view shows today's
dollars next to its cSats ("Claude Opus 5.5 · $0.42 of $5.00 today"), and each run records its
own estimate.

## Where the key is stored

| OS | Store | How EdgeCoder talks to it |
| --- | --- | --- |
| macOS | login keychain, service `edgecoder-frontier` | `/usr/bin/security`. The secret goes on stdin (`security -i`), never in a command line that `ps` could show. |
| Linux | Secret Service (GNOME Keyring, KWallet) | `secret-tool store`, which reads the secret from stdin. |
| Windows | Credential Locker | PowerShell's `PasswordVault`. The script, secret included, goes on stdin. |
| none of the above, or `EDGECODER_FRONTIER_KEYCHAIN=off` | `~/.edgecoder/frontier-keys.json` (mode 0600) | Settings and `edgecoder keys list` say so. |

On Linux without an unlocked keyring (a headless server), saving fails with a clear message. Set
`EDGECODER_FRONTIER_KEYCHAIN=off` there to use the file.

`~/.edgecoder/frontier.json` keeps everything except the key itself:

- which providers have a key, and for which account;
- base URLs, the default lead and the worker;
- caps, effort and your price table.

Spend goes to `frontier-usage.json` next to it. Both files are 0600.

The key is never:

- sent to EdgeCoder's coordinators, the portal or any network host. Calls go from the IDE provider
  on your computer straight to the provider's HTTPS API (`api.anthropic.com`, or your base URL,
  which must be https, or http only on this computer);
- in logs. Log lines and error reports mask `sk-ant-…`, `sk-…`, `gsk_…` and `xai-…`;
- in events, responses or session files. A session stores only `frontier/anthropic/<model>`, and
  a key pasted into a message is replaced with `[redacted]` before the model or the disk sees it;
- in a command line. `edgecoder keys add` reads it hidden, or from `--key-file` or `--key-env`.

The settings routes (`/v1/ide/frontier/*`) are on the IDE provider like the rest of its API.
They are loopback only and need the IDE token.

## Models and ids

| Id | Model |
| --- | --- |
| `frontier/anthropic/claude-opus-5-5` | Claude Opus 5.5 (the default lead) |
| `frontier/anthropic/claude-fable-5-1` | Claude Fable 5.1 (most capable, higher price) |
| `frontier/anthropic/claude-sonnet-5-5` | Claude Sonnet 5.5 |
| `frontier/anthropic/claude-haiku-5-5` | Claude Haiku 5.5 |
| `frontier/<provider>/<model>` | An OpenAI-compatible provider you named, such as `frontier/openai/gpt-5` or `frontier/openrouter/<vendor>/<model>`. |

The provider's `/v1/models` lists these ids only when your account has a key for that provider on
this computer. The same ids work with the provider's OpenAI and Anthropic endpoints
(`/v1/chat/completions`, `/v1/messages`), so your editor can use them too.

How the Anthropic calls are made:

- Streaming Messages API, with native tool use.
- Adaptive thinking, which is always on for current models. Thinking blocks are passed back
  unchanged within a turn's tool loop.
- `output_config.effort`: `high` by default, set with `edgecoder keys set --effort`.
- Automatic prompt caching, since the agent resends the conversation every step.
- The server-side refusal fallback (`fallbacks: "default"`) on Opus 5.5, Fable 5.1, Opus 5 and
  Sonnet 5.5. A declined request is retried on the model Anthropic recommends for that case, and
  priced at that model's rate.
- Sampling parameters (`temperature`) are never sent, because current models reject them.
- A reply cut off by the output limit, or a refusal, never runs its tool calls.

Retries, for both providers:

- 429, 5xx, 529 and `overloaded` are retried up to 4 times, with exponential backoff and
  `Retry-After`, but only before any output has streamed.
- A rejected key (401/403) is not retried. It gives one clear message, which never contains the
  key.

## Spend and caps

Each call's cost is estimated from the token counts the provider reports and a price table, in
USD per million tokens:

| Model | Input | Output | Cache read |
| --- | --- | --- | --- |
| Claude Opus 5.5 | $4 | $20 | $0.20 |
| Claude Fable 5.1 | $10 | $50 | $0.25 |
| Claude Sonnet 5.5 | $2 | $10 | $0.20 |
| Claude Haiku 5.5 | $0.10 | $0.50 | $0.01 |

Cache writes cost 1.25x input. For models not in the table, the estimate uses a deliberately high
$10 / $50, so the caps stop early rather than late. Set real prices with the `prices` setting:

```sh
curl -s -X POST -H "authorization: Bearer $(cat ~/.edgecoder/ide-token)" -H 'content-type: application/json' \
  http://127.0.0.1:4304/v1/ide/frontier/settings -d '{"prices":{"openai/gpt-5":{"input":1.25,"output":10}}}'
```

- **Per-session cap** (default $5) and **daily cap** (default $25, by local date). Use `none` for
  no cap.
- At **80%** of either cap, the session gets a warning, once.
- At **100%**, frontier calls are refused before anything is sent. The turn ends with the reason.
  Raise the cap, or switch the lead to Auto.
- Spend shows in each turn's where-it-ran line, the same shape as a network call's
  (`Anthropic · claude-opus-5-5 · your key · read 24.8k tok · wrote 312 tok · $0.42`), in the
  Code view
  ("Claude Opus 5.5 · your key · $0.42 this session"), in `/cost`, and in
  `edgecoder keys list` (today and the last 30 days). The provider's own bill is the authority.
  These are estimates.

## Lead and worker

A session has a **lead** (its `model`) and a **worker** (`workerModel`, default `auto`).

- The lead runs the main agent loop.
- The worker runs cheap helper calls, such as summaries and compaction, and whatever a future
  `delegate` tool spawns. It can never be a frontier model.
- `TurnEnv.chat(s, emit, signal, { role: "lead" | "worker", client })` in `sessions.ts` is where
  that split is made. `workerModelOf(s)` gives the worker id.
- Compaction keeps a long session inside the model's context window (1M tokens for Anthropic's
  current models). Its summary call runs on the worker, never on your key. To run it on the
  frontier lead instead, turn on `compactWithLead`, with
  `POST /v1/ide/frontier/settings {"compactWithLead": true}`. It is off by default, and even then
  it applies only to your own turns.

**Auto and your key.** By default Auto never touches your key. With **Use my frontier key for
Auto** on (`edgecoder keys set --auto on`), Auto sends high-complexity jobs to your default lead,
judged by the same complexity estimate the network uses. It does this only when your account may
use the key. Everything else stays on Auto.

## `edgecoder keys`

```sh
edgecoder keys add anthropic                                         # asks for the key (hidden)
edgecoder keys add openai --key-file ~/openai.key
edgecoder keys add openrouter --base-url https://openrouter.ai/api/v1 --key-env OPENROUTER_API_KEY
edgecoder keys list                                                  # keys, account, settings, spend (never the key)
edgecoder keys test anthropic
edgecoder keys set --lead frontier/anthropic/claude-opus-5-5 --worker auto --session-cap 5 --daily-cap 25 --auto off
edgecoder keys remove anthropic                                      # --account acct-… removes another account's key
```

`edgecoder keys` uses the EdgeCoder app's provider when it is running, or starts one in the
process, like `edgecoder code`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `EDGECODER_FRONTIER_FILE` | `~/.edgecoder/frontier.json` | Providers, account binding and settings (no keys). |
| `EDGECODER_FRONTIER_KEYCHAIN` | `auto` | `off` uses the 0600 file instead of the OS store. |
| `EDGECODER_SECURITY_BIN`, `EDGECODER_SECRET_TOOL_BIN`, `EDGECODER_POWERSHELL_BIN` | the system tool | The credential-store tools, for tests and unusual installs. |

The Windows Credential Locker path is written to the PowerShell `PasswordVault` API, but it has not
yet been run on Windows in CI. The macOS and file paths are covered by tests, using a fake
`security` tool.
