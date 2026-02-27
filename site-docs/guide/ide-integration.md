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

The app connects to the local services automatically. Make sure the backend services are running (see the [quickstart guide](/guide/quickstart) for details).

---

## External IDE Integration

If you prefer to work in your own editor, EdgeCoder exposes an **OpenAI-compatible endpoint** on port 4304. Any IDE or tool that can talk to the OpenAI API can use EdgeCoder as a backend -- no plugin or extension required, just a base URL.

### How it works

```
Your IDE  --> POST /v1/chat/completions
                      |
                      v
          EdgeCoder Provider Server :4304
                      |
                      v
          IntelligentRouter waterfall
         +------------+-------------+
         v            v             v
    BT-local     ollama-local    swarm
    (free)       (free)         (credits)
```

The provider server at `:4304` accepts standard OpenAI `chat/completions` requests and routes them through IntelligentRouter automatically:

| Priority | Route | Cost | When |
|---|---|---|---|
| 1 | **Bluetooth-local** | Free | iPhone in BT Local mode + connected |
| 2 | **Ollama-local** | Free | Local Ollama healthy, <2 concurrent, p95 <8s |
| 3 | **Swarm** | Credits | Mesh token set, local overloaded or slow |
| 4 | **Edgecoder-local** | Free | Always-on stub safety net |

### Available model IDs

When adding EdgeCoder in your IDE, you can choose which routing mode to use by picking a model name:

| Model ID | Behaviour |
|---|---|
| `edgecoder-auto` | IntelligentRouter picks the best route automatically **(recommended)** |
| `edgecoder-local` | Force local Ollama only -- never touches swarm |
| `edgecoder-swarm` | Force swarm network -- costs credits |

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
5. Set the API key to any non-empty value (e.g. `edgecoder`) -- not validated
6. In the model name field, type `edgecoder-auto` and press Enter to add it
7. Select `edgecoder-auto` as your active model

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
          "name": "edgecoder-auto",
          "display_name": "EdgeCoder (auto-route)",
          "max_tokens": 8192
        },
        {
          "name": "edgecoder-local",
          "display_name": "EdgeCoder (local only)",
          "max_tokens": 8192
        }
      ],
      "version": "1"
    }
  },
  "agent": {
    "default_model": {
      "provider": "openai",
      "model": "edgecoder-auto"
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
      "title": "EdgeCoder (auto-route)",
      "provider": "openai",
      "model": "edgecoder-auto",
      "apiKey": "edgecoder",
      "apiBase": "http://127.0.0.1:4304/v1"
    },
    {
      "title": "EdgeCoder (local only)",
      "provider": "openai",
      "model": "edgecoder-local",
      "apiKey": "edgecoder",
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
5. Enter any API key (e.g. `edgecoder`)
6. Enter model name: `edgecoder-auto`
7. Click **Test Connection** -- should return model info
8. Click **Apply**

---

#### Windsurf (Codeium)

Windsurf's primary AI is hosted. For custom models, use the **MCP (Model Context Protocol)** server support:

1. Go to **Settings -> Cascade -> MCP Servers**
2. Add an OpenAI-compatible MCP entry pointing to `http://127.0.0.1:4304/v1`

Alternatively, install Continue.dev alongside Windsurf -- it works in any VS Code fork.

---

#### Claude Code (Anthropic CLI)

Claude Code is a terminal agent, not a visual editor, so it does not add custom models the same way. Instead, you can call the EdgeCoder provider directly from scripts or use it as a tool endpoint.

For agentic workflows, the REST API at `:4304` is fully scriptable:

```bash
curl -s http://127.0.0.1:4304/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "edgecoder-auto",
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
curl http://127.0.0.1:4304/v1/models | jq '.data[].id'

# Quick inference test
curl -s http://127.0.0.1:4304/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"edgecoder-auto","messages":[{"role":"user","content":"say hello"}]}' \
  | jq '.choices[0].message.content, .edgecoder'
```

The response includes an `edgecoder` field with `route` and `latencyMs` so you can see which backend handled the request.

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

### When does traffic go to swarm?

The router spills to swarm when local Ollama is overloaded (>2 concurrent), too slow (p95 >8s), or unhealthy. Swarm tasks cost credits from your agent account; the fulfilling agent earns them.

### When does Bluetooth-local activate?

When your iPhone is running EdgeCoder with **Bluetooth Local** mode enabled and is connected to your Mac over BT. The inference runs on the phone's llama.cpp model -- free, offline, no credits involved.

### Forcing a specific route

Pick the model ID:

| Want | Model ID |
|---|---|
| Always local | `edgecoder-local` |
| Always swarm | `edgecoder-swarm` |
| Smart routing | `edgecoder-auto` |

---

## Troubleshooting

### IDE says "connection refused" or "API error"

The provider server is not running. Start it:
```bash
cd "/path/to/EdgeCoder" && npm run dev:ide
```

### IDE says "model not found"

Make sure you typed the model name exactly: `edgecoder-auto`, `edgecoder-local`, or `edgecoder-swarm`. Verify they appear:
```bash
curl http://127.0.0.1:4304/v1/models
```

### Responses are slow

Check which route was used -- look at the `X-EdgeCoder-Route` response header or the `edgecoder.route` field in the JSON. If it is hitting `swarm`, the local model may be overloaded or unhealthy. Verify Ollama is running:
```bash
curl http://127.0.0.1:11434/api/tags
```

### Cursor keeps asking for an OpenAI API key

Enter any non-empty string in the API key field -- `edgecoder` works fine. The local server does not validate keys.

### Desktop app cannot connect to services

Make sure the backend services are running. The desktop app expects the coordinator on port 4301, inference on 4302, control plane on 4303, and the IDE provider on 4304. Start all services:
```bash
cd "/path/to/EdgeCoder" && npm run dev
```
