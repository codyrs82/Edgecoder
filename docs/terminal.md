# EdgeCoder in the terminal (`edgecoder code`)

`edgecoder code` is a coding agent in your terminal, like running `claude`. It works in a folder,
or in a GitHub repository it clones first. It uses the same agent loop and tools as the desktop
app's Code view: reading and searching files, editing them, running commands, git, and pull requests.
Network inference runs it on any model on the network. With `/remote`, the same session continues
in the desktop app.

## Install

`edgecoder` comes with the EdgeCoder app and the agent installer (`docs/install.md`). From a
checkout of this repository:

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

The first time, it asks once whether to trust the folder. A trusted folder may run its own
tooling, such as type checkers and linters, by itself. The agent's own commands always ask first,
whatever you answer. `--trust` answers yes without asking. Headless (no TTY), the folder stays
untrusted unless you pass `--trust`.

| Option | Meaning |
| --- | --- |
| `--repo <url\|owner/repo>` | Clone into the projects folder (`EDGECODER_PROJECTS_DIR`, default `~/EdgeCoder`), or fast-forward the copy already there. The desktop's open project doesn't change. |
| `--model <id>` | A local Ollama tag, `network/<model>[@cpu\|apple\|gpu\|gpu.dc]`, `mine/<model>`, or `auto` (the default). |
| `--compute local\|network\|mine\|auto` | Where the model runs. A default model is picked for that place. |
| `--remote` | Show the session live in the app from the start. |
| `--auto-edits` | Apply file edits without asking. Every turn stays undoable, and commands still ask. |
| `--resume <id>`, `--list` | Continue a saved session, or list them. |
| `--provider <url>`, `--standalone`, `--port <n>` | Which provider to use (next section). |
| `--api-key-file <path>` | An `eck_` API key for network models without the app. |

While it runs:

- **Replies stream** as the model writes them.
- **Tool calls** print as one line each: `● read_file(src/x.ts)`, then `⎿ 120 lines`.
- **Approvals**: before an edit or write, the diff prints; before a command, the command prints.
  Then it asks `Allow …? [y]es / [n]o / [a]lways`:
  - **always** on an edit applies later edits in this session without asking. Edits to files that
    tooling runs (`.git`, `.husky`, …) still ask.
  - **always** on a command covers that program name, such as `npm`, for plain commands with no
    shell syntax.
  - Commits, pushes and pull requests ask every time.
- **Ctrl+C** stops the reply that is running. What it already wrote stays, and `/undo` reverts it.

| Command | Does |
| --- | --- |
| `/model [name]` | Show or set the model. A bare name keeps the current place (`network/` stays network). |
| `/compute [local\|network\|mine\|auto]` | Where the model runs. |
| `/undo` | Revert the files the last reply changed (the turn's checkpoint). |
| `/clear` | Start the conversation over (same session and settings). |
| `/status` | Session, project and branch, model, who is in control, who is watching, the provider. |
| `/cost` | cSats this session has spent. |
| `/remote [off]` | Continue this session in the app, or stop showing it there. |
| `/take` | Take control back from the app. |
| `/github` | Sign in to GitHub with a one-time code (below). |
| `/help`, `/exit` | Help, and leave. The session is kept. |

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

**One writer at a time.** The client in control sends messages, answers approvals and changes
settings. The others watch, and a write from them is refused with `not_in_control`. **Take
control** (`POST …/control`) hands the session over, including an approval that is already
waiting. When the terminal exits, it releases control so the app can carry on.

| Route (all on the provider, IDE token) | |
| --- | --- |
| `GET /v1/ide/sessions[?published=1&projectRoot=]` | Summaries: `live` means published and a client is attached or a turn is running. |
| `POST /v1/ide/sessions` | Create one (`projectRoot`, `model`, `autoApprove`). The creator is in control. |
| `GET /v1/ide/sessions/:id`, `…/events?since=` | Snapshot, and the event stream. |
| `POST …/messages`, `…/approve`, `…/control`, `…/settings`, `…/publish`, `…/trust`, `…/cancel`, `…/undo`, `…/clear`, `…/delete` | Writes. Each names the client (`clientId`, `kind`, `label`). |

Desktop chats you start in the app are still kept in the app (IndexedDB). Sessions started in a
terminal live in the provider, and the Code view shows the published ones next to them.

## Remote control

`/remote` (or `--remote`) publishes the session. In the app's **Code** view, it appears under its
project in the sidebar, marked **Live** while the terminal (or a turn) is attached. Opening it shows
the conversation and the reply streaming now.

The app watches until you press **Take control**. After that it can send messages and approve or
reject tool calls, and the terminal mirrors everything:

- the message (`› [desktop] …`);
- the tool calls and their diffs;
- "waiting for the app to approve";
- the outcome.

Typing in the terminal then says the app is in control; `/take` takes it back. `/remote off` stops
showing the session in the app.

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
   local client's: the same one-writer rule, and the same approvals.
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
session sends sub-jobs to cheaper network tiers. The extension points are:

- **`TurnEnv`** (`sessions.ts`): `chat` decides where each model call goes per session, and
  `executor` decides what each tool does. A `delegate` tool can be added in `executor` and run its
  sub-job as a child session: `SessionHub.create` with a cheaper model, then `send` and `idle` to
  wait.
- **`ToolRunnerDeps`** (`agent-loop.ts`):
  - `prepare` resolves arguments before approval;
  - `alwaysAllowed` and `autoApproveEdits` (a value or a function per call) decide what asks;
  - `waitForApproval` decides how an answer arrives;
  - `captureBeforeWrite` keeps each write undoable.
- **Session events** are plain objects with a `type`, so a new kind (for example `delegate_status`)
  reaches every client without changing the transport.
