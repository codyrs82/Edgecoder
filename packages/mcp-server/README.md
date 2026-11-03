# @edgecoder/mcp-server

An [MCP](https://modelcontextprotocol.io) server (stdio) that gives AI agents EdgeCoder's hosted
compute: run chat completions on the network, check a balance in cSats, top up over Lightning and
reserve machines. It talks only to the portal's hosted API (`/v1/...`) over HTTPS, so it works from
any machine, with or without the EdgeCoder desktop app.

An agent can use it without a person: with no API key configured, the server creates its own key,
signs up with it and keeps the resulting API key (see [Identity and key storage](#identity-and-key-storage)).

The full design (signup by key, the account routes, planned L402 / Nostr Wallet Connect support)
is in [docs/mcp.md](../../docs/mcp.md).

## Install and build

The package is not published to npm yet; build it from this repository. It needs Node.js 20 or
later.

```sh
cd packages/mcp-server
npm install
npm run build        # compiles src/ to dist/; dist/cli.js is the edgecoder-mcp bin
```

Other scripts: `npm run typecheck` (no output files) and `npm start` (runs `dist/cli.js`, which
waits for an MCP client on stdin/stdout).

Only MCP messages go to stdout; errors and logs go to stderr.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `EDGECODER_URL` | `https://edgecoder.io` | Portal / hosted API base URL. Must be `https://` unless the host is `localhost`, `127.0.0.1` or `[::1]`. |
| `EDGECODER_PORTAL_URL` | none | Fallback for `EDGECODER_URL` when that is unset. |
| `EDGECODER_API_KEY` | none | An `eck_` API key (from the portal's Connect page, or from agent signup). When set, it is the only key used and the server never signs up. |
| `EDGECODER_AGENT_KEY_FILE` | `~/.edgecoder/agent-key` | Where the agent's own signing key (and the API key it obtained) is stored when `EDGECODER_API_KEY` is unset. |
| `EDGECODER_AGENT_NAME` | none (the portal names the API key `agent`) | Display name for a new agent account (1 to 60 characters). |

## Claude Desktop

Add an entry to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "edgecoder": {
      "command": "node",
      "args": ["/path/to/edgecoder/packages/mcp-server/dist/cli.js"],
      "env": {
        "EDGECODER_URL": "https://<your-portal>",
        "EDGECODER_API_KEY": "eck_..."
      }
    }
  }
}
```

Leave out `EDGECODER_API_KEY` to let the server sign up with its own key. Leave out
`EDGECODER_URL` to use the default portal.

## Claude Code

```sh
claude mcp add edgecoder \
  --env EDGECODER_API_KEY=eck_... \
  -- node /path/to/edgecoder/packages/mcp-server/dist/cli.js
```

Or in a project's `.mcp.json`. Do not commit a real key; use environment expansion:

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

## Tools

Each tool calls one route of the hosted API. A failed call returns an MCP error result with the
HTTP status; a 402 adds a hint to top up.

| Tool | Does | Key inputs | Route |
| --- | --- | --- | --- |
| `list_models` | Lists the model ids you can run, including `auto` | none | `GET /v1/models` |
| `chat` | Runs a chat completion; returns the reply, its cost in cSats and where it ran | `prompt` or `messages` (`role`: system/user/assistant, `content`), `system`, `model` (default `auto`), `max_tokens` (1 to 32,768), `temperature` (0 to 2) | `POST /v1/chat/completions` (non-streaming) |
| `balance` | Balance in cSats, earned sats and up to 10 recent ledger entries | none | `GET /v1/account` |
| `topup` | Gets a Lightning invoice (bolt11) that credits the balance once you pay it from your own wallet | `amountSats` (100 to 1,000,000) | `POST /v1/account/topup` |
| `topup_status` | Whether a top-up invoice has been paid and credited | `intentId` (from `topup`) | `GET /v1/account/topup/:intentId` |
| `usage` | Requests, cost and tokens by day and model, plus up to 20 recent records | `days` (1 to 90, default 30) | `GET /v1/account/usage?days=` |
| `reserve_machine` | Reserves one machine of a class for some minutes (paid up front, unused time refunded) | `computeClass` (`cpu`, `apple`, `gpu`, `gpu.dc`), `minutes` (1 to 1,440), `model` (optional: a model the machine must have) | `POST /v1/account/reservations` |
| `list_reservations` | Your reservations and what can be reserved now per class | none | `GET /v1/account/reservations` |
| `cancel_reservation` | Cancels a reservation; unused time is refunded | `reservationId` | `POST /v1/account/reservations/cancel` |

`chat` needs at least one user turn: pass `prompt`, or `messages` that include a `user` message.
The `system` and `prompt` inputs are added before and after `messages`.

## Identity and key storage

With `EDGECODER_API_KEY` set, the server uses that key and nothing else.

Without it, the server keeps an identity in `~/.edgecoder/agent-key` (or `EDGECODER_AGENT_KEY_FILE`):

- On first use it generates a secp256k1 (Nostr-style, x-only) key pair and writes it as JSON. The
  file is written with mode `0600` (and re-`chmod`ed to `0600` on every save); its directory is
  created with mode `0700`.
- It signs up on the portal with that key: `POST /agents/challenge`, then `POST /agents/signup`
  with a BIP-340 Schnorr signature over `sha256(utf8(challenge))`.
- The API key it receives, the portal URL and the account id are saved in the same file. The stored
  API key is reused only for the same portal URL; pointing the server at a different portal signs
  up again there.
- If the portal answers 401 (the key was revoked or rotated elsewhere), the server signs up again
  with the same signing key and retries the call once. Signing up again keeps the same account and
  balance but rotates the API key: every earlier key for that account stops working.

Back up `agent-key`: it is the account. Anyone who has it can mint API keys for the account and
spend its balance.

## License

BUSL-1.1, like the rest of EdgeCoder.
