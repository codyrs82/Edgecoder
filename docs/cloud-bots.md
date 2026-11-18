# Cloud bots

Bots that run on EdgeCoder's servers. A user makes one from the website or the iOS app and it
works with no desktop machine and no folder. It answers messages, runs on a schedule, and reacts to
GitHub events. Desktop bots (`src/apps/ide/bots.ts`) still run on their machine with its folder and
tools. Both kinds appear in one list.

| Piece | Where |
| --- | --- |
| Settings and validation | `src/portal/cloud-bots/types.ts` |
| Storage (3 portal tables) | `src/portal/cloud-bots/store.ts`, created by `PortalStore.migrate()` |
| Runner, scheduler, GitHub poller | `src/portal/cloud-bots/runner.ts` |
| Model calls and web tools | `src/portal/cloud-bots/inference.ts` |
| GitHub REST tools and polling | `src/portal/cloud-bots/github.ts` |
| Secrets (GitHub tokens) | `src/portal/cloud-bots/secrets.ts` |
| API | `src/portal/routes/cloud-bots.ts`, mounted in `src/portal/routes/bots.ts` |
| Web page | `src/portal/pages/bots.ts` (New bot: Runs on Cloud; the bot page) |
| Desktop | sidebar list ("Cloud") and `desktop/src/pages/CloudBotView.svelte` (read and message) |

## API

Cloud bots use the desktop bots' routes with `agentId: "cloud"`.

| Route | What |
| --- | --- |
| `GET /portal/api/bots` | Cloud bots are in `bots` with `runtime: "cloud"` and `machine: {agentId: "cloud", machineName: "Cloud", online: true, controls: "on", canCreate: true}`. Desktop bots now carry `runtime: "desktop"`. `targets` always starts with `{agentId: "cloud", machineName: "Cloud", online: true, canCreate: true}`. `cloud: {github: boolean}` says whether GitHub is set up on the server. |
| `POST /portal/api/bots/new` | `{requestId, agentId: "cloud", bot}` makes the bot at once and returns `{ok, botId, agentId: "cloud", state: "created", runtime: "cloud"}`. The same `requestId` returns the same bot. |
| `GET /portal/api/bots/cloud/:botId` | `{bot, machine}`: the desktop bot summary's fields, with `tail` (the latest 30 messages), `messageCount`, `runtime: "cloud"`, and `cloud: {compute, web, schedule, github: {repo, hasToken, triggers, available} \| null, limits}`. |
| `POST /portal/api/bots/cloud/:botId/commands` | `{action, args}` returns `{ok, commandId, result: {commandId, status: "done", data?}}`. The result comes back inline; nothing needs polling. |
| `GET /portal/api/bots/cloud/commands/:commandId` | The command's state. A message's `commandId` is its message id; its state also gives `run: {id, status}` (`queued`, `running`, `done`, `failed`, `budget`, `cancelled`, `interrupted`). Other commands are remembered for 10 minutes on the portal instance that ran them. |

`bot` on create: `name` (required), `role`, `instructions`, and:

- `compute`: `"auto"` (default), `"mine:<model>"`, `"network:<model>"` (`"network:auto"`: the
  network's best fit), a bare model name (meaning the network), or a desktop-style
  `{policy, model}`. A frontier model is refused.
- `web`: boolean, default `true`.
- `schedule`: `{everyMinutes: 15..10080}`, `{dailyAtUtc: "HH:MM"}`, or `null`.
- `github`: `{repo: "owner/repo", token?, triggers?}`. Each trigger is `"pr_opened"`,
  `"ci_failed"`, `"issue_labeled"`, or an object `{kind (or event), label?, enabled?}`. The default
  label for `issue_labeled` is `bot`.
- Limits: `budgetCSatsPerDay` (default 100), `budgetCSatsPerRun` (25), `maxRunsPerDay` (48), and
  `maxTurns` (12, at most 30).
- `color`.

Fields from the desktop form that a cloud bot doesn't use (`mode`, `heartbeatMinutes`, …) are
dropped.

The iOS app sends these same fields for machine targets too. On a machine target, `compute`, `github.repo`,
`github.triggers` and `schedule.everyMinutes` are mapped to the desktop form's fields. `web`, a
daily UTC schedule and the token are dropped. A token never goes to a machine.

Commands:

| Command | Args | What it does |
| --- | --- | --- |
| `message` | `{content}` | Up to 20,000 characters. Joins the bot's queued run, or queues one. `data`: `{queued, runId, messageId}`. |
| `pause`, `resume` | | Paused bots still answer messages; schedules and triggers wait. |
| `check_now` | | Queues a run now. |
| `stop` | | Cancels the running run and any queued one. |
| `update_settings` | | Any create field, plus `enabled`, plus `triggers` (the page's switches). For the token, `github.token` omitted keeps the stored one; `""` or `null` removes it. `github: null` removes GitHub. |
| `delete` | | Removes the bot, its conversation and its runs. |
| `messages` | `{beforeMs?, beforeId?, limit≤40}` | A page of older messages. |
| `history` | | The last 50 runs. |
| `memory` | | Always `""` (cloud bots don't keep notes yet). |

`approve` is refused with `not_supported`: cloud bots never wait for approval.

Replies are polled, as for desktop bots. While a run is going, the detail's `status` is `running`
and `activity` says what it's doing; clients poll every 2 to 3 seconds then, and every 8 seconds
otherwise.

## Runs

Each kind of work becomes a queued run row: a message, a schedule, a GitHub event, or Check now.
Schedule and GitHub triggers also add an `event` message ("Scheduled run (hourly)", "GitHub: Pull
request #12 opened by …"), which the model sees as a turn marked `[Event]`.

- **Worker.** Every portal instance runs a worker loop (`CLOUD_BOTS_WORKER`, on by default). It
  claims queued runs inside a transaction that holds a Postgres advisory lock, with `FOR UPDATE SKIP
  LOCKED`. A bot has at most one queued and one running run (partial unique indexes). An account has
  at most `CLOUD_BOTS_MAX_CONCURRENT_PER_ACCOUNT` running runs. A message kicks the loop at once;
  otherwise it ticks every 5 seconds.
- **Scheduler and poller.** Every 30 seconds, due schedules and due GitHub polls are claimed the
  same way (advisory lock plus `SKIP LOCKED`). The next time is moved on in the same transaction,
  so with two portal instances (bluegreen) each one fires once.
- **The run.** It uses the desktop's agent loop (`runAgentLoop`) on the bot's compute.
  - `auto` uses the owner's own online machines first, picking a model that calls tools (free), and
    otherwise the network's best fit, billed to the owner's account. This is the web chat's path.
  - Each network call carries the run's remaining budget as its cSat ceiling.
  - The run holds a 3-minute lease and renews it while it works. A run whose instance went away is
    marked `interrupted`, and the bot says so in the conversation.
- **Limits.**
  - Model turns (`maxTurns`), output tokens per call and per run, and a wall-clock timeout.
  - cSats per run and per UTC day per bot, counting model calls and web calls together.
  - Runs started on its own per day (`maxRunsPerDay`).
  - A run that hits a limit stops with status `budget` and says why.
- **Failures.** Each failure surfaces as a bot message ("I couldn't finish this run: …"). The run
  row keeps the error.

## Tools

- **Web** (`web_search`, `read_page`): the same session, prices, per-reply limits and SSRF guard as
  the web chat ([web-tool.md](web-tool.md)). They're offered only when the bot has web on and the
  account can pay for a search.
- **GitHub** (REST, with the bot's token, on its one repository):
  - `github_read_file` and `github_list_files`;
  - `github_list_pull_requests` and `github_read_pull_request`;
  - `github_list_issues` and `github_read_issue`;
  - `github_comment`;
  - `github_open_pull_request`: a new branch `edgecoder/<name>` from the default branch, at most 10
    files and 200 KB written through the contents API, then a pull request.
- Nothing else. There is no shell, no file system, and no network access beyond the web tools and
  api.github.com.

GitHub triggers poll every `CLOUD_BOTS_GITHUB_POLL_MS` (3 minutes):

| Trigger | Fires on |
| --- | --- |
| `pr_opened` | Open PRs created since the last poll, except PRs by the token's own account |
| `ci_failed` | Failed workflow runs |
| `issue_labeled` | Open issues with the label |

The first poll only records what's there. Events are deduplicated by id (the last 300 are kept in
`github_state`). At most 5 events go into one run.

## Storage

These are new portal tables. The owner must approve them before merge.

| Table | Holds |
| --- | --- |
| `portal_cloud_bots` | Settings as `config` JSON (color, web, schedule, GitHub repo and triggers, limits), `compute`, `paused`, `next_run_at_ms`, `next_poll_at_ms`, `github_state` (the poller's cursor and seen ids), and `github_token_enc` (the sealed token). |
| `portal_cloud_bot_messages` | Each bot's conversation: `role` (`user`, `assistant`, `event`), `content`, `run_id`, and `meta` (status, tool steps, usage, PRs opened). |
| `portal_cloud_bot_runs` | `trigger`, `source`, `status`, created, started and ended times, `lease_until_ms`, `cancel_requested`, `cost_csats`, `summary`, `error`, `activity`, and `where_ran`. |

Account deletion (`USER_DELETE_PLAN`) removes all three by `user_id`.

## Environment

| Variable | What it does |
| --- | --- |
| `PORTAL_BOT_SECRETS_KEY` | The token key (64 hex characters or base64 of 32 bytes). Unset: GitHub is off for cloud bots, with "GitHub for cloud bots isn't set up on this server yet". |
| `CLOUD_BOTS_WORKER` | `on` or `off`. |
| `CLOUD_BOTS_MAX_PER_ACCOUNT` | Default 20. |
| `CLOUD_BOTS_MAX_CONCURRENT_PER_ACCOUNT` | Default 2. |
| `CLOUD_BOTS_WORKER_CONCURRENCY` | Default 4. |
| `CLOUD_BOTS_MAX_TOKENS_PER_CALL` | Default 4096. |
| `CLOUD_BOTS_MAX_OUTPUT_TOKENS_PER_RUN` | Default 32000. |
| `CLOUD_BOTS_RUN_TIMEOUT_MS` | Default 10 minutes. |
| `CLOUD_BOTS_GITHUB_POLL_MS` | Default 3 minutes. |

See the [environment reference](../site-docs/reference/environment-variables.md).

## Threat model

**Assets:**

- each user's GitHub token;
- the repositories those tokens reach;
- the user's cSats;
- the bots' conversations;
- the portal itself, which shares a process and a database with sign-in and wallets.

**Actors:**

- the bot's owner;
- other signed-in users;
- anyone who can write text the bot reads: web pages, issue and PR authors, commenters, and
  committers to the repository;
- a portal operator with database access.

| Threat | Mitigation |
| --- | --- |
| Another user reads or drives my bot | Every route takes the account from the session, never from the request. Every store query names `user_id`. A bot id that isn't yours answers 404, the same as a missing one. The tests check list, detail, commands and command state across accounts. |
| Token disclosure through the API or logs | The token is accepted only on create and `update_settings`. It is sealed with AES-256-GCM: a random IV per value, and the bot id bound as additional data, so a ciphertext moved to another row won't open. Bot reads never select the token column; clients get only `hasToken`. The token is decrypted only for a run or a poll, and goes only into the `Authorization` header to `https://api.github.com` (`redirect: "error"`). GitHub errors are passed on as GitHub's message, never with the request. Logs carry run ids and status only. |
| Database leak | Tokens are ciphertext without `PORTAL_BOT_SECRETS_KEY`, which is a Fly secret, not in the database. Changing the key makes stored tokens unreadable (owners re-enter them). |
| Prompt injection from instructions, messages, web pages or GitHub text makes the bot misuse GitHub | Tools take no repository: every path is built from the configured `owner/repo`, so a bot can't touch other repositories, and only within the token's scopes. Writes are limited to a comment, and a PR from a new `edgecoder/…` branch with at most 10 files and 200 KB. It never pushes to the default branch, merges, deletes or force-pushes. `.github/`, `.git` and `.gitmodules` are refused, because workflows run with repository secrets. After `read_page` in a run, GitHub writes are refused for the rest of that run. The system prompt marks all tool output as untrusted data, and the tools wrap it as `<<<untrusted_web_content …>>>`. **Residual risk:** text in an issue or PR in the bot's own repository can still steer what the bot comments or proposes in a PR. Owners should give the token the least scope (a fine-grained token for one repository: contents, issues and pull requests) and review PRs before merging. |
| SSRF or arbitrary network access | No fetch tool. Web reads go through the coordinator's SSRF-guarded `read_page` ([web-tool.md](web-tool.md)). The GitHub host is fixed. |
| Runaway spend | Per-run and per-day cSat budgets cover model and web calls together, and each network call carries the remaining budget as its ceiling. Turn, token and time limits apply, and so do runs per day. An account can have at most N concurrent runs and 20 bots. Web calls have their own hourly limits on the coordinator. |
| Abuse of the create and message endpoints | IP rate limits on the routes (create 20/min, commands 60/min). Per account, each portal instance allows 20 new bots an hour and 20 messages a minute. Messages are at most 20,000 characters, and instructions at most 8,000. |
| Duplicate runs with two portal instances | Advisory-locked claims with `SKIP LOCKED` and partial unique indexes: one queued and one running run per bot. Scheduled times move on in the claiming transaction. |
| A crashed instance leaves a run stuck | A lease of 3 minutes, renewed while working. Expired runs become `interrupted`, and the bot tells the owner. |
| XSS through bot output | The web page renders messages with the shared escaped markdown renderer, and the desktop uses its `MarkdownRenderer`. |
