# IDE Integration

EdgeCoder runs as a local server on your Mac that speaks the **OpenAI API format** — the same protocol every major AI-powered IDE already knows how to talk to. You add it as a custom model in your IDE settings, exactly like you would add any other OpenAI-compatible provider.

No plugin. No extension. Just a base URL.

## How it works

```
Your IDE  ──► POST /v1/chat/completions
                      │
                      ▼
          EdgeCoder Provider Server :4304
                      │
                      ▼
          IntelligentRouter waterfall
         ┌────────────┼─────────────┐
         ▼            ▼             ▼
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

## Available model IDs

When adding EdgeCoder in your IDE, you can choose which routing mode to use by picking a model name:

| Model ID | Behaviour |
|---|---|
| `edgecoder-auto` | IntelligentRouter picks the best route automatically **(recommended)** |
| `edgecoder-local` | Force local Ollama only — never touches swarm |
| `edgecoder-swarm` | Force swarm network — costs credits |

---

## Step 1 — Start the provider server

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

## Step 2 — Add as a custom model in your IDE

### Cursor

1. Open **Cursor Settings** (`⌘,`)
2. Go to **Models**
3. Under the **OpenAI** section, enable **"Override OpenAI Base URL"**
4. Set the base URL to:
   ```
   http://127.0.0.1:4304/v1
   ```
5. Set the API key to any non-empty value (e.g. `edgecoder`) — not validated
6. In the model name field, type `edgecoder-auto` and press Enter to add it
7. Select `edgecoder-auto` as your active model

> Cursor calls `POST /v1/chat/completions` — EdgeCoder handles it natively.

---

### Zed

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

Or use the UI: **Agent Panel** → settings icon → **Add Provider** → OpenAI-compatible → paste the URL.

---

### Continue.dev (VS Code / JetBrains plugin)

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

Or use the in-app config: click the model selector in the Continue sidebar → **Add Model** → **OpenAI-compatible** → fill in the URL and model name.

---

### JetBrains (IntelliJ, PyCharm, WebStorm, etc.)

1. Go to **Settings → Tools → AI Assistant → Models & API keys**
2. Click **Add Model**
3. Select provider: **OpenAI compatible**
4. Set the **API endpoint URL** to:
   ```
   http://127.0.0.1:4304/v1
   ```
5. Enter any API key (e.g. `edgecoder`)
6. Enter model name: `edgecoder-auto`
7. Click **Test Connection** → should return model info
8. Click **Apply**

---

### Windsurf (Codeium)

Windsurf's primary AI is hosted. For custom models, use the **MCP (Model Context Protocol)** server support:

1. Go to **Settings → Cascade → MCP Servers**
2. Add an OpenAI-compatible MCP entry pointing to `http://127.0.0.1:4304/v1`

Alternatively, install Continue.dev alongside Windsurf — it works in any VS Code fork.

---

### Claude Code (Anthropic CLI)

Claude Code is a terminal agent, not a visual editor, so it doesn't add custom models the same way. Instead, you can call the EdgeCoder provider directly from scripts or use it as a tool endpoint.

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

## Routing behaviour

### When does traffic go to swarm?

The router spills to swarm when local Ollama is overloaded (>2 concurrent), too slow (p95 >8s), or unhealthy. Swarm tasks cost credits from your agent account; the fulfilling agent earns them.

### When does Bluetooth-local activate?

When your iPhone is running EdgeCoder with **Bluetooth Local** mode enabled and is connected to your Mac over BT. The inference runs on the phone's llama.cpp model — free, offline, no credits involved.

### Forcing a specific route

Pick the model ID:

| Want | Model ID |
|---|---|
| Always local | `edgecoder-local` |
| Always swarm | `edgecoder-swarm` |
| Smart routing | `edgecoder-auto` |

---

## VS Code / Cursor extension (optional)

A `.vsix` extension is also available if you want extra IDE features beyond the custom model:
- A **right-click context menu** (Run Task / Run Local / Send to Swarm)
- A **keyboard shortcut** (`⌘⇧E`) that sends selected text directly
- A **result webview panel** with Apply to Editor
- A **status bar item** showing live route and concurrency

Install from: `extensions/vscode/edgecoder-0.1.0.vsix` via Extensions panel → `···` → Install from VSIX.

The extension and the custom model work independently — you can use both, or just the custom model approach (simpler for most workflows).

---

## Troubleshooting

### IDE says "connection refused" or "API error"

The provider server isn't running. Start it:
```bash
cd "/path/to/EdgeCoder" && npm run dev:ide
```

### IDE says "model not found"

Make sure you typed the model name exactly: `edgecoder-auto`, `edgecoder-local`, or `edgecoder-swarm`. Verify they appear:
```bash
curl http://127.0.0.1:4304/v1/models
```

### Responses are slow

Check which route was used — look at the `X-EdgeCoder-Route` response header or the `edgecoder.route` field in the JSON. If it's hitting `swarm`, the local model may be overloaded or unhealthy. Verify Ollama is running:
```bash
curl http://127.0.0.1:11434/api/tags
```

### Cursor keeps asking for an OpenAI API key

Enter any non-empty string in the API key field — `edgecoder` works fine. The local server does not validate keys.
