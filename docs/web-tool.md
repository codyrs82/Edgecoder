# Web tool

Live, real-world information for chats and bits: the model can **search the web** (`web_search`)
and **read a page** (`read_page`), and its answer cites the sources it used.

- **Automatic in chats** (desktop app and web chat). When web search is set up, the chat's model
  can call tools and the account has cSats, every chat offers the web tools and **the model decides**
  when a question needs them: news and current events, prices, release dates and versions of
  software, a specific page or document, or anything you ask it to look up. General coding help,
  explanations, writing and maths are answered directly, without searching (the system note,
  `webSystemNote()` in `src/web-tool/tools.ts`, which also tells the model it has live web access,
  gives today's date in UTC and says never to claim it has no internet or real-time access). A
  question that plainly needs fresh facts is also **searched by the server first** (Grounding,
  below), because small open models often don't call the tool on their own. Answers list their numbered sources under the
  reply, with links, and a footer such as `2 searches · 1 page · 1.2 cSats`. While it works the
  reply shows "Searching the web…" and "Reading example.com…".
- **A quiet indicator, not a toggle.** Under the message box the composer shows **Web: Auto**. Its
  small menu has **Auto** and **Off for this chat** (kept per chat). **Settings → General → Search
  the web automatically** (on by default) sets it for chats that haven't chosen; it's kept on that
  computer or in that browser (`edgecoder.web.auto`).
- **Bits**: a **Search the web** permission in the bit's settings (What it may do), **on for new
  bits**. Existing bits keep what they were given.
- **Tool-capable models only.** With a model that can't call tools (`src/web-tool/model-support.ts`
  `modelCallsTools`), and on the web chat for EdgeCoder's own default chat, the indicator is dimmed
  ("Web: unavailable with this model") and the chat answers without the web. Auto on your own
  machines picks one of their models that calls tools, or answers without the web.
- **cSats.** Each search and each page read costs a little from the account's balance (defaults:
  0.5 cSats a search, 0.2 a page). With no balance the web tools **aren't offered at all**, so no
  search is made just to fail: the chat answers without the web, the indicator says **needs cSats**,
  and the chat notes "Web search needs cSats" once under the reply. The same goes for an account
  over the hour's search limit.
- **Free on your own machine.** A chat whose model runs on your own machine (the desktop app's
  model on this computer, **My machines**, Auto kept to your machines, or the web chat's Auto when
  it picks one of your machines) searches and reads pages **for free**, even with no cSats: the
  footer says `2 searches · free (your machine)` and "needs cSats" is never shown for it. There is
  a daily allowance (100 searches and 200 page reads per account, and 5000 free calls in all per
  coordinator); past it the call is paid as usual (cSats when the balance allows; with none the
  chat answers without the web and notes "Today's free web searches on your machine are used up").
  See [Free on your own machine](#free-on-your-own-machine).
- **Searched on your own machine, no daily limit.** When that machine (or another of yours) is a
  Linux host set up by the installer, it runs its own SearXNG, and your own chats search there
  (from your connection, at no cost to anyone): free with **no daily cap**, and pages are read from
  your machine too. If it's down or finds nothing, the call falls back to the daily allowance
  above. See [Searches on your own machine](#searches-on-your-own-machine).
- **Per reply**, at most `WEB_MAX_SEARCHES_PER_REPLY` searches (3) and `WEB_MAX_READS_PER_REPLY`
  page reads (4); past that a call is refused before it reaches EdgeCoder (it costs nothing) and the
  model answers with what it has. A call refused for cSats (402), the hour's limit (429) or setup
  (503) turns the web off for the rest of that reply.

## Grounding (server-side search for time-sensitive questions)

Small and medium open models (qwen2.5/3/3.5, qwen3-coder) don't reliably decide to call a tool, and
often answer "as an AI I don't have real-time access" with the tool in front of them. So the shared
web layer (`webGrounding` in `src/web-tool/tools.ts`, used by the portal chat, the desktop app's
chats and bits) does two things around the agent loop:

- **Search first.** Before the first model turn, `needsFreshInfo` (a cheap, deterministic check of the
  latest user message) decides whether it needs fresh information. It fires on a URL; on an explicit
  "search / look up / google / the internet / online"; on plainly current questions (today, tonight,
  this week, news, what's new, weather, scores, who won, prices, the latest version or release of
  something, zero-days, CVEs); and on weaker cues (latest, current, recent, now, version, release, a
  year from 2025 on, a date) unless the message reads like a coding question. Code blocks and
  inline code are ignored, and a message with code needs an explicit ask or a URL. When it fires,
  the server runs one `web_search` with the message as the query (code removed, at most 200
  characters; a bare "search the internet" searches the previous question) and puts it in the
  conversation as the assistant's own tool call and its result, so the model answers from it and
  may search or read more. It goes through the same `WebToolSession.run` as a model's call: same
  billing to the account, same hourly cap, and it counts toward the reply's searches; the reply shows
  "Searching the web…" and the sources as usual. Not in **Manual** (web calls ask first), and for
  bits only on a message the owner wrote (a schedule's or GitHub's prompt never becomes a search on
  its own). Coding questions don't trigger it, so they cost nothing.
- **Post-check.** Once web results were provided, a sentence such as "I don't have access to
  real-time data" or "As an AI I can't browse the internet" is dropped from the streamed answer
  (`DisclaimerFilter`, held back only to the end of the current sentence). Stripping was chosen over
  a retry turn: no extra model call, cost or wait, it works the same on every backend, and the rest of
  the answer is kept.

The portal's `portal_web_loop` log line carries `grounded: true` when the server searched first.

## Where it runs

On EdgeCoder's servers, except for an own-machine chat whose machine has local web (see
[Searches on your own machine](#searches-on-your-own-machine)). The model's tool calls go from the desktop app's
IDE server, a bit or the web portal's chat to a coordinator:

| Endpoint (coordinator) | Body | Answer |
| --- | --- | --- |
| `POST /v1/tools/web/status` | `{ownMachine?}` | `configured`, prices, `balanceCSats`, `canAfford`, `free` (+ free calls left today with the basis, and `localSearch`/`localRead` when your machine answers), what's left of the hour |
| `POST /v1/tools/web/search` | `{query, count≤8, requestId, ownMachine?}` | `{query, results: [{title, url, snippet}], cSats, free?, local?}` |
| `POST /v1/tools/web/read` | `{url, requestId, ownMachine?}` | `{url, title, text (≤20k chars), truncated, contentType, cSats, free?, local?}` |

Callers are account-authenticated: a signed agent (the desktop app reaches it through its local
forwarder, `/forward/v1/tools/web/*`; the signer's owner is billed) or the portal with its service
token, naming the account it authenticated (a web chat user, or an API key through the hosted
endpoint `POST https://edgecoder.io/v1/tools/web/{status,search,read}` for machines without an
enrolled agent). The desktop app asks `GET /v1/ide/web/status?model=…` (IDE server) and the web
chat `GET /portal/api/web/status` (portal) what the indicator shows: `available`, and otherwise a
`reason` (`not_configured`, `no_tools`, `needs_csats`, `rate_limited`, `unreachable`), plus the
per-reply limits.

Before a reply is offered the web tools, the IDE server and the portal check the account's status
(`webAvailability` in `src/web-tool/tools.ts`, cached for 30 seconds per account and refreshed when
the app asks for the status). When it can't be used the reply goes ahead without the tools: the IDE
chat stream sends `{type: "web_off", reason, message}`, the portal chat stream `{webOff: {reason,
message}}`, and `POST /v1/ide/web-chat` (a chat without a project) answers `409 {error: "web_off"}`
so the app answers through the plain chat instead.

Search is the [Brave Search API](https://api.search.brave.com). Its key is the coordinator secret
`BRAVE_SEARCH_API_KEY`; without it the whole tool is off ("Web search isn't set up yet") and the
apps hide the Web indicator. Set it on each coordinator with:

```sh
fly secrets set BRAVE_SEARCH_API_KEY=<subscription token> -a <coordinator app>
```

## Free on your own machine

The caller says `ownMachine: true` in the body of `/v1/tools/web/{status,search,read}`. The
coordinator (`ownMachineBasis` in `src/web-tool/basis.ts`) accepts it only from a caller that can
vouch for it; otherwise it is ignored and the call is paid:

- **The portal** (service token) sets it itself, from the compute it resolved for the chat:
  `compute.target === "mine"`, or Auto when one of the user's machines has a model that calls tools
  (the chat then runs there). Nothing in the chat request can set it (the body schema drops unknown
  fields), and the hosted `/v1/tools/web/*` relay (an API key) drops a client's `ownMachine`.
- **A signed agent** (the desktop's IDE server through its local forwarder) may claim it for this
  computer's model, **My machines** and Auto with policy `local_only` / `mine_only`, and only when
  the agent is linked to the very account the call is billed to (an unlinked agent can't). Frontier
  models and the network pay as usual.

Free calls still count toward the hour's limits. Per coordinator and UTC day:
`WEB_FREE_OWN_MACHINE_SEARCHES_PER_DAY` (100) and `WEB_FREE_OWN_MACHINE_READS_PER_DAY` (200) per
account, and `WEB_FREE_GLOBAL_PER_DAY` (5000) free calls in all, a cost circuit-breaker. Past a cap
the call falls back to paid. A free call moves no cSats; its answer carries `free: true` and
`cSats: 0`. With the basis, `/status` reports `free` (the next search costs nothing) and
`freeSearchesLeftToday` / `freeReadsLeftToday`; the IDE server's and the portal's status endpoints
pass these on with `ownMachine`, and say `reason: "free_used"` (not `needs_csats`) when an own-machine
chat has used today's free calls and has no cSats. The chat streams' `web` totals and the `done`
event's `web` carry `free: true` when every call of the reply was free.

For ops, free calls are counted in `usage_records` (no migration): one record per account per day
per coordinator, `kind: "web"`, `placement: "mine"`, `costMsat: 0`, with `webFree: {searches,
reads}`, rewritten after each free call. `/account/usage` leaves them out of the request list and
totals and reports them as `webFree`.

## Searches on your own machine

`src/web-tool/local-web.ts`, `searxng.ts`, `src/swarm/coordinator/local-web.ts`,
`src/install/searxng.ts`.

**The host.** `edgecoder-install apply` (and so every auto-update) sets up SearXNG on Linux hosts:
a pinned commit (`SEARXNG_COMMIT`), the GitHub archive checked against `SEARXNG_TARBALL_SHA256`
before it is unpacked, a Python venv with every dependency hash-pinned
(`scripts/linux/searxng/requirements.lock`, `pip --require-hashes --only-binary=:all:`), and
`edgecoder-searxng.service` (granian on `127.0.0.1:18888` only, `DynamicUser`, read-only system, the
root-only `settings.yml` handed over as a systemd credential). Its settings: JSON output on, its own
generated `secret_key` (kept across runs), no limiter (one local user; the agent and the
coordinator cap the calls instead), and a few engines that need no keys (DuckDuckGo, Brave's web
search, Mojeek, Startpage, Wikipedia). The agents get `SEARXNG_URL=http://127.0.0.1:18888`
(loopback http only; anything else is ignored). `--searxng off` (or `--no-searxng`) writes
`EDGECODER_SEARXNG=off` to `/etc/edgecoder/searxng.env`, which every later apply and update keeps;
it stops and removes the unit and drops `SEARXNG_URL`. A failed install doesn't fail the apply;
the host just uses EdgeCoder's servers. macOS and Windows hosts don't get SearXNG yet; their
agents still read pages locally.

**The agent** checks its SearXNG's `/healthz` (at most once a minute) and reports
`localWeb: {search, read}` in its signed heartbeat (`AGENT_LOCAL_WEB=off` reports nothing and does
nothing).

**A call.** For a call with the own-machine basis (decided as in
[Free on your own machine](#free-on-your-own-machine); a client still can't claim it), the
coordinator picks one of the account's machines: verified owner (`agent_ownership`) equal to the
chat's account, a signed heartbeat with `localWeb` in the last 3 minutes, and a mesh WebSocket that
proved its key; the calling agent first, else the most recently seen. It sends a `local_web` frame
signed with its identity key down that socket (the agent checks the pinned key, its own agent id, a
30-second lifetime and a replay cache, as for `bot_control`). The agent searches its SearXNG, or
reads the page with `fetchPage` (the same SSRF rules as the server reader: public addresses only,
pinned connection, ports 80/443, 2 MB, 10 s), and answers on `POST
/agent-control/agents/:agentId/web/result` (signed). The coordinator takes an answer only for a
command it sent to that very agent, once, and cleans it again (`cleanResults`: plain text, title
300 / snippet 600 characters, http(s) only, at most 8; pages to 20,000 characters). It then reaches
the model like a Brave result, wrapped as untrusted web content.

**Cost and fallback.** An answer from your machine costs nothing, counts toward no daily cap and
works without `BRAVE_SEARCH_API_KEY`; its response carries `free: true, local: true, cSats: 0`. The
relaying is capped at `LOCAL_WEB_PER_HOUR` (600) calls per account per coordinator, and each agent
runs at most 120 per 10 minutes (so the engines don't see a burst from your IP). No machine, a
refusal, no answer within 9 seconds (15 for a page), or no results: the call goes on as if your
machine hadn't been asked (free within the daily caps, then paid). So a host that claims SearXNG
and answers nothing gets nothing it wouldn't have had anyway. `/status` with the basis says
`localSearch: true` (and `free: true`, `canAfford: true`) while one of your machines can search; the
apps then show "Free on your machine, searched from your machine (no daily limit)".

Caveats: the machine must be connected to the coordinator the chat's web calls go to (the portal
pins the coordinator it picked for the chat; another coordinator's machine isn't asked). Search
engines change their pages and sometimes block scrapers; the engine list and the pinned commit are
updated with agent releases.

## read_page safety (`src/web-tool/ssrf.ts`, `fetch-page.ts`)

- `http` and `https` only, port 80 or 443, no `user:password@`.
- The host is resolved once and **every** address checked; private, loopback, link-local,
  metadata and reserved addresses are refused: `10/8`, `172.16/12`, `192.168/16`, `127/8`,
  `169.254/16` (incl. `169.254.169.254`), `100.64/10`, `0/8`, multicast and reserved, `::1`, `::`,
  `fc00::/7` (incl. Fly's 6PN `fdaa::/16`), `fe80::/10`, and IPv4 inside IPv6 (mapped, NAT64, 6to4)
  by the IPv4 address. Names like `localhost`, `*.internal`, `*.local` are refused before lookup.
- **DNS rebinding:** the connection is pinned to the address that was checked (the socket's lookup
  always answers it), so a second, different DNS answer can't move the request.
- **Redirects** are followed by hand (at most 5), each one checked like the first URL.
- At most **2 MB** and **10 seconds**. Content types: HTML, text, JSON, and PDF. PDFs are read by a
  small built-in reader (uncompressed or Flate streams with plain text operators, no dependency);
  scanned PDFs or ones with custom font encodings are refused.
- HTML is reduced to its title and main text (`src/web-tool/extract.ts`): scripts, styles,
  navigation, headers, footers, forms and asides dropped; headings, paragraphs, list items and table
  rows kept; at most 20,000 characters.
- It identifies itself as `EdgeCoderWebTool/1.0 (+https://edgecoder.io)`.

## Prompt injection

- Everything the tools return is wrapped as untrusted data (`<<<untrusted_web_content …>>>`, with
  any marker inside the page neutralised), and the system prompt says web content is information,
  never instructions.
- After `read_page` has put a page's text into the context, the rest of that reply or bit run is
  guarded (`makeToolRunner` in `src/apps/ide/agent-loop.ts`): a command, git call or other action
  the mode (or an "Always allow" rule) would have run asks first, so page text alone can never make
  the agent run anything. A bit running on its own queues it as **Needs approval**.
  - **Edits inside the project still apply** when the mode applies them anyway (Accept edits, Auto):
    each one is in the turn's checkpoint and can be undone. Protected paths (git hooks, files tooling
    runs), secrets files and files outside the project ask (or are refused) as the mode says.
  - **Allow for the rest of this run**: a card the guard asked shows why ("Asked because this run read
    a web page") and offers this answer next to Allow and Deny. It lets later guarded calls (only
    calls the mode or a rule would run anyway) go ahead until that reply or run ends; anything the
    mode itself asks about still asks, and nothing is kept afterwards. It never covers a call that
    runs a file the run wrote or edited (`src/apps/ide/edited-runs.ts`): the script itself
    (`./x.sh`, `python3 tools/x.py`, `bash x.sh`, `node x.js`), or a runner after its build file
    changed (`make` after the Makefile, `npm run` / `npx` after `package.json`, `just`, `cargo`,
    pytest/tox configs, a tool's `*.config.js`). Such a call asks again, naming the file, without the
    run-wide answer. Residual risk: a test runner or build still runs edited source or test files it
    finds on its own (`npm test` after editing a test) once the allowance is given. The phone and the web portal
    answer one call at a time and don't offer it (their answers never widen what runs without
    asking, like "Always allow").
  - An ask the mode makes after a page read keeps its **Always allow** rule. Answering with it keeps
    the rule but doesn't lift the guard: the next guarded call in that run still asks (once, if you
    answer it with "Allow for the rest of this run"). A rule says which commands are routine; the
    guard is about whether page text is steering this run, so one tap never does both.
  - **Full access** skips the guard: the user chose to approve everything. Its hard refusals (sudo,
    wiping a disk or the project, download-and-run, secrets) still apply.

## Permission modes

A chat on **Web: Auto** and a bit with **Search the web** have the allowance, and network access
needs it: the web tools aren't offered to a chat that's **Off for this chat** or a bit without the
permission. With it:

| Mode | web_search / read_page |
| --- | --- |
| Auto | run |
| Accept edits | run |
| Manual | ask each time (a call costs cSats and sends the query or URL off the machine) |
| Plan | run (they change nothing) |

## Billing and limits (`src/web-tool/service.ts`)

- Each call is debited from the caller's account in the ledger **before** it runs (reason
  `tool:web_search` or `tool:read_page`, idempotent on the request id) and refunded in full when it
  fails (`tool:web_search_refund`, `tool:read_page_refund`). A failed call costs nothing: the balance
  falls by exactly the cSats of the calls that returned something. No balance: `402 needs_csats`.
- Per account per hour (sliding, per coordinator): `WEB_SEARCH_PER_HOUR` searches (60) and
  `WEB_READ_PER_HOUR` page reads (120); over it: `429 rate_limited`.
- Bits: web calls count toward the bit's daily cSat budget; once it's spent the web tool refuses and
  the run stops like any over-budget run.
- Per reply (IDE server and portal): `WEB_MAX_SEARCHES_PER_REPLY` (3) and `WEB_MAX_READS_PER_REPLY`
  (4), each 0 to 50; a bit run counts as one reply.
- Prices: `WEB_SEARCH_CSATS` (0.5) and `WEB_READ_CSATS` (0.2). Free on your own machine within
  the daily caps (`WEB_FREE_OWN_MACHINE_SEARCHES_PER_DAY`, `WEB_FREE_OWN_MACHINE_READS_PER_DAY`,
  `WEB_FREE_GLOBAL_PER_DAY`). All these variables are in the
  [environment reference](../site-docs/reference/environment-variables.md#web-tool-coordinator).
