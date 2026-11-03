# EdgeCoder for AI agents (MCP)

AI agents can sign up for EdgeCoder, pay with their own bitcoin and use the network's compute
without a person, an email address or the desktop app. They reach compute through the portal's
hosted API (the same `/v1` endpoint tools like Cursor use), never through `localhost`.

Three pieces:

1. **Key-based signup** on the portal: an agent proves it holds a key and gets an API key.
2. **Account routes** on the hosted API: balance, usage, Lightning top-ups and reservations.
3. **An MCP server** (`packages/mcp-server`, bin `edgecoder-mcp`) that wraps both for any MCP
   client (Claude Desktop, Claude Code, other agent frameworks).

## MCP server

### Tools

| Tool | Does | Route |
| --- | --- | --- |
| `list_models` | Models you can run, including `auto` | `GET /v1/models` |
| `chat` | A chat completion (model defaults to `auto`); returns the text, the cost in cSats and where it ran | `POST /v1/chat/completions` |
| `balance` | Balance in cSats and recent ledger entries | `GET /v1/account` |
| `topup` | A Lightning invoice (bolt11) and its amount; pay it from your own wallet | `POST /v1/account/topup` |
| `topup_status` | Whether a top-up was paid and credited | `GET /v1/account/topup/:intentId` |
| `usage` | Requests, cost and tokens by day and model | `GET /v1/account/usage?days=` |
| `reserve_machine` | Reserve one machine of a class (cpu, apple, gpu, gpu.dc) for some minutes | `POST /v1/account/reservations` |
| `list_reservations` | Your reservations and what can be reserved now | `GET /v1/account/reservations` |
| `cancel_reservation` | Cancel a reservation (unused time is refunded) | `POST /v1/account/reservations/cancel` |

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `EDGECODER_URL` | the EdgeCoder portal (same default as the installer's `--portal-url`) | Portal / hosted API. Must be `https://` unless it is `localhost`. |
| `EDGECODER_API_KEY` | none | An `eck_` key from the portal's Connect page or from agent signup. |
| `EDGECODER_AGENT_KEY_FILE` | `~/.edgecoder/agent-key` | Where the agent's own key lives when there is no API key. |
| `EDGECODER_AGENT_NAME` | `agent` | Display name for a new agent account. |

With `EDGECODER_API_KEY` set, the server uses that key and nothing else. Without it, the server
creates a secp256k1 (Nostr-style) key in `~/.edgecoder/agent-key` (mode 0600, directory 0700),
signs up with it and stores the API key it gets in the same file. If the portal later refuses the
stored key (revoked, or the account was rotated elsewhere) the server signs up again with the same
key, which keeps the account and its balance. Back up `agent-key`: it is the account. Anyone with
it can mint API keys for the account.

### Build

```sh
cd packages/mcp-server
npm install
npm run build        # dist/cli.js is the edgecoder-mcp bin
```

Once the package is published, `npx -y @edgecoder/mcp-server` replaces the local path below.

### Claude Desktop

`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows:
`%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "edgecoder": {
      "command": "node",
      "args": ["/path/to/edgecoder/packages/mcp-server/dist/cli.js"],
      "env": {
        "EDGECODER_URL": "https://your-portal.example",
        "EDGECODER_API_KEY": "eck_..."
      }
    }
  }
}
```

Leave out `EDGECODER_API_KEY` to have the server sign up on its own key. Leave out `EDGECODER_URL`
to use the EdgeCoder portal.

### Claude Code

```sh
claude mcp add edgecoder \
  --env EDGECODER_API_KEY=eck_... \
  -- node /path/to/edgecoder/packages/mcp-server/dist/cli.js
```

Or in a project's `.mcp.json` (do not commit a real key; use `${EDGECODER_API_KEY}` expansion):

```json
{
  "mcpServers": {
    "edgecoder": {
      "command": "node",
      "args": ["/path/to/edgecoder/packages/mcp-server/dist/cli.js"],
      "env": { "EDGECODER_API_KEY": "${EDGECODER_API_KEY}" }
    }
  }
}
```

## Signup by key (portal API)

No email and no password: an agent proves it holds a key.

```
POST /agents/challenge  { "keyType": "secp256k1" | "ed25519", "publicKey": "<64 hex>" }
  -> { "nonce", "challenge", "expiresAtMs", "sign": "sha256(utf8(challenge))" }

POST /agents/signup     { "keyType", "publicKey", "nonce", "signature": "<128 hex>", "name"? }
  -> { "accountId": "acct-<userId>", "apiKey": "eck_...", "created": true|false, "revokedKeys": n }
```

- `secp256k1` keys are 32-byte x-only public keys (a Nostr `npub` in hex); the signature is
  BIP-340 Schnorr over `sha256(utf8(challenge))`. `ed25519` keys sign the same 32-byte digest.
- The challenge text names the key it was issued to, lives 5 minutes and can be used once. It is
  removed when a signup presents it, whether or not the signup succeeds.
- The first signup creates an **agent account**: a portal user with no password, kind `agent`, and
  a reserved placeholder email (`agent-<userId>@agents.invalid`, RFC 2606) that is never delivered
  to. It cannot log in to the web portal, and email features (verification, wallet send codes)
  are unavailable to it. Normal signup and OAuth refuse that email domain.
- Signing up again with the same key (a fresh challenge and a valid signature) **rotates** the
  account's API key: every earlier key is revoked and a new one is returned. The API key is shown
  only once and only its SHA-256 is stored.
- Both routes share the portal's auth rate limit (10 per minute per client IP). New agent accounts
  are also capped per portal instance per hour (`AGENT_SIGNUPS_PER_HOUR`, default 500).

## Account routes (hosted API)

All take `Authorization: Bearer eck_...` (or `x-api-key`). The portal calls the coordinator with
its service token and the key's own account; a caller cannot name another account.

| Route | Coordinator |
| --- | --- |
| `GET /v1/account`: `{ accountId, cSats, earnedSats, recent, usage: { days: 30, totals, recent } }` | `/account/summary`, `/account/usage` |
| `GET /v1/account/usage?days=1..90` | `/account/usage` |
| `POST /v1/account/topup { amountSats }` (100 to 1,000,000): `{ intentId, invoice, amountSats, cSats, feeSats, network, expiresInSeconds }`. 10 per minute per IP. | `/account/buy` |
| `GET /v1/account/topup/:intentId`: `{ status }` | `/account/intent` |
| `GET /v1/account/reservations` | `/account/reservations/list` |
| `POST /v1/account/reservations { computeClass, minutes, model? }` | `/account/reservations` |
| `POST /v1/account/reservations/cancel { reservationId }` | `/account/reservations/cancel` |

The agent pays the invoice from its own Lightning wallet; the coordinator credits the account
when its node sees the payment. Chat requests then draw down the balance (a 402 means top up).

## Later: L402 and Nostr Wallet Connect (design only)

Not built yet. How they would fit:

### L402 (pay per request)

L402 replaces "top up, then spend a balance" with "pay for this request". It suits agents that
keep no balance with EdgeCoder.

- A `/v1/chat/completions` (or `/v1/messages`) request **without** an API key, or with a key whose
  balance is too low, gets `HTTP 402` with
  `WWW-Authenticate: L402 macaroon="<base64>", invoice="<bolt11>"`.
- The invoice comes from the same coordinator path as top-ups (`/account/buy`), priced from the
  request: the model and class quote (`cSatsPerSecond` from `/inference/models`) times a ceiling on
  seconds from `max_tokens`. Unused value stays on the account as cSats rather than being refunded
  over Lightning.
- The macaroon binds the payment hash, the account (an agent account created on the fly from the
  payment hash, or the key's account), the model, an expiry and a spend ceiling (caveats).
- The client pays, then retries with `Authorization: L402 <macaroon>:<preimage>`. The portal checks
  `sha256(preimage) == payment_hash`, the macaroon signature (root key held by the portal), and that
  the caveats hold; the coordinator settles the intent, credits the account, and the request runs as
  usual.
- Per block of time: the same flow with a reservation instead of a request (`computeClass`,
  `minutes` caveats), so an agent can pay once for an hour on a GPU.
- In the MCP server, `chat` would handle a 402 itself when the agent has a wallet connection (next
  section), or return the invoice to the agent.

### Nostr Wallet Connect (budgeted spending)

NWC (NIP-47) lets an agent's wallet pay invoices on request within a budget the owner set.

- Configured in the MCP server only (`EDGECODER_NWC_URI=nostr+walletconnect://...`), never sent to
  EdgeCoder: the portal only ever sees paid invoices.
- When the balance is low (or a 402 arrives), the server gets an invoice from `topup` (or the L402
  challenge), sends `pay_invoice` to the wallet over the NWC relay, waits for the preimage, then
  checks `topup_status` (or retries with the L402 header).
- Limits: the wallet enforces the owner's budget (per day / per payment, set when creating the NWC
  connection); the MCP server adds its own `EDGECODER_MAX_TOPUP_SATS` and a per-hour cap so a
  prompt-injected agent cannot drain the wallet in one go. Each automatic payment is logged to
  stderr and returned in the tool result.
- The agent's Nostr key (the same secp256k1 key used for signup) can be the NWC client key, so one
  key is the agent's identity for both.
