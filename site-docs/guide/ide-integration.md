# IDE Integration

EdgeCoder provides two ways to write code with AI assistance: the **EdgeCoder Desktop App** (the primary, built-in experience) and **external IDE integration** through an OpenAI-compatible endpoint that works with VS Code, Cursor, Zed, JetBrains, Windsurf, and any other editor that supports custom OpenAI providers.

---

## EdgeCoder Desktop App (Primary)

The desktop application is a Tauri + Svelte app that ships as the primary development surface for EdgeCoder. It connects directly to all local services on ports 4301 through 4304 and provides a fully integrated IDE experience without any external configuration.

### Chat-first interface

The default tab is **ChatView** -- a conversational interface with streaming responses and full conversation history. Conversations are persisted in IndexedDB, so your history survives restarts.

Code blocks in chat responses include **"Open in Editor"** buttons that send the snippet directly into the built-in editor.

### Built-in Monaco editor

The **EditorView** tab embeds a Monaco editor (the same engine behind VS Code) with:

- An integrated chat panel for inline code assistance
- A file explorer for navigating your project
- Syntax highlighting for all common languages

You can work entirely within the desktop app -- ask questions in chat, open generated code in the editor, and iterate without switching windows.

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
request ran) and `cSatsSpent` (what it cost, when it ran on the network). Replies from the local
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

### Local router (a local tag or `edgecoder-local`)

A local model ID goes through the local router, in this order:

| Order | Route | Cost | When |
|---|---|---|---|
| 1 | **Bluetooth-local** | Free | `BT_STATUS_URL` is set and an iPhone in Bluetooth Local mode is connected |
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
