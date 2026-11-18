# Web tool

Live, real-world information for chats and bots: the model can **search the web** (`web_search`)
and **read a page** (`read_page`), and its answer cites the sources it used.

- **Automatic in chats** (desktop app and web chat). When web search is set up, the chat's model
  can call tools and the account has cSats, every chat offers the web tools and **the model decides**
  when a question needs them: news and current events, prices, release dates and versions of
  software, a specific page or document, or anything you ask it to look up. General coding help,
  explanations, writing and maths are answered directly, without searching (the system note,
  `WEB_SYSTEM_NOTE` in `src/web-tool/tools.ts`). Answers list their numbered sources under the
  reply, with links, and a footer such as `2 searches · 1 page · 1.2 cSats`. While it works the
  reply shows "Searching the web…" and "Reading example.com…".
- **A quiet indicator, not a toggle.** Under the message box the composer shows **Web: Auto**. Its
  small menu has **Auto** and **Off for this chat** (kept per chat). **Settings → General → Search
  the web automatically** (on by default) sets it for chats that haven't chosen; it's kept on that
  computer or in that browser (`edgecoder.web.auto`).
- **Bots**: a **Search the web** permission in the bot's settings (What it may do), **on for new
  bots**. Existing bots keep what they were given.
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
- **Per reply**, at most `WEB_MAX_SEARCHES_PER_REPLY` searches (3) and `WEB_MAX_READS_PER_REPLY`
  page reads (4); past that a call is refused before it reaches EdgeCoder (it costs nothing) and the
  model answers with what it has. A call refused for cSats (402), the hour's limit (429) or setup
  (503) turns the web off for the rest of that reply.

## Where it runs

On EdgeCoder's servers, never on a host's machine. The model's tool calls go from the desktop app's
IDE server, a bot or the web portal's chat to a coordinator:

| Endpoint (coordinator) | Body | Answer |
| --- | --- | --- |
| `POST /v1/tools/web/status` | `{ownMachine?}` | `configured`, prices, `balanceCSats`, `canAfford`, `free` (+ free calls left today with the basis), what's left of the hour |
| `POST /v1/tools/web/search` | `{query, count≤8, requestId, ownMachine?}` | `{query, results: [{title, url, snippet}], cSats, free?}` |
| `POST /v1/tools/web/read` | `{url, requestId, ownMachine?}` | `{url, title, text (≤20k chars), truncated, contentType, cSats, free?}` |

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
- After `read_page` has put a page's text into the context, nothing that changes files or runs
  commands happens on its own for the rest of that reply or bot run: a call the mode (or an "Always
  allow" rule) would have run asks first (`makeToolRunner` in `src/apps/ide/agent-loop.ts`). A bot
  running on its own queues it as **Needs approval**, so page text alone can never make it act.

## Permission modes

A chat on **Web: Auto** and a bot with **Search the web** have the allowance, and network access
needs it: the web tools aren't offered to a chat that's **Off for this chat** or a bot without the
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
- Bots: web calls count toward the bot's daily cSat budget; once it's spent the web tool refuses and
  the run stops like any over-budget run.
- Per reply (IDE server and portal): `WEB_MAX_SEARCHES_PER_REPLY` (3) and `WEB_MAX_READS_PER_REPLY`
  (4), each 0 to 50; a bot run counts as one reply.
- Prices: `WEB_SEARCH_CSATS` (0.5) and `WEB_READ_CSATS` (0.2). Free on your own machine within
  the daily caps (`WEB_FREE_OWN_MACHINE_SEARCHES_PER_DAY`, `WEB_FREE_OWN_MACHINE_READS_PER_DAY`,
  `WEB_FREE_GLOBAL_PER_DAY`). All these variables are in the
  [environment reference](../site-docs/reference/environment-variables.md#web-tool-coordinator).
