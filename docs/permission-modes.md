# Permission modes

How much the agent asks before it acts. Every chat (the Chat view and the Code view's chat), every
live session (`edgecoder code`, shown in the app) and every bot has its own mode. Pick it with the
button under the message box (number keys **1–5** while the list is open), with **Shift+Tab** or
`/mode` in the terminal, or with `--mode` when starting `edgecoder code`. New chats start in the
default from **Settings → General → Permissions** (Accept edits unless you change it).

| # | Mode | Engine name | File edits | Commands |
| --- | --- | --- | --- | --- |
| 1 | **Auto** | `auto` | apply | safe ones run, risky ones ask, dangerous ones are refused (below) |
| 2 | **Manual** | `ask` | ask | ask |
| 3 | **Accept edits** | `auto-edits` | apply (each reply stays undoable) | ask |
| 4 | **Plan** | `plan` | refused until you approve the plan | read-only only |
| 5 | **Full access** | `full` | apply, anywhere in the project | run without asking; only the hard refusals (below) are refused |

In every mode but Full access (which has [its own section](#full-access)):

- Reading never asks: `read_file`, `list_directory`, the searches, `git status/diff/log`, `git_fetch`,
  and read-only shell commands (`ls`, `cat`, `grep`, `rg`, `find` without `-exec`, `git status`,
  `git log`, `git rev-parse`, `git rev-list`, `git merge-base`, `git branch --show-current`, …).
  Read-only commands chained with `&&`, `||`, `;` or `|` also run without asking, as long as every
  part is read-only and there is no redirection (`>`), no `$(…)` or backticks, no background `&` and
  no path outside the project. One part that isn't read-only and the chain is judged like any other
  command (below).
- `git push`, `open_pull_request` and `github_create_pr` always ask.
- Edits to protected paths (`.git`, hooks, `.vscode`, `node_modules`, `.gitmodules`, build scripts
  tooling runs) and to files outside the project always ask.
- Writes to secrets files (`.env*` except `.env.example`, `*.pem`, `*.key`, `id_rsa`, `.npmrc`,
  `credentials.json`, `~/.ssh`, …) or of content that looks like an API key or token never apply
  on their own: Auto refuses them, the other modes ask.
- The tool executor's own checks still apply after any "yes".

- The web tool (`web_search`, `read_page`) is offered only when the chat is on **Web: Auto** (the
  default; **Off for this chat** turns it off) or the bot has the **Search the web** permission (on
  for new bots), which is its allowance: Auto, Accept edits, Plan and Full access run
  it, Manual asks for each call. After a page is read, commands and other actions that would have
  run on their own ask first for the rest of the reply or run; edits inside the project that the
  mode applies still apply (undoable), and the card offers **Allow for the rest of this run**
  ([web tool](web-tool.md#prompt-injection)). Full access skips this guard.

The decision is made in one place, `src/apps/ide/permission-policy.ts` (`decideToolCall`,
`classifyCommand`), for chats, sessions and bots alike.

## Auto

| Runs without asking | Still asks | Refused |
| --- | --- | --- |
| Reads (above) | Installs: `npm install/i/ci/add`, `pnpm add`, `yarn add`, `pip install`, `brew …`, `apt …`, `cargo install`, `npx <anything but a known dev tool>` | `sudo`, `su`, `doas` |
| Edits inside the project (not protected paths or secrets) | Network: `curl`, `wget`, `ssh`, `scp`, `rsync`, `gh`, `git fetch/pull/clone` (`git fetch` / `git pull` and the `git_pull` tool can be always-allowed, below) | `rm -rf /`, `~`, `$HOME`, `.`, `*`, `..`, `--no-preserve-root` |
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

## Full access

Nothing asks. Every tool call and command that another mode would run or ask about runs on its
own: edits anywhere in the project (protected paths such as `.husky/` included), every shell
command (chains with `&&`, `;` and pipes, `$VAR` and `$(…)`, redirections, network, installs,
Docker, deletes inside the project, inline code), `git commit` on any branch, `git push`, branches,
`open_pull_request` / `github_create_pr`, and the web tool. Each run counts as approved for the tool
executor's own checks.

Still refused, never asked (the same classes Auto refuses; nothing new):

- `sudo`, `su`, `doas`
- wiping a disk, a home folder or the whole project (`rm -rf /`, `~`, `$HOME`, `.`, `*`, `..`,
  `--no-preserve-root`), `mkfs`, `dd of=/dev/…`, a fork bomb
- a download piped into a shell or interpreter (curl output fed to `sh`)
- a command containing what looks like an API key or token, and writing a secrets file (`.env*`,
  `*.pem`, `id_rsa`, `.npmrc`, `credentials.json`, …) or content that looks like a key
- the executor's own refusals (writes into `.git`, paths that escape the project, and the like)

Also unchanged: Plan mode still means Plan; using a frontier key for a bot still asks (that is a
key approval, not a permission ask). Full access skips the [web tool](web-tool.md#prompt-injection)'s
prompt-injection guard: after `read_page` reads a web page, everything still runs as Full access
decides (the hard refusals above stay).

Where it is offered:

- **The desktop app's chats and live sessions, and `edgecoder code`** (`--mode full`,
  `/mode full`). Shift+Tab never cycles into it; from Full access it goes back to `ask`. Picking it
  in the app asks for a confirm the first time in each project ("runs commands, edits, installs and
  pushes without asking, even after it reads a web page; only a few destructive or secret-leaking
  commands are still blocked").
  The mode button shows it in the warning color. **Settings → General → Permissions** can make it
  the default for new chats, behind the same confirm.
- **Not from the phone or the web** (the code relay): they can't switch a session into Full access
  (`full_on_mac`), and a phone turn in a Full access session runs under the phone's usual remote
  rules as Accept edits.
- **Not for another account**: in a shared session only the owner's account (or this computer's
  own clients) can turn it on, and a message from another account's client runs as Accept edits,
  the way a frontier lead serves only the owner.
- **Not for bots** in this version: bots keep their own mode (Manual, Accept edits, Auto, Plan).

## Node versions

A project can pin its Node version (`.nvmrc`, `.node-version`, `nodejs` in `.tool-versions`,
`volta.node` or `engines.node` in `package.json`) while the machine's default is another one, and
then `npm ci` fails when a native module such as `better-sqlite3` compiles. The agent handles it
instead of stopping (`src/apps/ide/toolchain.ts`):

- **Up front.** When a session starts a turn, EdgeCoder compares what the project wants with
  `node --version` in the agent's own shell, and looks for nvm, fnm, volta, asdf, mise and Homebrew
  `node@N` kegs. On a mismatch the lead's system prompt gets a short "Node version" note: wanted vs
  current, and the command prefix that runs a command under the right version with what's installed,
  usually `PATH="<that version's bin folder>:$PATH" npm ci` (the shell has a scrubbed environment, so
  paths are spelled out). If no fitting version is installed, it names the install command
  (`nvm install 22`, `fnm install 22`, `volta fetch node@22`, `mise install node@22`,
  `asdf install nodejs latest:22`, or `brew install node@22` when there is no manager). Cached a
  minute per project.
- **On a failure.** When a command's output shows an engine or native-module mismatch (npm
  `EBADENGINE` / `Unsupported engine`, `The engine "node" is incompatible`, `NODE_MODULE_VERSION`,
  node-gyp or `better-sqlite3` build errors while the versions differ), the result the model sees
  ends with an `[EdgeCoder hint]` giving the same diagnosis and the failed command rewritten under
  the right version. It is only a hint: nothing runs by itself.

How these commands are judged:

| Command | Verdict |
| --- | --- |
| `PATH="/abs/node@22/bin:$PATH" <cmd>` | Same as `<cmd>` (folders must be absolute and outside the project; a PATH into the project or a relative one asks) |
| `. "$HOME/.nvm/nvm.sh" && nvm use 22 >/dev/null && <cmd>` | Same as `<cmd>` (an `nvm.sh` inside the project is not treated as setup) |
| `fnm exec --using=22 <cmd>`, `nvm exec 22 <cmd>`, `asdf exec <cmd>` | Same as `<cmd>` |
| `volta run --node 22 <cmd>`, `mise exec node@22 -- <cmd>` | Ask as an install (they download a missing version), or stricter if `<cmd>` is |
| `nvm install`, `fnm install`, `volta fetch/install`, `mise install`, `asdf install`, `brew install` | Ask as an install |
| `nvm use 22` on its own | Asks |

A rule matches a plain command only (no `$`); a wrapped command with `$PATH` asks in Manual even
when its plain form is allow-listed; approve it once from the card. Command lines joined with `&&`,
`;`, `|` or `||` are covered part by part (below).

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
  `python -m pytest:*`), or an interpreter and the project script it runs
  (`python3 tools/watchlist.py:*`, `node scripts/build.mjs:*`), not every script.
- Never offered or honoured for refused commands, nor for classes that must always ask: network,
  `git push`, deletes, paths outside the project, protected paths, inline code, unreadable syntax.
  Installs, Docker, other scripts and unknown programs can be allow-listed.
- `git pull` and `git fetch` are the one network exception: their card offers **Always allow
  `git pull …`** (rule `git pull:*`, or `git fetch:*`), for the shell command and for the `git_pull`
  tool alike (the `git_fetch` tool already runs without asking). The rule covers only a plain pull
  or fetch from a named remote (`git pull`, `git pull origin main`, `git pull --rebase`,
  `git fetch --prune`); a URL or path instead of a remote, a refspec, options such as
  `--upload-pack` or `--recurse-submodules`, and `git -C …` still ask each time. `git clone`,
  `git ls-remote`, `git submodule`, `curl`, `wget` and other network commands are never
  allow-listed, and `git push`, pull requests, commits on the default branch, deletes and
  destructive commands keep asking whatever rules exist.
- A command line (`python3 tools/watchlist.py SPY 2>&1 | head -20; echo "exit=$?"`) is judged part
  by part. Its card offers one plain rule per part that needs one (here `python3 tools/watchlist.py:*`)
  and the button names each rule it keeps, so **Always-allowed commands** stays readable. Read-only
  parts (`head`, `tail`, `echo`, `grep`, `wc`, `sort`, `cat` of project files, ...) need none, and
  `2>&1`, `2>/dev/null` and `&>` are fine. The line then runs without asking only when every part
  only reads, is covered by a rule, or (in Auto) is a command Auto runs. No rule is offered, and
  none covers the line, when any part uses `$(…)` or backticks, `eval` or `source`, a variable in a
  covered part, `>` / `>>` into a file, a pipe into a shell or interpreter that runs its input
  (`sh`, `bash -s`, a bare `python3` or `python -c …` after the pipe, or `xargs`), a background `&`, the network,
  or a path outside the project. When every part is read-only it runs without asking anyway (above).
- Kept per project folder in `~/.edgecoder/permissions.json` (0600), never in the project itself, so
  a cloned repository can't allow commands on its own. **Settings → General → Permissions →
  Always-allowed commands** lists them per project with Remove. API: `GET /v1/ide/permissions`,
  `POST /v1/ide/permissions/remove {projectRoot, rule}`.

## Bots

A bot's mode is set with the same picker under its message box and kept with the bot (`mode` in
`~/.edgecoder/bots.json`; the older `autoApproveEdits` switch follows it). The bot's own tool
list still limits what it may use at all. Full access isn't offered for bots (a hand-edited
`"full"` runs as Accept edits).

A bot that runs on its own (schedule, check-ins, GitHub triggers) has nobody watching. In Auto it
does what Auto runs; anything that would ask is queued on the bot as **Needs approval** (the bot's
status and avatar say so, in the app and on the web) and waits for your Allow / Always allow / Deny.
It never blocks forever: after 24 hours unanswered the call is denied and the run goes on to its
summary. Changing the mode while a call waits lets it go ahead when the new mode would run it
(not a call the web-page guard asked about: that waits for your answer, or for Full access in a
chat or session).

On the web portal a bot's approvals can be answered (Approve / Deny), but its mode, tools and
always-allow rules are changed on the Mac only.
