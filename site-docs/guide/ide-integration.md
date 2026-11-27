# IDE Integration

EdgeCoder provides two ways to write code with AI assistance: the **EdgeCoder Desktop App** (the primary, built-in experience) and **external IDE integration** through an OpenAI-compatible endpoint that works with VS Code, Cursor, Zed, JetBrains, Windsurf, and any other editor that supports custom OpenAI providers.

---

## EdgeCoder Desktop App (Primary)

The desktop application is a Tauri + Svelte app that ships as the primary development surface for EdgeCoder. It connects directly to all local services on ports 4301 through 4304 and provides a fully integrated IDE experience without any external configuration.

### Chat and Code views

A **Chat / Code** switch sits at the top of the sidebar, above **New chat**. When the sidebar is
hidden, the switch moves to the title bar.

- **Chat** is a conversation with streaming replies and full history.
- **Code** works in a project folder: the agent reads, edits and runs commands there. It has a
  Monaco editor (the engine behind VS Code), a file explorer and a chat panel. Sessions started from
  `edgecoder code`, the iPhone app or the website show here too, with a remote-computer icon.

Chats are kept in IndexedDB, so they survive restarts. Deleting a chat removes it for good, even
the one that is open. If a delete fails, the chat stays and an error says so.

With **Code from your phone** on (Settings), each Code view chat can also be read and continued
from the iPhone app and from **Code** on edgecoder.io. See [iOS app: Code](/guide/ios-app#code).

### Under the message box

| Control | What it does |
| --- | --- |
| Model picker | Where the reply runs. Paid models show a rough cost, such as `~140 cSats per long reply` or `~$0.52 per long reply` on your own key. Picking a premium model for a project chat shows a one-time hint you can dismiss. |
| Permission mode | **Manual**, **Accept edits**, **Auto**, **Plan** or **Full access**. Full access never asks; it needs a one-time confirm per project and is not offered for bits. An approval card also offers **Allow for this session** (later calls of the same kind, named on the card, run without asking until the session ends; kept in memory only) next to **Always allow** for the project. In Auto, scripts it can't check (`python3 - <<'EOF'`, `node -e`, `python3 tools/x.py`) run without asking in a sandbox that writes only in the project and has no network; their output shows a **sandboxed** tag, and if the sandbox blocks one it asks to run it outside (**Settings → General → Sandbox** turns this off). See [permission modes](https://github.com/codyrs82/Edgecoder/blob/main/docs/permission-modes.md#sandboxed-commands). |
| **Helpers** | Turns helper agents on or off for this chat, with how many run at once (default 4) and the chat's budget (default 100 cSats). On by default when the lead is a frontier model on your own key. Easy pieces try a model on this computer first. See [tentacles](https://github.com/codyrs82/Edgecoder/blob/main/docs/tentacles.md). |
| Context meter | Shows the chat's size, for example `context ~42K tokens`. Click it, or type `/compact`, to summarize older messages now. |

### Long and paid replies

| What happens | When |
| --- | --- |
| The chat opens at the latest message and follows a reply while you are near the bottom. Scroll up and a round **Jump to latest** button appears (with a dot when something new arrived). | Always |
| Older messages are summarized on a cheap model. A note says `Earlier messages summarized to save tokens · ~N tokens saved`. | Paid models (your frontier key, network or cloud models): past 80,000 tokens, or 85 % of the model's window if smaller. Free models: past 85 % of the window. Set the paid limit in **Settings → General → Compact long chats at … tokens**. |
| The reply pauses and asks: **Keep going**, **Switch** to a cheaper model (the same reply carries on), or **Stop**. Keep going asks again after the same amount more. With no answer in 10 minutes it stops. | A paid model spent 150 cSats in one reply, or $0.50 on your own key. Set it in **Settings → General → Ask before a reply spends more than …**. Free models and Auto never ask. Bits keep their own budgets. |
| A file read again without changes gets a short pointer instead of the whole file. A note says what was saved, for example `Skipped re-reading 3 unchanged files · ~90K tokens saved`. | Paid models |
| The turn ends with `Stopped after 40 steps without finishing. Reply "continue" to pick up where it left off.` | One reply made 40 model calls |

The environment variables behind these limits are `EDGECODER_COMPACT_PAID_TOKENS`,
`EDGECODER_REPLY_COST_ASK_CSATS` and `EDGECODER_REPLY_COST_ASK_USD`
([environment variables](/reference/environment-variables)).

When the coding agent finds the project wants another Node.js version (`.nvmrc`, `.node-version`,
`.tool-versions`, Volta or `engines`), it is told which version to use and how. A failed install
caused by the wrong version gets a hint with the command rewritten. Nothing runs on its own. This
is off on Windows. Details are in [permission modes: Node versions](https://github.com/codyrs82/Edgecoder/blob/main/docs/permission-modes.md#node-versions).

### Additional pages

Beyond Chat and Editor, the desktop app includes:

| Page | Purpose |
|------|---------|
| Dashboard | Node status, task metrics, mesh health |
| ModelManager | Install, remove, and configure Ollama models |
| MeshTopology | Visual map of connected mesh peers |
| TaskQueue | View and manage queued, running, and completed tasks |
| Credits | Credit balance and transaction history |
| ActiveWork | Currently executing tasks and progress |
| Settings | Configuration for services, models, and network |
| LogViewer | Streaming logs from all services |
| Account | User profile, wallet, passkeys |

### Storage

- **IndexedDB** for conversation persistence
- **localStorage** for user settings and UI state

### Launching the desktop app

```bash
cd "/path/to/EdgeCoder"
npm run desktop
```

The app connects to the local services automatically. Make sure the backend services are running (see [Runtime modes](/reference/runtime-modes) and the [README quickstart](https://github.com/codyrs82/Edgecoder#readme) for details).

---

## External IDE Integration

If you prefer to work in your own editor, EdgeCoder exposes an **OpenAI-compatible endpoint** on port 4304. Any IDE or tool that can talk to the OpenAI API can use EdgeCoder as a backend -- no plugin or extension required, just a base URL.

### How it works

```
Your IDE  --> POST /v1/chat/completions  (model: "auto", "network/...", a local tag, ...)
                      |
                      v
          EdgeCoder Provider Server :4304
                      |
     +----------------+-----------------+------------------+
     v                v                 v                  v
   "auto"        mine/, network/,   frontier/...      a local tag or
 (auto-route)    reserved/          (your own key)    edgecoder-local
                 (pinned place)                       (local router)
```

The provider server at `:4304` accepts standard OpenAI `chat/completions` requests. What happens
next depends on the model ID you pick.

### Available model IDs

`GET /v1/models` lists the IDs this server can run right now: `auto`, this computer's Ollama
models, models on your machines and on the network (when this computer is signed in and connected),
and frontier models your account has a key for.

| Model ID | Where it runs | Cost |
|---|---|---|
| `auto` | **Recommended.** EdgeCoder picks the cheapest place that can do the request well (see [Routing behaviour](#routing-behaviour)) | Free on your machines; cSats on the network |
| A local Ollama tag, e.g. `qwen3-coder:30b` | This computer's Ollama, through the local router | Free |
| `edgecoder-local` | This computer's default local model (`OLLAMA_MODEL`), through the local router | Free |
| `mine/<model>` | Your other machines signed in to your account | Free |
| `network/<model>` or `network/<model>@<class>` | An approved host on the network; `<class>` is `cpu`, `apple`, `gpu` or `gpu.dc` (any class when left out) | cSats, per token by model size |
| `reserved/<reservation-id>/<model>` | A machine you reserved | Already paid by the reservation |
| `frontier/<provider>/<model>` | The provider's API, on your own key | Billed by the provider |

`mine/`, `network/` and `reserved/` IDs need this computer to be signed in to EdgeCoder and
connected to the network (the desktop app's agent); otherwise the server answers `503
network_unavailable`. No model, `""`, `default` and `auto` all mean Auto.

---

### Step 1 -- Start the provider server

Open a terminal in the EdgeCoder project root:

```bash
cd "/path/to/EdgeCoder"
npm run dev:ide
```

Keep this running. You should see:

```
{"level":"info","msg":"Server listening at http://127.0.0.1:4304"}
```

### Security: token, bind address and shell approval

The provider server can read and write your project and run commands, so it is locked down by default (#4).

- **Bind address.** It binds to `127.0.0.1` only. Set `IDE_PROVIDER_HOST` to change this. A non-loopback host is refused unless `IDE_PROVIDER_TOKEN` is set explicitly.
- **Bearer token.** Every route except `GET /health` needs `Authorization: Bearer <token>`.
  - The token comes from `IDE_PROVIDER_TOKEN`, or from `~/.edgecoder/ide-token`.
  - If neither exists, the server creates the file on first start (mode 0600, 32 random bytes, base64url).
  - The VS Code extension reads the file automatically, or uses the `edgecoder.providerToken` setting.
- **Browser and DNS-rebinding protection.** Requests carrying a web `Origin` (`http(s)://…`) get 403. When the server is bound to loopback, so do requests whose `Host` is not `127.0.0.1:4304`, `localhost:4304` or `[::1]:4304`.
  - The desktop webview origins (`tauri://localhost`, `http(s)://tauri.localhost`) are allowed.
  - Add more origins with `IDE_ALLOWED_ORIGINS` (comma-separated).
  - **Desktop in Vite dev mode** runs at `http://localhost:1420`, so start the IDE server with `IDE_ALLOWED_ORIGINS=http://localhost:1420 npm run dev:ide`.
  - The desktop app reads `~/.edgecoder/ide-token` through the Tauri command `get_ide_token`, so the token file is the single source of truth.
- **`run_shell`.** Every shell command needs your approval in the IDE.
  - Commands are parsed into argv and run with `shell: false`, with variables like `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_API_KEY` and `*_PRIVATE_KEY` stripped from the environment.
  - Shell syntax (`;`, `&&`, `|`, backticks, `$(`, redirects) is refused unless approved.
  - Commands get an allowlisted environment only: `PATH`, `HOME`, `USER`, `SHELL`, locale, terminal and temp variables, and `LC_*`. Add names with `IDE_SHELL_ENV_PASS` (comma-separated). Everything else, including every token and secret, is dropped.
  - Without approval, the following are refused:
    - `node`/`python` with inline-code flags (`-e`, `-c`, `-p`, `-m`, `--eval`, …) or with no arguments (REPL)
    - `npx`, `npm exec`, `cargo run` and `go run`
    - binaries given as a path
    - any path argument outside the project root (absolute, `~` or `..`)
    - `git` subcommands that modify anything
  - **Warning:** `IDE_SHELL_AUTO_APPROVE=1` still lets the model run allowlisted tools such as `npm test` or `node script.js`, and those run project code as you. Only enable it for projects you trust.
  - `IDE_SHELL_AUTO_APPROVE=1` (local opt-in) skips the prompt only for allowlisted binaries. The default allowlist is `npm`, `npx`, `node`, `python3`, `pytest`, `git` (read-only subcommands), `ls`, `cat`, `rg` and similar. Override it with `IDE_SHELL_ALLOW` (comma-separated).

### Extension endpoints

The VS Code extension uses these endpoints (#36). The full contract is in `src/apps/ide/routes.ts`.

- `GET /health` (no token)
- `GET /status` (alias of `/v1/router/status`)
- `POST /run`, `POST /run/local` and `POST /run/swarm` with `{ task, language, maxTokens? }`

`/run/swarm` returns `503 { "error": "swarm_unavailable" }` when neither this computer's agent nor `MESH_AUTH_TOKEN` is configured.

---

### Step 2 -- Add as a custom model in your IDE

#### Cursor

1. Open **Cursor Settings** (`Cmd+,`)
2. Go to **Models**
3. Under the **OpenAI** section, enable **"Override OpenAI Base URL"**
4. Set the base URL to:
   ```
   http://127.0.0.1:4304/v1
   ```
5. Set the API key to your IDE token (`cat ~/.edgecoder/ide-token`). It is sent as `Authorization: Bearer <token>` and is required.
6. In the model name field, type `auto` and press Enter to add it
7. Select `auto` as your active model

> Cursor calls `POST /v1/chat/completions` -- EdgeCoder handles it natively.

---

#### Zed

Add to `~/.config/zed/settings.json`:

```json
{
  "language_models": {
    "openai": {
      "api_url": "http://127.0.0.1:4304/v1",
      "available_models": [
        {
          "name": "auto",
          "display_name": "EdgeCoder (Auto)",
          "max_tokens": 8192
        },
        {
          "name": "edgecoder-local",
          "display_name": "EdgeCoder (this computer)",
          "max_tokens": 8192
        }
      ],
      "version": "1"
    }
  },
  "agent": {
    "default_model": {
      "provider": "openai",
      "model": "auto"
    }
  }
}
```

Or use the UI: **Agent Panel** -> settings icon -> **Add Provider** -> OpenAI-compatible -> paste the URL.

---

#### Continue.dev (VS Code / JetBrains plugin)

Add to `~/.continue/config.json`:

```json
{
  "models": [
    {
      "title": "EdgeCoder (Auto)",
      "provider": "openai",
      "model": "auto",
      "apiKey": "<contents of ~/.edgecoder/ide-token>",
      "apiBase": "http://127.0.0.1:4304/v1"
    },
    {
      "title": "EdgeCoder (this computer)",
      "provider": "openai",
      "model": "edgecoder-local",
      "apiKey": "<contents of ~/.edgecoder/ide-token>",
      "apiBase": "http://127.0.0.1:4304/v1"
    }
  ]
}
```

Or use the in-app config: click the model selector in the Continue sidebar -> **Add Model** -> **OpenAI-compatible** -> fill in the URL and model name.

---

#### JetBrains (IntelliJ, PyCharm, WebStorm, etc.)

1. Go to **Settings -> Tools -> AI Assistant -> Models & API keys**
2. Click **Add Model**
3. Select provider: **OpenAI compatible**
4. Set the **API endpoint URL** to:
   ```
   http://127.0.0.1:4304/v1
   ```
5. Enter your IDE token as the API key (`cat ~/.edgecoder/ide-token`); it is required
6. Enter model name: `auto`
7. Click **Test Connection** -- should return model info
8. Click **Apply**

---

#### Windsurf (Codeium)

Windsurf's built-in AI is hosted and does not take a custom OpenAI base URL. Install
Continue.dev in Windsurf (it works in any VS Code fork) and configure it as above.

---

#### Claude Code (Anthropic CLI)

Claude Code is a terminal agent, not a visual editor, so it does not add custom models the same way. Instead, you can call the EdgeCoder provider directly from scripts or use it as a tool endpoint.

For agentic workflows, the REST API at `:4304` is fully scriptable:

```bash
curl -s http://127.0.0.1:4304/v1/chat/completions \
  -H "Authorization: Bearer $(cat ~/.edgecoder/ide-token)" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Write a Python function to debounce a callback"}]
  }' | jq '.choices[0].message.content'
```

---

## Verifying the connection

Test that the server is up and returning models:

```bash
# Health check
curl http://127.0.0.1:4304/health

# Model list (OpenAI format)
curl -H "Authorization: Bearer $(cat ~/.edgecoder/ide-token)" http://127.0.0.1:4304/v1/models | jq '.data[].id'

# Quick inference test
curl -s http://127.0.0.1:4304/v1/chat/completions \
  -H "Authorization: Bearer $(cat ~/.edgecoder/ide-token)" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"say hello"}]}' \
  | jq '.choices[0].message.content, .edgecoder'
```

For `auto` and network models the response includes an `edgecoder` field: `where` (where the
request ran) and `cSatsSpent` (what it cost, when it ran on the network). A reply cut short has
`finish_reason: "length"` (Anthropic `stop_reason: "max_tokens"`) either way, and `edgecoder.cut`
says why: `"max_tokens"` (your cap) or `"deadline"` (the call's time limit; `edgecoder.note` explains).
Replies from the local
router (a local tag or `edgecoder-local`) don't carry it; with `stream: true` they start with a
`route_info` event naming the route.

---

## System-aware chat

All chat requests (both portal and IDE provider) receive a server-injected system prompt that makes the chatbot aware of its own model, installed models, swarm state, routing behavior, and download progress. You can ask "What model are you running?" or "What models are on the network?" and get accurate, real-time answers.

For the IDE provider path, any file-context system messages sent by the editor (e.g. "The user is editing main.py") are preserved and merged after the EdgeCoder system prompt. See the [Model Management guide](/guide/model-management#system-aware-chat-dynamic-system-prompt) for details.

## Download progress

When a model download is in progress, the desktop app displays a slim progress banner in both the Chat and Editor panels. The banner shows the model name, a progress bar, and percentage. You can also query the progress programmatically:

```bash
curl http://127.0.0.1:4301/model/pull/progress
```

## Routing behaviour

### Auto (`auto`)

Auto (`src/inference-api/auto-route.ts`) decides per request:

1. **Size the job.** Does it need tools or a long context (an agent step), or is it a short
   question? That sets the smallest model that will do it well, never below a quality floor
   (7B by default). Harder steps raise the floor (about 14B, then 30B).
2. **Rank the places, cheapest first:** a machine you already reserved (prepaid), this computer
   (free), your other machines (free), then the network (cSats per token; among machine classes
   the fastest comes first, and CPU is skipped for heavy work).
3. **Try them in order.** A place that can't start falls through to the next. If no free place
   fits and the network can't take the request (not connected, no cSats, or a budget or policy
   that keeps to free machines), the biggest free model answers, marked as a fallback with the
   reason.

On the network, Auto can hand the choice to the coordinator's **best fit**, which picks the model
and the machine. Best fit may use a cloud model (DeepSeek V4.1 Flash, or GLM-5.3 for the hardest
work) when a job wants the network's top tier or no other machine can run it. When nothing on the
network fits, the error says why, for example the model size and tools the job needs. See
[the cloud host doc](https://github.com/codyrs82/Edgecoder/blob/main/docs/cloud-host.md#auto-routing).

### Local router (a local tag or `edgecoder-local`)

A local model ID goes through the local router, in this order:

| Order | Route | Cost | When |
|---|---|---|---|
| 1 | **Bluetooth-local** | Free | `BT_STATUS_URL` is set and a phone is connected through `edgecoder-ble-proxy`. The current iOS app does not offer this mode, so in practice this step is skipped |
| 2 | **Ollama-local** | Free | Local Ollama is healthy, fewer than 2 requests in flight, p95 latency under 8 s |
| 3 | **Network** | cSats | Local is unavailable or overloaded, and this computer's agent (or a mesh token) is configured |
| 4 | **Offline message** | Free | Nothing else is reachable: the reply says Ollama is not running and the network is unreachable |

### Forcing a specific place

Pick the model ID:

| Want | Model ID |
|---|---|
| Let EdgeCoder choose | `auto` |
| This computer | a local tag, or `edgecoder-local` |
| Your other machines | `mine/<model>` |
| The network | `network/<model>` or `network/<model>@<class>` |
| A machine you reserved | `reserved/<reservation-id>/<model>` |

---

## Troubleshooting

### IDE says "connection refused" or "API error"

The provider server is not running. Start it:
```bash
cd "/path/to/EdgeCoder" && npm run dev:ide
```

### IDE says "model not found"

Make sure you typed the model ID exactly as `GET /v1/models` lists it (`auto`, a local tag, `mine/…`, `network/…`). Verify:
```bash
curl -H "Authorization: Bearer $(cat ~/.edgecoder/ide-token)" http://127.0.0.1:4304/v1/models
```

### Responses are slow

Check where the request ran: the `edgecoder.where` field for `auto` and network models, or the `route_info` event at the start of a streamed local-router reply. If a local model ID is going to the network, the local model may be overloaded or unhealthy. Verify Ollama is running:
```bash
curl http://127.0.0.1:11434/api/tags
```

### Cursor keeps asking for an OpenAI API key

Enter your IDE token (`~/.edgecoder/ide-token`) in the API key field. The server rejects requests without it (401).

### Desktop app cannot connect to services

Make sure the backend services are running. The desktop app expects the coordinator on port 4301, inference on 4302, control plane on 4303, and the IDE provider on 4304. Start all services:
```bash
cd "/path/to/EdgeCoder" && npm run dev
```
