# Tentacles: helper agents for the lead

A coding session's **lead** agent runs on the strongest model you have: your own frontier key
(BYOK, when it lands) or the best network model. With tentacles on, the lead can spin off
**helper agents ("tentacles")** onto the EdgeCoder network's cheaper, slower models. Each one works
in parallel on a scoped piece of work: tests for a function, a contained edit, a search, a summary.
It then hands its result back to the lead as a patch.

The lead keeps planning and integration. Tentacles do the well-specified pieces.

## Using it

### Terminal

```sh
edgecoder code --lead network/qwen3-coder:480b@gpu.dc --worker auto --tentacles 4
edgecoder code --tentacles 2 --tentacle-budget 40            # lead on auto, 2 helpers at once
```

| Flag | Meaning |
| --- | --- |
| `--lead <id>` | The lead's model. Until the lead/worker split lands, this is the same as `--model`. |
| `--worker <id>` | The model the tentacles run on. The default, `auto`, picks the best fit per piece (see Routing). |
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
| `/tentacles worker <model>` | Sets the worker model. |

The terminal prints a line as each tentacle starts, begins running, finishes, or is merged:

```
  ⟡ tentacle t3fa91c2: Write tests for parseFileRef (tests)
  ⟡ t3fa91c2 running on auto
  ⟡ t3fa91c2 passed · applied · Write tests for parseFileRef · qwen3-coder:30b on gpu · 3.10 cSats
```

`/undo` undoes the last change, whether a turn or an applied tentacle. Each applied tentacle is
its own checkpoint.

### Desktop

The Live session panel (Code view, a session published with `/remote`) shows the same tree above
the conversation. Expand a row to see the tentacle's summary and patch. While you are in control:

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
| `EDGECODER_TENTACLE_CONTEXT_CHARS` | How many characters of files a tentacle's prompt may carry (36,000; about 12K tokens). |

Over HTTP, on the IDE provider (same token and control rules as the session routes):

```
GET  /v1/ide/sessions/:id/tentacles                {config, spentCSats, tentacles}
POST /v1/ide/sessions/:id/tentacles/config         {enabled?, maxParallel?, budgetCSats?, perTentacleCSats?, workerModel?}
POST /v1/ide/sessions/:id/tentacles/:tid/cancel
POST /v1/ide/sessions/:id/tentacles/:tid/merge     {approved}
```

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

With the worker model set to `auto`, every call a tentacle makes goes to the coordinator's
best-fit routing (`model: "auto"`, #311). The call carries job hints derived from the delegate
arguments:

| Hint | Value |
| --- | --- |
| `job` | From `kind`: tests→`tests`, code_edit→`code_edit`, docs→`code_edit`, refactor_piece→`refactor`, review→`code_review`, search→`extract`, summarize→`summarize`. |
| `complexity` | The given one, or a default per kind (low for search, summarize and docs; medium otherwise). |
| `quality` | `fast` for low complexity, `balanced` otherwise, `best` on the retry. |
| `latency` | `batch`. |
| `needsTools` | `true`. |
| `minContext` | The prompt plus room for tool round trips, 8K–32K. |
| `maxCSats` | What is left of the tentacle's budget. |
| session id | `tentacle:<id>`, so session affinity keeps one tentacle's calls on one machine. |

The coordinator picks the model, class and machine. The tentacle reports where it ran as
`model on class` and the agent label.

How a call reaches the coordinator:

- Through this machine's agent when it is enrolled.
- Otherwise through the hosted endpoint, with the hints in the request body's `edgecoder` field.
- Otherwise through Auto on this computer.

An explicit worker model (`network/<m>[@class]`, `mine/<m>`, or a local tag) runs exactly there.

### Escalation

When a tentacle fails, it gets one more attempt on a stronger tier: complexity one level up and
quality `best`. Failure means any of these:

- its check failed;
- it changed nothing on a kind that should change files;
- its model call failed.

The workspace goes back to the baseline first, and the second attempt's prompt includes the first
attempt's failure. If that also fails, the tentacle reports `failed` (or `error`).

An explicit worker model keeps the same model on the retry, so nothing is spent on a place you
didn't choose. A tentacle that ran out of budget is not retried.

### Merge back

When a tentacle passes and its patch applies cleanly (`git apply --check` against the lead's
working tree), what happens depends on the session's edit setting:

- **Edits apply on their own** (`autoApprove: "edits"`, or `--auto-edits`): the patch is applied
  at once, as its own checkpoint. `/undo` reverts it like a turn.
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
| Running at once per session | 4 | More wait in a queue (at most 32 waiting). |
| Session budget | 100 cSats | `delegate` is refused once it is spent. |
| Per tentacle | 25 cSats | The tentacle stops with `error` when it is reached. Can be set lower per `delegate` call. |
| Agent steps per attempt | 12 | |

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
| `tentacle_finished` | `{tentacle}`, with its result and merge state |
| `tentacle_merge` | `{id, merge, tentacle}`, when an approval is answered |
| `tentacle_config` | `{config, spentCSats}` |
| `note` | `{entry}`, the transcript note |

## Context graduation

As a lead's conversation grows, `chooseLeadModel` (`lead-model.ts`) moves the lead, for that turn,
to a model with a larger window instead of letting it lose the start of the conversation:

- With a frontier lead (BYOK), it moves to the frontier lead.
- Otherwise, it moves to the smallest-window candidate that fits within 75% of its window,
  cheapest first.

It is wired where each turn's model is chosen (`provider-server.ts`, the sessions' `chat`), behind
these settings:

| Setting | Meaning |
| --- | --- |
| `EDGECODER_CONTEXT_GRADUATION=1` | Turns graduation on. |
| `EDGECODER_LEAD_CANDIDATES="network/qwen3-coder:30b=32768,network/big:70b@gpu=131072"` | The candidate models and their windows. |
| `EDGECODER_FRONTIER_CONTEXT` | The frontier lead's window (default 200000). |

A session on `auto` is left alone without a frontier lead, because Auto sizes each call itself.

## Hook points (for the in-flight branches)

The tentacle code lives in new files:

- `src/apps/ide/tentacles.ts`
- `src/apps/ide/tentacle-workspace.ts`
- `src/apps/ide/delegate.ts`
- `src/apps/ide/tentacle-routes.ts`
- `src/apps/ide/lead-model.ts`
- `src/terminal/tentacles.ts`
- `desktop/src/lib/tentacles.ts`
- `desktop/src/components/TentacleTree.svelte`

Existing files get only thin, marked hooks:

| File | Hook |
| --- | --- |
| `sessions.ts` | `TurnEnv.onSessionStop` (called from `cancel`, `remove` and `shutdown`); `SessionHub.peek`, `publishEvent` and `recordNote`; `undo` also accepts notes; `TranscriptEntry.tentacle`. |
| `tool-types.ts` | Three tool names and `TENTACLE_TOOLS`, included in `READ_TOOLS` so they don't ask. `bots.ts` filters them out of bot defaults; `tool-executor.ts` has a refusing `case` for them. |
| `provider-server.ts` | Builds the `TentacleManager` and `tentacleWorkerBackend`; wraps the session `executor`, `tools` and `systemPrompt`; registers the routes; adds context graduation in `chat`. |
| `hosted-backend.ts` | Forwards `req.hints` as the body's `edgecoder` field. |
| `src/terminal/repl.ts` | Hands `tentacle_*` events and `/tentacles` to `TentacleTracker`. |
| `src/terminal/cli.ts` | `--lead`, `--worker`, `--tentacles` and `--tentacle-budget`; posts the config after the session is created. |
| `LiveSessionPanel.svelte` | Loads and folds the tree, and renders `<TentacleTree>`. |
| `desktop/src/lib/api.ts` | Three calls. |

Where the other branches plug in:

- **BYOK (`frontierBackend`, session `leadModel` / `workerModel`):**
  - `TentacleDeps.workerModelFor` already reads `session.workerModel` when it exists.
  - `tentacleWorkerBackend` should route a frontier id to `frontierBackend`.
  - Graduation reads `session.leadModel` as the frontier step.
  - `--lead` in `initialModel` should set `leadModel` instead of the model.
- **Terminal usability (permission modes, co-editing queue, read-only / allowlist classification):**
  - `TentacleDeps.canAutoApply(session)` decides auto-apply versus approval. The default is
    `autoApprove === "edits"`; map the new permission modes there.
  - `TENTACLE_SHELL_ALLOW` and `tentacleShellDecision` should defer to the shared read-only /
    allowlist classifier.
  - The lead's turn is not blocked by tentacles, so a message queue can carry tentacle results as
    they arrive. `TentacleManager.unreported()` already feeds the next turn's prompt.
