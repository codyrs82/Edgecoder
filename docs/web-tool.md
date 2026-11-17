# Web tool

Live, real-world information for chats and bots: the model can **search the web** (`web_search`)
and **read a page** (`read_page`), and its answer cites the sources it used.

- **Chats** (desktop app and web chat): a **Web** toggle in the composer, off by default and kept
  per chat. Answers list their numbered sources under the reply, with links, and a footer such as
  `2 searches · 1 page · 1.2 cSats`. While it works the reply shows "Searching the web…" and
  "Reading example.com…".
- **Bots**: a **Search the web** permission in the bot's settings (What it may do), off by default.
- **Tool-capable models only.** The toggle is disabled ("Web needs a model that can use tools. Pick
  another model.") when the chat's model can't call tools (`src/model/tool-support.ts`
  `supportsTools`), and on the web chat for EdgeCoder's own default chat.
- **cSats.** Each search and each page read costs a little from the account's balance (defaults:
  0.5 cSats a search, 0.2 a page). With no balance the toggle says **needs cSats**.

## Where it runs

On EdgeCoder's servers, never on a host's machine. The model's tool calls go from the desktop app's
IDE server, a bot or the web portal's chat to a coordinator:

| Endpoint (coordinator) | Body | Answer |
| --- | --- | --- |
| `POST /v1/tools/web/status` | `{}` | `configured`, prices, `balanceCSats`, `canAfford`, what's left of the hour |
| `POST /v1/tools/web/search` | `{query, count≤8, requestId}` | `{query, results: [{title, url, snippet}], cSats}` |
| `POST /v1/tools/web/read` | `{url, requestId}` | `{url, title, text (≤20k chars), truncated, contentType, cSats}` |

Callers are account-authenticated: a signed agent (the desktop app reaches it through its local
forwarder, `/forward/v1/tools/web/*`; the signer's owner is billed) or the portal with its service
token, naming the account it authenticated (a web chat user, or an API key through the hosted
endpoint `POST https://edgecoder.io/v1/tools/web/{status,search,read}` for machines without an
enrolled agent). The desktop app asks `GET /v1/ide/web/status?model=…` (IDE server) or
`GET /portal/api/web/status` (portal) whether its toggle can be on.

Search is the [Brave Search API](https://api.search.brave.com). Its key is the coordinator secret
`BRAVE_SEARCH_API_KEY`; without it the whole tool is off ("Web search isn't set up yet") and the
apps hide the toggle. Set it on each coordinator with:

```sh
fly secrets set BRAVE_SEARCH_API_KEY=<subscription token> -a <coordinator app>
```

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

The toggle (chats) and the permission (bots) are the allowance, and network access needs one: the
web tools aren't offered without it. With it on:

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
- Prices: `WEB_SEARCH_CSATS` (0.5) and `WEB_READ_CSATS` (0.2). All five variables are in the
  [environment reference](../site-docs/reference/environment-variables.md#web-tool-coordinator).
