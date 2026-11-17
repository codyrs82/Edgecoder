# Permission modes

How much the agent asks before it acts. Every chat (the Chat view and the Code view's chat), every
live session (`edgecoder code`, shown in the app) and every bot has its own mode. Pick it with the
button under the message box (number keys **1–4** while the list is open), with **Shift+Tab** or
`/mode` in the terminal, or with `--mode` when starting `edgecoder code`. New chats start in the
default from **Settings → General → Permissions** (Accept edits unless you change it).

| # | Mode | Engine name | File edits | Commands |
| --- | --- | --- | --- | --- |
| 1 | **Auto** | `auto` | apply | safe ones run, risky ones ask, dangerous ones are refused (below) |
| 2 | **Manual** | `ask` | ask | ask |
| 3 | **Accept edits** | `auto-edits` | apply (each reply stays undoable) | ask |
| 4 | **Plan** | `plan` | refused until you approve the plan | read-only only |

In every mode:

- Reading never asks: `read_file`, `list_directory`, the searches, `git status/diff/log`, and
  read-only shell commands (`ls`, `cat`, `grep`, `rg`, `find` without `-exec`, `git status`, …, with
  pipes between them and no redirection or path outside the project).
- `git push`, `open_pull_request` and `github_create_pr` always ask.
- Edits to protected paths (`.git`, hooks, `.vscode`, `node_modules`, `.gitmodules`, build scripts
  tooling runs) and to files outside the project always ask.
- Writes to secrets files (`.env*` except `.env.example`, `*.pem`, `*.key`, `id_rsa`, `.npmrc`,
  `credentials.json`, `~/.ssh`, …) or of content that looks like an API key or token never apply
  on their own: Auto refuses them, the other modes ask.
- The tool executor's own checks still apply after any "yes".

- The web tool (`web_search`, `read_page`) is offered only when the chat is on **Web: Auto** (the
  default; **Off for this chat** turns it off) or the bot has the **Search the web** permission (on
  for new bots), which is its allowance: Auto, Accept edits and Plan run
  it, Manual asks for each call. After a page is read, edits and commands that would have run on
  their own ask first for the rest of the reply or run ([web tool](web-tool.md)).

The decision is made in one place, `src/apps/ide/permission-policy.ts` (`decideToolCall`,
`classifyCommand`), for chats, sessions and bots alike.

## Auto

| Runs without asking | Still asks | Refused |
| --- | --- | --- |
| Reads (above) | Installs: `npm install/i/ci/add`, `pnpm add`, `yarn add`, `pip install`, `brew …`, `apt …`, `cargo install`, `npx <anything but a known dev tool>` | `sudo`, `su`, `doas` |
| Edits inside the project (not protected paths or secrets) | Network: `curl`, `wget`, `ssh`, `scp`, `rsync`, `gh`, `git fetch/pull/clone` | `rm -rf /`, `~`, `$HOME`, `.`, `*`, `..`, `--no-preserve-root` |
| Tests, lint, typecheck, build, format: `npm test …`, `npm run test/lint/build/typecheck/check/format…`, `yarn/pnpm/bun` the same, `vitest`, `jest`, `pytest`, `python -m pytest`, `tsc`, `eslint`, `prettier`, `svelte-check`, `ruff`, `mypy`, `cargo test/build/check/clippy/fmt`, `go test/build/vet`, `make` / `make test/build/lint/check`, `npx vitest/tsc/eslint/…` | `git push` (every mode) | Download-and-run: `curl` or `wget` output piped into a shell (`sh`, `bash`, …) or into `python`, `node`, `ruby`, `perl` |
| `git status/diff/log/show`, `git add`, `git commit` on the session's work branch (not `main`/`master`), the `git_commit` tool likewise | Deletes: `rm` of project files (only build output such as `dist`, `build`, `coverage`, `node_modules`, `.next`, `target` runs), `git clean`, `git reset --hard`, history rewrites | Writing secrets: a redirect or copy to `.env*` or another secrets file, a command or file containing an API key or token |
| Deleting build output inside the project (`rm -rf dist`) | Anything touching a path outside the project, or a protected path | `mkfs`, `dd of=/dev/…`, a fork bomb |
| | Docker and friends: `docker`, `docker compose`, `podman`, `kubectl`, `helm` | |
| | Inline code: `sh -c`, `bash -c`, `node -e`, `python -c`, `xargs` | |
| | Other package scripts or make targets (`npm run deploy`, `make release`), commits on `main`/`master`, `git commit --amend`, other git commands | |
| | Shell syntax that can't be checked (`$(…)`, backticks, subshells, here-docs), and any program Auto doesn't know | |

A command chained with `&&`, `;` or `|` takes the strictest verdict of its parts.

The refused classes ask (rather than being refused) in Manual and Accept edits, where you see the
exact command before it runs; they can never be allow-listed.

## Plan

The agent gets only the read-only tools (and read-only shell commands); any other call is refused
with "Plan mode: only read-only tools until the user approves the plan". The system prompt asks it
to investigate and reply with a plan (a summary, then numbered steps naming the files and how it
will verify the work). The reply is marked as a plan, and the app shows **Approve plan** (with the
mode to continue in, Accept edits by default) and **Revise**:

- **Approve plan** switches the chat, session or bot to the chosen mode and sends "The plan is
  approved. Carry it out now…", which starts the turn that does the work. In the terminal: `/approve
  [ask|auto-edits|auto]`. API: `POST /v1/ide/sessions/:id/plan {mode}`.
- **Revise** puts the cursor in the message box: say what to change and the agent plans again (it
  stays in Plan mode).

## Always allow

An approval card for a command offers **Allow**, **Always allow `npm test …` in this project** and
**Deny**. Always allow keeps a rule for the project and lets the command run:

- Rules are prefix rules like Claude Code's: `npm test:*` matches `npm test` with any arguments
  (`npm test src/a.ts`), never `npm testing` and never a chained command (`npm test && …`, `;`,
  `|`, `$(…)`). A rule without `:*` matches exactly. Older entries that are a single program name
  (`npm`) still work and keep their old meaning (only commands that aren't risky).
- The rule offered is the program and its subcommand (`npm test:*`, `npm run lint:*`,
  `python -m pytest:*`).
- Never offered or honoured for refused commands, nor for classes that must always ask: network,
  `git push`, deletes, paths outside the project, protected paths, inline code, unreadable syntax.
  Installs, Docker, other scripts and unknown programs can be allow-listed.
- Kept per project folder in `~/.edgecoder/permissions.json` (0600), never in the project itself, so
  a cloned repository can't allow commands on its own. **Settings → General → Permissions →
  Always-allowed commands** lists them per project with Remove. API: `GET /v1/ide/permissions`,
  `POST /v1/ide/permissions/remove {projectRoot, rule}`.

## Bots

A bot's mode is set with the same picker under its message box and kept with the bot (`mode` in
`~/.edgecoder/bots.json`; the older `autoApproveEdits` switch follows it). The bot's own tool
list still limits what it may use at all.

A bot that runs on its own (schedule, check-ins, GitHub triggers) has nobody watching. In Auto it
does what Auto runs; anything that would ask is queued on the bot as **Needs approval** (the bot's
status and avatar say so, in the app and on the web) and waits for your Allow / Always allow / Deny.
It never blocks forever: after 24 hours unanswered the call is denied and the run goes on to its
summary. Changing the mode while a call waits lets it go ahead when the new mode would run it.

On the web portal a bot's approvals can be answered (Approve / Deny), but its mode, tools and
always-allow rules are changed on the Mac only.
