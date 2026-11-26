# Tentacles: helper agents for the lead

A coding session's **lead** agent runs on the strongest model you have: your own frontier key
(BYOK, #323, for your own requests only) or the best network model. With tentacles on, the lead can spin off
**helper agents ("tentacles")** onto cheaper models: easy pieces on the model on this computer
(free), medium ones on the EdgeCoder network. Each one works in parallel on a scoped piece of
work: tests for a function, a contained edit, a search, a summary. It then hands its result back
to the lead as a patch.

Helpers run on this computer's own model or on network models (the session's worker model, or
`auto`), never on a frontier model and never with your frontier key, whoever the lead is.

The lead keeps planning and integration. Tentacles do the well-specified pieces.

## Using it

### Terminal

```sh
edgecoder code --lead network/qwen3-coder:480b@gpu.dc --worker auto --tentacles 4
edgecoder code --tentacles 2 --tentacle-budget 40            # lead on auto, 2 helpers at once
```

| Flag | Meaning |
| --- | --- |
| `--lead <id>` | The lead's model, e.g. `frontier/anthropic/claude-opus-5-5` on your own key (#323). |
| `--worker <id>` | The session's worker model: tentacles run on it. The default, `auto`, picks the best fit per piece (see Routing). Never a frontier model. |
| `--tentacles <n>` | How many helpers may run at once (`0` turns them off). |
| `--tentacle-budget <cSats>` | What all of the session's tentacles may spend together. |

In the session:

| Command | What it does |
| --- | --- |
| `/tentacles` | Shows the live tree, one status line per tentacle. |
| `/tentacles cancel <id>` | Stops a tentacle. |
| `/tentacles apply <id>` | Merges a passed patch that is waiting for approval. |
| `/tentacles drop <id>` | Drops a passed patch that is waiting for approval. |
| `/tentacles on` / `/tentacles off` | Turns delegation on or off. |
| `/tentacles max <n>` | Sets how many may run at once. |
| `/tentacles budget <cSats>` | Sets the session's tentacle budget. |
| `/tentacles worker <model>` | Sets the tentacles' worker model when the session's is `auto` (never a frontier model). |

The terminal prints a line as each tentacle starts, begins running, finishes, or is merged:

```
  ⟡ tentacle t3fa91c2: Write tests for parseFileRef (tests)
  ⟡ t3fa91c2 running on auto
    ↳ t3fa91c2 · qwen3-coder:30b · network gpu · lin-•••3f2a Chicago · 4.2k in / 310 out tok · 1.6 cSats
    ↳ t3fa91c2 · qwen3-coder:30b · network gpu · lin-•••3f2a Chicago · 5.0k in / 120 out tok · 1.5 cSats
  ⟡ t3fa91c2 passed · applied · Write tests for parseFileRef · qwen3-coder:30b on gpu · 3.1 cSats
  ⟡ tentacle t81c0d4e: Find where parseFileRef is called (search)
    ↳ t81c0d4e · qwen3.5:9b · this computer · 2.1k in / 140 out tok · 0.0 cSats
  ⟡ t81c0d4e passed · Find where parseFileRef is called · qwen3.5:9b on this computer · 0.0 cSats
  ⟡ helpers merged: 2 helpers · 3 calls · qwen3-coder:30b, qwen3.5:9b · 11.3k in / 570 out tok · 3.1 cSats · 1/1 patch back
```

Each `↳` line is one helper model call: model · where it ran (`this computer`, or `network`
and the class) · host and region · tokens · cSats. `/tentacles` shows them under each tentacle,
with the session's total. Over the hosted endpoint (an API key, no enrolled agent) the class,
host and region come from the reply's `edgecoder.served` field (#525); before, those calls read
`unknown`.

The totals end with the **patch-return rate**: how many finished helpers that write (not
read-only, not review) came back with a patch, e.g. `3/8 patches back`. `GET …/tentacles` returns it
as `patches: {asked, returned, rate}`.

Not on a terminal (stdin or stdout piped, a headless or remote run), the approval prompt line is
never redrawn. The terminal then prints each approval as its own line (`Approval needed: allow …?
Answer y, n or a on stdin, or in the EdgeCoder app`) and shows the session live in the app (remote
on), so the pending call reaches the desktop and web through the normal session events and can
be answered there. An approval nobody answers is refused after 30 minutes.

`/undo` undoes the last change, whether a turn or an applied tentacle. Each applied tentacle is
its own checkpoint.

### Desktop

The Code view has a **Helpers** button next to the model picker and the permission mode. It
opens a switch and two numbers:

| Control | Default | Meaning |
| --- | --- | --- |
| Helpers on/off | On when the chat's model is a frontier model on your own key, off otherwise | Whether the lead gets the `delegate` tools in this chat. |
| At once | 4 | How many helpers run in parallel (1–16). |
| Budget for this chat | 100 cSats | What all of the chat's helpers may spend together. Helpers on this computer are free. |

Each chat keeps its own setting. Turning the switch on or off is remembered for that chat
whatever model you pick later; until you touch it, the default rule applies (so switching the
chat's model to Claude turns helpers on). New chats follow **Settings → General → Helpers**:
"Turn helpers on for new chats" (*With your frontier key*, *Always* or *Off*), and the default
"at once" and budget. Helpers are not offered in Plan mode.

While the lead works, the chat shows the helpers above the message box: one row per helper with
its status, where it ran and what it cost, and each model call's served line (`this computer ·
qwen3.5:9b · …` or `network · qwen3-coder:30b · GPU · Chicago · …`). Expand a row for the
summary and patch. **×** cancels a running helper; **Merge** and **Drop** answer a passed patch
that waits for approval (mode Manual). Stopping the reply stops the chat's helpers.

The app sends the setting with each message (`helpers` on `POST /v1/ide/chat`, below); the chat's
id is the helpers' session id, so the budget and finished results last across its turns.

The Live session panel (a session published with `/remote`) shows the same tree above the
conversation, each helper call's served line under its row, and the merged totals at the bottom.
Expand a row to see the tentacle's summary and patch. Any attached client can:

- **×** cancels a running tentacle.
- **Merge** and **Drop** answer a passed patch that is waiting for approval.

### Turning it on elsewhere

| Setting | Effect |
| --- | --- |
| `EDGECODER_TENTACLES=1` | Turns tentacles on for every session on the provider. |
| `EDGECODER_TENTACLES_MAX` | Default parallel cap (4). |
| `EDGECODER_TENTACLES_BUDGET_CSATS` | Default session budget (100). |
| `EDGECODER_TENTACLE_CSATS` | Default per-tentacle budget (25). |
| `EDGECODER_TENTACLES_WORKER` | Default worker model (`auto`). |
| `EDGECODER_TENTACLES_LOCAL` | `0` turns local first off (see Routing); on by default. |
| `EDGECODER_TENTACLES_LOCAL_MIN_B` | The smallest model on this computer (billions of parameters) a helper may run on first (7). |
| `EDGECODER_TENTACLE_CONTEXT_CHARS` | How many characters of files a tentacle's prompt may carry (36,000; about 12K tokens). |

Over HTTP, on the IDE provider (same token rules as the session routes; any attached client):

```
GET  /v1/ide/sessions/:id/tentacles                {config, spentCSats, tentacles}
POST /v1/ide/sessions/:id/tentacles/config         {enabled?, maxParallel?, budgetCSats?, perTentacleCSats?, workerModel?, localFirst?}
POST /v1/ide/sessions/:id/tentacles/:tid/cancel
POST /v1/ide/sessions/:id/tentacles/:tid/merge     {approved}
```

The desktop Code view's chats are not sessions. A chat turns helpers on per message:

```
POST /v1/ide/chat   {..., helpers: {sessionId, enabled, maxParallel?, budgetCSats?}}
```

`sessionId` is the chat's id (a UUID; never an existing session's). The turn's event stream then
carries the `tentacle_*` events below, and the routes above accept the chat's id (IDE token only;
a chat has no controlling client).

## What the lead sees

With tentacles on, the lead gets three tools and a short section in its system prompt. The prompt
says to delegate independent, well-specified pieces and to keep planning and integration itself.

```
delegate({ task, kind, files[], instructions, acceptance?, complexity?, budgetCSats?, readOnly? })
  → { id, status: "queued" }                       returns at once
await_tentacles({ ids?, timeoutS? })
  → { finished: [...], stillRunning: [...], timedOut? }
cancel_tentacle({ id })
```

The `delegate` arguments:

- `kind` is one of `tests`, `code_edit`, `search`, `summarize`, `docs`, `review`, `refactor_piece`.
- `files` are project paths, or ranges as `path#L10-L40`.
- `acceptance` is one of:
  - `{kind: "vitest", args: ["tests/x.test.ts"]}`
  - `{kind: "tsc", args: {project: "tsconfig.json"}}`
  - `{kind: "grep", args: {pattern, paths?, absent?}}`
  - `{kind: "none"}`

`await_tentacles` returns as soon as at least one awaited tentacle has finished, with every
finished one the lead has not seen yet. Call it again for the rest. Each finished tentacle comes
back with:

- its status and merge state;
- the helper's summary and the files it touched;
- its checks, with the output of any that failed;
- where it ran and what it cost.

If the patch was **not** merged, the result also includes the patch itself. The lead then decides:
re-delegate, fix it itself, or drop it. Tentacles that finished between turns are listed in the
lead's next system prompt.

## Design

```
lead turn (sessions.ts / agent-loop.ts)
  └─ delegate ─► TentacleManager (tentacles.ts) ── queue, parallel cap, budgets
                   └─ tentacle
                        ├─ workspace: git worktree in $TMPDIR (tentacle-workspace.ts)
                        │    HEAD + the lead's uncommitted changes + untracked files, committed as a baseline
                        ├─ its own agent loop (runAgentLoop) on the worker model, fresh small context
                        │    tools: read_file, list_directory, search_files, write_file, edit_file,
                        │           git_diff, git_status, run_shell (allowlist), all inside the worktree
                        ├─ acceptance check in the worktree, niced
                        ├─ escalate once on failure (quality best, complexity +1)
                        └─ patch = git diff against the baseline
                 merge back: git apply --check against the lead's tree
                   clean + passed + edits may apply on their own → applied as its own checkpoint (undoable)
                   clean + passed, edits ask                     → waits for approval (terminal / desktop)
                   conflict or failed                            → reported to the lead with patch and errors
```

### Isolation

A tentacle that changes files works in a detached `git worktree` of the lead's repository, in a
temporary folder. The worktree starts from what the lead has now: HEAD, plus the lead's
uncommitted changes, plus its untracked files (up to 200 files and 5 MB). That state is committed
there as a baseline.

The tentacle's tools are rooted in the worktree. The executor refuses paths that escape it,
including absolute paths into the lead's tree. Its `run_shell` accepts only:

- tests: `npx vitest run`, `npm test`
- type checks and linting: `npx tsc --noEmit`, `npm run typecheck`, `npm run lint`
- reads: `git diff`, `git status`, `ls`, `cat`, `grep`, `rg`, `head`, `tail`, `wc`

Commands must be plain argv, without shell syntax and without paths outside the worktree, and they
run under `nice`.

The lead's `node_modules` is linked into the worktree so that checks run without an install; it is
never part of a patch.

Read-only work (`search`, `summarize`, or `readOnly: true`) gets no workspace. It reads the lead's
tree with read tools only, and its result is the summary.

The worktree is removed when the tentacle finishes. If the provider is killed mid-run, it leaves
the folder in `$TMPDIR` behind; `git worktree prune` cleans up the reference.

### Context

A tentacle starts fresh. Its first message holds only:

- the task;
- the instructions;
- the acceptance check;
- the given files or line ranges, cut to `EDGECODER_TENTACLE_CONTEXT_CHARS`.

That keeps it within the 8K–16K windows of cheap models. It can still `read_file` more if it
needs to.

### Routing

With the worker model set to `auto`, where a tentacle runs depends on its complexity (below):

| Complexity | First attempt | Retry (one level up) |
| --- | --- | --- |
| Low (search, summarize and docs by default, when small) | **This computer's model**, when one can take it; otherwise the network | The network |
| Medium and higher | The network | The network |

**Local first.** A low-complexity helper's first attempt runs on a model installed on this
computer (Ollama) when one can take it, at no cost:

- it calls tools (Ollama's capabilities, the same check Auto uses; `deepseek-r1` only writes plans);
- it is at least `EDGECODER_TENTACLES_LOCAL_MIN_B` big (7B by default; like bots' 14B floor, but
  lower because only easy pieces run here);
- its context window, when the catalog knows it, holds the helper's `minContext` (below).

Among those, Auto's fit for agent work picks the model (coders around 14B first). The list of
installed models and their tool support is Auto's own (`routeInputsHere`, refreshed every 15 s).

If no local model fits, the attempt goes to the network as before. If the local attempt fails
(its check fails, it changes nothing, or the model call fails), the retry goes to the network one
level up, like any escalation. `EDGECODER_TENTACLES_LOCAL=0`, or `localFirst: false` in the
tentacle settings, turns local first off.

Every network call goes to the coordinator's best-fit routing (`model: "auto"`, #311). The call
carries job hints derived from the delegate arguments:

| Hint | Value |
| --- | --- |
| `job` | From `kind`: tests→`tests`, code_edit→`code_edit`, docs→`code_edit`, refactor_piece→`refactor`, review→`code_review`, search→`extract`, summarize→`summarize`. |
| `complexity` | A score from 0 to 1: the given level, or a default per kind (low for search, summarize and docs; medium otherwise), moved by the prompt's size, the number of files and whether a test or tsc check must pass, and one level up on the retry. Small, simple helpers score low and land on small models; bigger ones graduate up. |
| `quality` | `fast` for low complexity, `balanced` otherwise, `best` on the retry. |
| `latency` | `batch`. |
| `needsTools` | `true`. |
| `minContext` | The prompt plus room for tool round trips, 8K–32K. |
| `maxCSats` | The call's price ceiling (see Reserves below): what is left of the tentacle's budget, within what is left of the session's after the other helper calls in flight. |
| session id | `tentacle:<id>`, so session affinity keeps one tentacle's calls on one machine. |

The coordinator picks the model, class and machine. The tentacle reports where it ran as
`model on class` (`qwen3.5:9b on this computer` for a local run) and the agent label. Each call
carries `place` (`local` or `network`), shown first in its served line.

How a call reaches the coordinator:

- Through this machine's agent when it is enrolled.
- Otherwise through the hosted endpoint, with the hints in the request body's `edgecoder` field.
- Otherwise through Auto on this computer.

An explicit worker model (`network/<m>[@class]`, `mine/<m>`, or a local tag) runs exactly there.
A named model's call still carries `maxCSats` as its price ceiling, on every path: through the
hosted endpoint the portal forwards it to the coordinator (`namedModelCeiling` in
`inference-api/backends.ts`), which caps the call's reserve at it.

#### Reserves

The coordinator sets aside an upper bound on each call's cost before it runs (the model's token
price for the input and reply cap, or the class's power floor for the call's timeout, × 1.5),
capped at the call's `maxCSats`. Before #525 the hosted path dropped `maxCSats` for named models,
so a `network/qwen2.5-coder:1.5b` helper call set aside 53.6 cSats on a 25 cSat tentacle budget,
and four helpers at once used up a 250 cSat account while spending about 9.

Each paid helper call (worker `auto` or `network/…`) now sizes its ceiling
(`tentacle-reserve.ts`) as the smaller of:

- what is left of the tentacle's budget, and
- what is left of the session's tentacle budget after the ceilings of the session's other helper
  calls in flight (their reserves are held on the account at the same time).

So the helpers' reserves together never exceed the session's tentacle budget. A call also asks
for at most 4096 reply tokens (`EDGECODER_TENTACLE_MAX_TOKENS`, 256–32768), which keeps the
token bound small, and the reply is cut so the prompt and the reply fit the smallest context
window that holds the prompt (8192 tokens for a helper prompt of up to about 6900 tokens; at least
1024 reply tokens). Most network hosts serve an 8192-token window: an 8192-token reply did not fit
any of them, so every helper call waited for the few hosts with a larger window. The call's
`minContext` hint is that same window. A call the coordinator refuses as too long for every
host's window is sent once more with a 1024-token reply. A call whose ceiling is under 0.05 cSats doesn't start: it waits while other
helpers' calls hold the session's budget, and otherwise the tentacle stops with an error that says
which budget is short. A call the network refuses for its ceiling (`no_route_fits`, reason `price`,
with what the cheapest fitting model needs) waits the same way for room for that much, when the
tentacle's own budget covers it. The hosted endpoint sends that refusal as data too (`edgecoder` in
the error: `code`, `reason`, `neededCSats`, `computeClass`), so helpers of `edgecoder code` with an
API key wait as well; in network run 13 they got only the message and the last helper failed while
the other helpers' calls held the budget. Calls on this computer, your machines or a lease hold nothing.

None of these paths can use your frontier key. A frontier id as the worker becomes `auto`, the
tentacle settings refuse one, a frontier id is never chosen as the local model, and a call
answered by a frontier model stops the tentacle with an error. A frontier lead serves only its owner's own requests (#323); a turn started by another
account's message leads on the worker model and can still delegate.

### Permissions

Tentacles follow the session's permission mode (#321) and never go past it. They can't ask, so
whatever the mode would ask about is refused or waits for you:

- **Shell:** the shared classifier (`permissions.ts`) decides. Risky commands never run. Read-only
  commands run in any mode. Anything else must be on the tentacle allowlist (tests, type checks,
  lint) and be something the session runs without asking: mode `auto`, or a command name you
  answered "always". `npx` runs with `--no-install`.
- **Acceptance checks:** a grep always runs. A vitest or tsc check runs the project's code, so it
  follows the same rule; otherwise the patch comes back marked unverified and waits for approval.
- **Merging the patch:** the same rule as the lead's own edits. In `auto-edits` and `auto` a clean
  patch applies on its own unless it touches a protected path; in `ask` it waits for approval.

### Escalation

When a tentacle fails, it gets one more attempt on a stronger tier: complexity one level up and
quality `best`. Failure means any of these:

- its check failed;
- it changed nothing on a kind that should change files;
- it came back empty: no reply and no change, or the machine reported `empty_reply`;
- its model call failed.

The workspace goes back to the baseline first, and the second attempt's prompt includes the first
attempt's failure. If that also fails, the tentacle reports `failed` (or `error`).

An explicit worker model keeps the same model on the retry, so nothing is spent on a place you
didn't choose. With `auto`, a first attempt that ran on this computer is retried on the network
(the progress says "retrying on the network"). A tentacle that ran out of budget is not retried.

An attempt that came back empty (#525: 0 of 16 patches came back from `qwen2.5-coder:1.5b`
workers) is retried like this:

- `auto`: one tier up, as above.
- An explicit network worker under the helper floor (7B, `EDGECODER_TENTACLES_MIN_B`) never
  gets here: its helpers run on `auto` with the floor from the first attempt, and the session warns
  once ("small models often return nothing for helper work, so helpers run on auto").
  `EDGECODER_TENTACLES_MIN_B=0` keeps the explicit model (no floor).
- Any other explicit worker: the same model with a fresh session key, so affinity doesn't send it
  back to the machine that returned nothing.

The helper's system prompt also tells it that only `edit_file` or `write_file` change files and
code pasted into a reply changes nothing, and the retry's prompt says the first attempt was empty.

### Merge back

When a tentacle passes and its patch applies cleanly (`git apply --check` against the lead's
working tree), what happens depends on the session's permission mode:

- **`auto-edits` or `auto`**, no protected path, and the check ran: the patch is applied at once,
  as its own checkpoint. `/undo` reverts it like a turn.
- **Otherwise:** it waits with merge state `awaiting_approval` until you merge or drop it. Merging
  checks the patch again first.

Patches are applied to the working tree, not the index, and nothing is committed.

A patch that no longer applies (`conflict`), or a failed tentacle (`not_applied`), goes back to the
lead with the patch and the errors.

Every finished tentacle is recorded in the transcript as a note. The note is collapsible in
clients, carries the patch and summary, and is never sent to the model:

```
Tentacle: Write tests for parseFileRef · qwen3-coder:30b on gpu · passed (applied) · 3.1 cSats
```

### Limits and cost

| Limit | Default | What happens |
| --- | --- | --- |
| Running at once per session | 4 | More wait in a queue (at most 32 waiting). A helper also starts only when the session's budget, less what the running helpers may still spend, covers its own budget; a helper that finishes under budget gives the rest back. With nothing running and less than 4 cSats left, the queued helpers stop with one message ("budget is spent … after N of M helpers; raise --tentacle-budget") (network run 15). |
| Session budget | 100 cSats | `delegate` is refused once it is spent. When the helpers not finished could need more than is left (at each helper's own budget, or at the session's average once some finished), `delegate`'s note says how many it covers, for the lead to tell the user. |
| Per tentacle | 25 cSats | The tentacle stops when it is reached. Can be set lower per `delegate` call. No call sets aside more than what is left of it. A helper that stops at a budget with a patch has it checked like a finished one: it merges when its check passes (or it has none), and otherwise waits for approval; it is never dropped (network run 14). |
| Account balance | | A call refused because the balance can't cover its reserve (402) waits for the other helpers' calls to end, and the session runs fewer helpers at once; a helper alone halves its ceiling until the reserve fits, then stops saying the balance is too low. `delegate`'s note counts the balance as well as the session's budget, and its coverage sentence comes first ("Balance covers ~3 of 8 helpers."). |
| Agent steps per attempt | 12 | |
| Busy network | 3 retries | A call refused because every machine that fits is busy (503 `no_capacity`) is sent again after 2 s, 4 s and 8 s, its ceiling sized again each time, then the helper fails saying it was tried (network run 15). |

Calls on this computer or your own machines cost 0 cSats and never trip a budget. Tentacle spend
counts toward the session's total (`/cost`).

Stopping a turn (Ctrl+C, the desktop's stop button), deleting the session, or shutting down the
provider cancels the session's tentacles.

### Events

Session events, through the existing stream (`GET /v1/ide/sessions/:id/events`):

| Event | Payload |
| --- | --- |
| `tentacle_started` | `{tentacle}` (queued) |
| `tentacle_progress` | `{id, status, progress, cSats, model?}`, sent at each step and check |
| `tentacle_usage` | `{id, call, line, cSats, spentCSats}`, one per helper model call: `call` has the model, cSats, tokens and `served` (where it ran); `line` is its served line |
| `tentacle_totals` | `{ids, totals, session}`, when await_tentacles hands results to the lead: the batch's and the session's totals (`line`, calls, models, tokens, cSats, `patches`) |
| `tentacle_finished` | `{tentacle}`, with its result and merge state |
| `tentacle_merge` | `{id, merge, tentacle}`, when an approval is answered |
| `tentacle_config` | `{config, spentCSats}` |
| `note` | `{entry}`, the transcript note |

## Context graduation

As a lead's conversation grows, `chooseLeadModel` (`lead-model.ts`) moves the lead, for that turn,
to a model with a larger window instead of letting it lose the start of the conversation:

- A frontier lead is left alone (it has the largest window). Graduation never moves a lead onto a
  frontier model, since that would spend the key for whoever sent the message.
- Otherwise, it moves to the smallest-window network candidate that fits within 75% of its
  window, cheapest first.

It is wired where each turn's model is chosen (`provider-server.ts`, the sessions' `chat`), behind
these settings:

| Setting | Meaning |
| --- | --- |
| `EDGECODER_CONTEXT_GRADUATION=1` | Turns graduation on. |
| `EDGECODER_LEAD_CANDIDATES="network/qwen3-coder:30b=32768,network/big:70b@gpu=131072"` | The candidate models and their windows. |

A session on `auto` is left alone, because Auto sizes each call itself.

## Where it plugs in

The tentacle code lives in its own files:

- `src/apps/ide/tentacles.ts`
- `src/apps/ide/tentacle-chat.ts` (the helper's ChatFn, prompts, local model pick, empty-attempt retry)
- `src/apps/ide/tentacle-reserve.ts` (per-call price ceilings)
- `src/apps/ide/tentacle-shell.ts` (the shell allowlist and the session's mode, as a helper sees them)
- `src/apps/ide/tentacle-format.ts`
- `src/apps/ide/tentacle-workspace.ts`
- `src/apps/ide/delegate.ts`
- `src/apps/ide/tentacle-routes.ts`
- `src/apps/ide/lead-model.ts`
- `src/terminal/tentacles.ts`
- `desktop/src/lib/tentacles.ts`
- `desktop/src/lib/helpers.ts` (the Code view's switch and its default rule)
- `desktop/src/components/TentacleTree.svelte`
- `desktop/src/components/HelpersPicker.svelte`, `HelpersSettings.svelte`

Existing files get thin, marked hooks:

| File | Hook |
| --- | --- |
| `sessions.ts` | `TurnEnv.onSessionStop` (called from `cancel`, `remove` and `shutdown`); `SessionHub.peek`, `publishEvent` and `recordNote`; `undo` also accepts notes; `TranscriptEntry.tentacle`. |
| `tool-types.ts` | Three tool names and `TENTACLE_TOOLS`, included in `READ_TOOLS` so they don't ask. `bots.ts` filters them out of bot defaults; `tool-executor.ts` has a refusing `case` for them. |
| `provider-server.ts` | Builds the `TentacleManager` with `tentacleWorkerBackend` (the worker role: `workerModelOf`, never frontier), `localModelFor` / `localBackend` (local first: `pickLocalHelperModel` over `routeInputsHere`) and `shellAllowed` (`SessionHub.allowedWithoutAsking`); wraps the session `executor`, `tools` and `systemPrompt`; registers the routes; context graduation for network leads in `chat`. `/v1/ide/chat` takes `helpers` for Code view chats (`chatHelpers`: the tentacle host's view of a chat, its events into the turn's stream). |
| `hosted-backend.ts` | Forwards `req.hints` as the body's `edgecoder` field; reads `edgecoder.where` and `edgecoder.served` from the reply. |
| `inference-api/openai.ts`, `anthropic.ts` | The reply's `edgecoder` field carries `served` (`edgecoderUsage`). |
| `inference-api/backends.ts` | `networkBackend` sends a named model's `maxCSats` as its price ceiling. |
| `src/terminal/repl.ts` | Hands `tentacle_*` events and `/tentacles` to `TentacleTracker`; off a terminal, prints approvals as lines and turns remote on (`surfaceApproval`). |
| `src/terminal/cli.ts` | `--tentacles` and `--tentacle-budget`; posts the config after the session is created. |
| `LiveSessionPanel.svelte` | Loads and folds the tree, and renders `<TentacleTree>`. |
| `EditorChatPanel.svelte` | The Helpers button beside the pickers; sends `helpers` with each message; folds the turn's `tentacle_*` events into `<TentacleTree>`. |
| `Settings.svelte` | `<HelpersSettings>` under General. |
| `desktop/src/lib/api.ts` | Three calls. |
