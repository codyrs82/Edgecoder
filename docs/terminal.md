# EdgeCoder in the terminal (`edgecoder code`)

`edgecoder code` is a coding agent in your terminal, like running `claude`. It works in a folder,
or in a GitHub repository it clones first. It uses the same agent loop and tools as the desktop
app's Code view: reading and searching files, editing them, running commands, git, and pull requests.
Network inference runs it on any model on the network. With `/remote`, the same session continues
in the desktop app.

## Install

`edgecoder` comes with the EdgeCoder app and the agent installer (`docs/install.md`).

**With the desktop app:** Settings → General → Command line → **Install command-line tool**. It
writes a small launcher that runs the agent bundled in the app with the app's own Node
(`<app>/Resources/agent/node/node <app>/Resources/agent/dist/cli/edgecoder.js`):

- macOS and Linux: `~/.local/bin/edgecoder` (a `/bin/sh` script).
- Windows: `%LOCALAPPDATA%\EdgeCoder\bin\edgecoder.cmd`.

It says whether that folder is on your `PATH`; if not, add it (on macOS and Linux:
`export PATH="$HOME/.local/bin:$PATH"` in `~/.zshrc` or `~/.bashrc`) and open a new terminal.
An existing EdgeCoder launcher there is replaced; any other file with that name is left alone.

From a checkout of this repository:

```sh
npm ci && npm run build
node dist/cli/edgecoder.js code --help     # or: npx tsx src/cli/edgecoder.ts code --help
```

## Usage

```sh
cd ~/EdgeCoder/my-app && edgecoder code                       # this folder
edgecoder code --repo https://github.com/codyrs82/Edgecoder   # clone (or update) into ~/EdgeCoder, then work there
edgecoder code --repo codyrs82/Edgecoder --model network/qwen3-coder:30b --remote
edgecoder code --resume <session-id>                          # continue a saved session (--list shows them)
```

The first time in a folder, it asks once whether to trust it. A trusted folder may run its own
tooling, such as type checkers and linters, by itself. The agent's own commands always ask first,
whatever you answer. `--trust` answers yes without asking. Headless (no TTY), the folder stays
untrusted unless you pass `--trust`.

| Option | Meaning |
| --- | --- |
| `--repo <url\|owner/repo>` | Clone into the projects folder (`EDGECODER_PROJECTS_DIR`, default `~/EdgeCoder`), or fast-forward the copy already there. The desktop's open project doesn't change. |
| `--model <id>` | A local Ollama tag, `network/<model>[@cpu\|apple\|gpu\|gpu.dc]`, `mine/<model>`, or `auto` (the default). |
| `--lead <id>` | The lead model, which runs the agent loop. For example `frontier/anthropic/claude-opus-5-5` on your own key (next section). Wins over `--model`. |
| `--worker <id>` | The worker model, for helpers and delegated work. The default is `auto`. It can't be a frontier model. |
| `--compute local\|network\|mine\|auto` | Where the model runs. A default model is picked for that place. |
| `--remote` | Show the session live in the app from the start. |
| `--mode ask\|auto-edits\|auto\|plan` | How much it asks first (below). Default: `auto-edits` in a git repository with a clean working tree (the checkpoint and git both keep the originals), else `ask`. |
| `--auto-edits` | Same as `--mode auto-edits`. |
| `--resume <id>`, `--list` | Continue a saved session, or list them. |
| `--provider <url>`, `--standalone`, `--port <n>` | Which provider to use (next section). |
| `--api-key-file <path>` | An `eck_` API key for network models without the app. |

While it runs:

- **Replies stream** as the model writes them.
- **Tool calls** print as one line each: `● read_file(src/x.ts)`, then `⎿ 120 lines`.
- **You can type at any time.** While a reply runs, Enter queues your message (`/queue` lists,
  `/unqueue` removes); it runs when the reply ends. **Esc** (or `/stop`, or Ctrl+C) stops the reply,
  and the queue runs next. What it already wrote stays, and `/undo` reverts it.
- **Approvals**: before an edit or write, the diff prints; before a command, the command prints.
  Then it asks `Allow …? [Y/n/a]`. **Enter means yes.**
  - **a** (always) on an edit applies later edits without asking (the session moves to
    auto-edits, and new sessions in this project start there).
  - **a** on a command keeps a rule such as `npm test:*` for this project from now on. It never
    covers a refused command or one that must always ask (network, push, deletes, paths outside
    the project); see [Permission modes](permission-modes.md).
  - Slash commands work at an approval prompt too: `/remote` publishes and the approval keeps waiting.
  - "Always" answers are kept per project in `~/.edgecoder/permissions.json` (0600).
- **Where it ran**: each turn ends with one dim line, for example
  `qwen3-coder:30b · Datacenter GPU 2×A16 · Chicago · read 24.8k tok in 81 s · wrote 312 tok in 6.5 s · 3.4 cSats`.
  The machine is named by its masked label (`lin-•••3f2a`), or as yours when it is your own;
  local runs say `This computer (Apple M1 Max)`. `/status` shows the last call in detail.

### Permission modes

The prompt line shows the mode (`[auto-edits] ›`); **Shift+Tab** cycles it, `/mode` sets it. The
app's Code view shows the same mode with a picker under the message box.

| Mode | Edits | Commands |
| --- | --- | --- |
| `ask` (Manual) | ask | ask |
| `auto-edits` (Accept edits) | apply (each turn stays undoable) | ask |
| `auto` | apply | safe ones run (tests, lint, build, git add/commit on a work branch); risky ones ask; dangerous ones are refused |
| `plan` | refused | read-only only, until you approve the plan with `/approve [mode]` |

Read-only commands never ask, pushes and pull requests always ask, and "always" answers keep a
rule such as `npm test:*` for the project. [Permission modes](permission-modes.md) has the full
run / ask / refuse tables and the rules for "always".

| Command | Does |
| --- | --- |
| `/model [name]` | Show or set the model. A bare name keeps the current place (`network/` stays network). |
| `/compute [local\|network\|mine\|auto]` | Where the model runs. |
| `/mode [ask\|auto-edits\|auto\|plan]` | How much it asks first (Shift+Tab cycles). |
| `/approve [ask\|auto-edits\|auto]` | In plan mode: approve the plan and carry it out (default auto-edits). |
| `/stop` | Stop the reply (Esc). Queued messages run next. |
| `/queue`, `/unqueue [n]` | List queued messages; remove one (default the last). |
| `/undo` | Revert the files the last reply changed (the turn's checkpoint). |
| `/clear` | Start the conversation over (same session and settings). |
| `/status` | Session, project and branch, model, mode, where the last call ran, who is connected, the queue, the provider. |
| `/lead [id]`, `/worker [id]` | Show or set the lead and the worker (next section). |
| `/cost` | cSats this session has spent, plus the estimated USD on your own frontier key. |
| `/remote [off]` | Continue this session in the app, or stop showing it there. |
| `/github` | Sign in to GitHub with a one-time code (below). |
| `/help`, `/exit` | Help, and leave. The session is kept. |

## Frontier models on your own key

The network's open models can't yet lead long coding work. You can let a frontier model lead, on
your own API key, and keep the worker on Auto:

```sh
edgecoder keys add anthropic                                         # once; asks for the key (hidden)
edgecoder code --lead frontier/anthropic/claude-opus-5-5 --worker auto
```

- The key stays in your keychain and is usable only by your EdgeCoder account on this computer.
  It is never used for other people's requests or network work.
- Calls go straight to the provider (Anthropic, or any OpenAI-compatible API you add with
  `--base-url`), and the provider bills you. EdgeCoder charges no cSats for them.
- Each turn's usage line says where it ran and what it cost, like a network call's:
  `Anthropic · claude-opus-5-5 · your key · read 24.8k tok · wrote 312 tok · $0.42`. `/cost`
  shows the session's total.
- Compaction summaries run on the worker model, never on your key, unless you opt in.
- A per-session cap and a daily cap (defaults $5 and $25) warn at 80% and stop at 100%. Change
  them with `edgecoder keys set --session-cap 10 --daily-cap 40`.

The full details are in [frontier-keys.md](frontier-keys.md): storage per OS, the account rule,
prices, retries, and `edgecoder keys`.

## Where it runs (the provider)

The agent loop runs in the **IDE provider**, the same local server the desktop app uses
(`src/apps/ide/provider-server.ts`). It listens on `127.0.0.1:4304` and requires the token in
`~/.edgecoder/ide-token`. `edgecoder code` is a client of it:

1. **The app is running.** Its provider is used (or the one `--provider` / `IDE_PROVIDER_URL`
   names). Models then run wherever the app's do: this computer's Ollama, your machines, or the
   network through this computer's enrolled agent.
2. **Nothing answers on 4304** (a server reached over SSH, or the app is closed). The provider
   starts inside the `edgecoder code` process on `127.0.0.1:4304` (`--port` changes it), with its
   logs off (`LOG_LEVEL` turns them on). Network models then go through this machine's agent if it
   is enrolled. Otherwise they go through the hosted endpoint (`https://edgecoder.io/v1`) with your
   API key: `EDGECODER_API_KEY`, or `--api-key-file` / `EDGECODER_API_KEY_FILE`. The key is sent
   only there and never logged. Usage is billed to the key's account in cSats.
3. **`--standalone`** always starts an in-process provider. Use it with `--port` when an older app
   build on 4304 has no shared sessions; `edgecoder code` tells you when that is the case.

Over SSH the terminal is all you need. The REPL works without colours (`NO_COLOR`) and without a
TTY: lines are read from stdin, and prompts are printed as plain text.

## Sessions

A session is a shared object owned by the provider (`src/apps/ide/sessions.ts`). It holds:

- the conversation;
- the project folder and its branch;
- the model and where it runs;
- the "always" answers;
- the tool calls waiting for approval;
- each turn's checkpoint.

Sessions are saved as one JSON file each in `~/.edgecoder/sessions` (`EDGECODER_SESSIONS_DIR`),
mode 0600. A running turn and its approvals live in memory. If the provider restarts, the turn
ends, and checkpoints from before the restart can no longer be undone with `/undo` (use git).

Clients read a snapshot (`GET /v1/ide/sessions/:id`), then follow the session's numbered events
over Server-Sent Events (`GET /v1/ide/sessions/:id/events?since=N`). A client that reconnects
resumes after the last event it saw. If the provider no longer has those events, it says `resync`
and the client fetches the snapshot again.

**Co-editing.** Every attached client (the terminal, the app) may send, answer approvals and change
settings at any time; nobody has to take control.

- A message sent while a turn runs is **queued** (in order, labelled with its client; `queued` /
  `unqueued` events). Any client can remove one (`POST …/unqueue`). When the turn ends, the next
  turn starts with all queued messages. **Stop** (`POST …/cancel`) from either client ends the turn
  so the queue runs now.
- **Approvals: the first answer wins.** The `approval` event names who answered (`by`, `label`), so
  the other client's prompt closes and says "approved in the terminal / app". A later answer
  returns `applied: false` and changes nothing.
- **Settings** (model, mode) from either client are broadcast with who changed what, and each
  client shows a short note.
- `POST …/control` and `/take` are kept as no-ops for older clients.

Model context: each turn keeps a running token estimate against the model's context window (the
coordinator's `/inference/models` reports the smallest window an agent serves a model with; local:
`AGENT_CONTEXT_WINDOW` or 32k). Before a call would pass ~85% of it, older tool results are replaced
by one-line summaries, then the older part by a summary from a cheap model call (or truncation),
keeping the request, recent messages and the exact file paths used. A `context_too_long` answer
compacts and retries once. `read_file` returns at most 400 lines per call and says how to read on.
Transient network failures (a lost stream, a proxy's 502 page, `not_requester`, an empty reply, a
timeout before any output) are retried twice with backoff.

| Route (all on the provider, IDE token) | |
| --- | --- |
| `GET /v1/ide/sessions[?published=1&projectRoot=]` | Summaries: `live` means published and a client is attached or a turn is running. |
| `POST /v1/ide/sessions` | Create one (`projectRoot`, `model`, `mode`). Without `mode`: auto-edits in a clean git repository, else ask. |
| `GET /v1/ide/sessions/:id`, `…/events?since=` | Snapshot, and the event stream. |
| `POST …/messages`, `…/unqueue`, `…/approve`, `…/settings`, `…/publish`, `…/trust`, `…/cancel`, `…/undo`, `…/clear`, `…/delete` | Writes, from any client. Each names the client (`clientId`, `kind`, `label`). |

Desktop chats you start in the app are still kept in the app (IndexedDB). Sessions started in a
terminal live in the provider, and the Code view shows the published ones next to them.

## Remote control

`/remote` (or `--remote`) publishes the session. In the app's **Code** view, it appears under its
project in the sidebar, marked **Live** while the terminal (or a turn) is attached. Opening it shows
the conversation and the reply streaming now.

Both work on it at once. The header shows who is connected ("Terminal and EdgeCoder app
connected"). From either side you can send a message (during a reply it is queued, shown as
**Queued** and removable), stop the reply (**Stop** next to Send, or Esc), approve or reject a tool
call (the first answer wins; the other side's prompt closes and says where it was answered), and
change the model or mode (the other side shows a note). The terminal prints the app's messages as
`› [from EdgeCoder app] …`. Each reply's footer says where it ran; hovering lists every model call.
`/remote off` stops showing the session in the app.

### Security

- The provider binds `127.0.0.1` only and every route needs the IDE token. A web page can't reach
  it: other origins and foreign `Host` headers are refused. Remote control on the same machine
  therefore needs nothing more.
- Sessions are never exposed publicly. Files are 0600 in a 0700 folder.
- Tokens are never logged or stored by these features. The GitHub token stays in gh's keychain
  entry. The API key goes only to the hosted endpoint, which must be `https`.

### From another machine (designed, not built)

Controlling a session from your other computer needs a relay, because neither machine accepts
connections from outside. The design:

1. **The session is bound to the account.** `/remote --account` registers the session with the
   coordinator through the agent's signed forwarder (as network calls are today). It sends only
   the id, the title and a public key made for this pairing. No content is sent.
2. **An explicit pairing code.** The terminal shows a short code. The other machine's app, signed in
   to the **same account**, enters it. The coordinator checks that the account matches and that the
   code is fresh (minutes, single use). Then the two ends do an X25519 key exchange, confirmed by
   the code (a SAS).
3. **End-to-end relay.** Session events and writes are relayed through the coordinator as
   encrypted frames (`ChaCha20-Poly1305`, keyed from the exchange). The coordinator sees only
   ciphertext, sizes and the account. The local provider applies a remote write exactly like a
   local client's: the same queue, and the same approvals.
4. **Revocable.** `/remote off` or closing the session ends the pairing. Pairings never outlive the
   session, and every attach is shown in the terminal.

## GitHub sign-in

Connect GitHub (in the Code view's project header, or Settings → Integrations) and `/github` in the
terminal run the GitHub CLI's device flow on the provider (`POST /v1/ide/github/login`):

1. The flow runs `gh auth login --web`.
2. The one-time code is read from gh's output and shown, with **Open github.com/login/device**.
3. The provider polls (`GET /v1/ide/github/login/:id`) until gh reports the sign-in, then shows the
   login.

The token stays with gh. If gh isn't installed, the app says how to install it (`brew install gh`,
cli.github.com).

## For builders: extending the agent

The session store is built to carry orchestration such as a `delegate` tool, where a master
session sends sub-jobs to cheaper network tiers. That exists now as tentacles
([tentacles.md](tentacles.md): `--tentacles`, `/tentacles`). The extension points are:

- **`TurnEnv`** (`sessions.ts`): `chat` decides where each model call goes per session. Its
  `ctx.role` is `"lead"` for the main loop and `"worker"` for helpers, and the worker runs on
  `workerModelOf(s)`. So a `delegate` tool or compaction asks for `role: "worker"` and never
  spends the user's frontier key. Separately, `executor` decides what each tool does. A `delegate` tool can be added in `executor` and run its
  sub-job as a child session: `SessionHub.create` with a cheaper model, then `send` and `idle` to
  wait.
- **`ToolRunnerDeps`** (`agent-loop.ts`):
  - `prepare` resolves arguments before approval;
  - `decide` (permission-policy.ts `decideToolCall`: run, ask or refuse per call) decides what asks;
    without it, `alwaysAllowed` and `autoApproveEdits` (a value or a function per call) do;
  - `waitForApproval` decides how an answer arrives;
  - `captureBeforeWrite` keeps each write undoable.
- **Session events** are plain objects with a `type`, so a new kind (for example `delegate_status`)
  reaches every client without changing the transport.
