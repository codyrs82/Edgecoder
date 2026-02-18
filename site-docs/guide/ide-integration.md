# IDE Integration

EdgeCoder connects your coding editor directly to the local agent runtime. Every request is routed intelligently through a four-tier waterfall: **Bluetooth-local → local Ollama → swarm network → offline stub** — always picking the fastest, cheapest path automatically.

## How it works

```
Your Editor  ──► EdgeCoder Extension
                        │
                        ▼
              Provider Server :4304
                        │
                        ▼
              IntelligentRouter
             ┌──────────┼────────────┐
             ▼          ▼            ▼
        BT-local    ollama-local   swarm
        (free)      (free)        (credits)
```

The **Provider Server** runs locally on your Mac alongside the agent. The **extension** talks to it over `localhost:4304`. The **IntelligentRouter** decides where each task actually runs:

| Priority | Route | Cost | Condition |
|---|---|---|---|
| 1 | **Bluetooth-local** | Free | Nearby iPhone/Mac BT proxy responding on :11435 |
| 2 | **Ollama-local** | Free | Local Ollama healthy, <2 concurrent, p95 <8s |
| 3 | **Swarm** | Credits | Mesh token set; task queued to coordinator |
| 4 | **Edgecoder-local** | Free | Always-on deterministic stub (safety net) |

---

## Step 1 — Start the provider server

Open a terminal in the project root and run:

```bash
cd "/path/to/EdgeCoder"
npm run dev:ide
```

You should see Fastify log:

```
{"level":"info","msg":"Server listening at http://127.0.0.1:4304"}
```

Keep this terminal tab open while using the IDE.

> **Auto-start (optional):** To start the provider server automatically when your Mac boots, add it to the existing `io.edgecoder.runtime` LaunchDaemon or create a new one pointing to `npm run dev:ide`.

---

## Step 2 — Install the extension

### VS Code

1. Open VS Code
2. Press `⌘⇧X` to open the Extensions panel
3. Click the `···` menu (top-right of the panel) → **Install from VSIX…**
4. Navigate to:
   ```
   extensions/vscode/edgecoder-0.1.0.vsix
   ```
5. Click **Install** — VS Code will reload

### Cursor

1. Open Cursor
2. Press `⌘⇧X` to open the Extensions panel
3. Click the `···` menu → **Install from VSIX…**
4. Navigate to the same `.vsix` file above
5. Click **Install**

### Windsurf (Codeium)

Windsurf uses the VS Code extension API and accepts `.vsix` packages:

1. Open Windsurf
2. Open the Extensions panel (`⌘⇧X`)
3. `···` → **Install from VSIX…** → select `edgecoder-0.1.0.vsix`

### Claude Code (Anthropic CLI)

Claude Code is a terminal-based agent, not a VS Code-style editor, so it does not use `.vsix` extensions. Instead, connect it directly to the provider server via its MCP (Model Context Protocol) config or by pointing it at the local HTTP endpoint at `http://127.0.0.1:4304`.

> The EdgeCoder provider server exposes a standard REST API — any tool that can make HTTP POST requests can use it.

---

## Step 3 — Use it

### Keyboard shortcut

Press **`⌘⇧E`** (Mac) or **`Ctrl+Shift+E`** (Windows/Linux) while your cursor is anywhere in a code file. The task is the current selection, or the full file if nothing is selected.

### Right-click context menu

Select any text in a code file, then right-click to see:

- **EdgeCoder: Run Task (auto-route)** — router picks the best backend
- **EdgeCoder: Run on Local Ollama** — force local inference, never touches swarm
- **EdgeCoder: Send to Swarm Network** — force swarm, earns credits for the fulfilling agent

> The right-click options only appear **when text is selected**. Click and drag to select, or use `⌘A` to select all.

### Command Palette

Press `⌘⇧P` and type `EdgeCoder` to see all commands:

| Command | What it does |
|---|---|
| EdgeCoder: Run Task (auto-route) | Smart-route selection to best backend |
| EdgeCoder: Run on Local Ollama | Force local Ollama |
| EdgeCoder: Send to Swarm Network | Force swarm submission |
| EdgeCoder: Show Router Status | Show live routing stats in a notification |

---

## Result panel

After a request completes, a panel opens beside your editor showing:

- **Route badge** — color-coded: 🟢 ollama-local, 🔵 bluetooth-local, 🟡 swarm, ⚪ stub
- **Latency** and credits spent (swarm only)
- **Plan** — what the agent decided to do
- **Generated Code** — with an **Apply to Editor** button that inserts the code at your selection

---

## Status bar

The EdgeCoder status bar item appears in the bottom-right of your editor window. It shows:

```
⊕ EdgeCoder             ← idle, agent offline
⊕ EdgeCoder (1/2) 📶 🌐  ← 1 of 2 slots used, BT + swarm enabled
⊕ EdgeCoder (offline)   ← provider server not running
```

Click it to open the **Show Router Status** panel.

---

## Settings

Open `Settings → Extensions → EdgeCoder` (or search `edgecoder` in settings):

| Setting | Default | Description |
|---|---|---|
| `edgecoder.providerUrl` | `http://127.0.0.1:4304` | URL of the local provider server |
| `edgecoder.defaultLanguage` | `python` | Fallback language when auto-detect fails |
| `edgecoder.autoDetectLanguage` | `true` | Detect language from file extension automatically |
| `edgecoder.showRouteInfo` | `true` | Show route badge in result panel |

---

## Provider server endpoints

The provider server at `:4304` exposes these endpoints directly — useful for scripting or building your own integrations:

```
GET  /health          → { ok: true, ts: <ms> }
GET  /models          → list of available routes and descriptions
GET  /status          → live router internals (latency, concurrency, flags)
POST /run             → auto-routed task
POST /run/local       → force local Ollama
POST /run/swarm       → force swarm submission
```

### POST /run — request body

```json
{
  "task": "Write a function that debounces a callback",
  "language": "javascript",
  "maxTokens": 1024
}
```

### POST /run — response

```json
{
  "plan": "Routed via: ollama-local",
  "generatedCode": "function debounce(fn, delay) { ... }",
  "runResult": { "stdout": "", "stderr": "", "exitCode": 0 },
  "route": "ollama-local",
  "latencyMs": 1240
}
```

For swarm responses, additional fields appear:

```json
{
  "route": "swarm",
  "latencyMs": 8300,
  "creditsSpent": 2,
  "swarmTaskId": "ide-1708123456789"
}
```

---

## Routing behaviour

### When does traffic go to swarm?

The router spills to swarm when local Ollama is:
- **Overloaded** — more than 2 concurrent requests in flight
- **Too slow** — estimated p95 latency exceeds 8 seconds (measured as EMA × 1.8)
- **Unhealthy** — `/api/tags` health check fails

Swarm tasks cost credits from your agent account. The agent that fulfils the task earns those credits.

### When does Bluetooth-local activate?

If `BT_STATUS_URL` is set (e.g. pointing at the Bluetooth transport status sidecar on the Mac) and the status endpoint reports a connected iPhone/Mac, the router sends the request over BT first. This is completely free and works offline.

The iOS app's Bluetooth Local mode (`bluetoothLocal` compute mode) makes the iPhone's llama.cpp model available to the Mac via BT proxy on port 11435.

### Forcing a route

Use the right-click menu or call the endpoint directly:
- Right-click → **Run on Local Ollama** → calls `POST /run/local`
- Right-click → **Send to Swarm Network** → calls `POST /run/swarm`

---

## Troubleshooting

### "EdgeCoder agent is not running"

The extension couldn't reach `:4304`. Fix:

```bash
cd "/path/to/EdgeCoder"
npm run dev:ide
```

### Extension not showing in right-click menu

You must **select text first**. The context menu items only appear when `editorHasSelection` is true.

### The `.vsix` file is not found

Build it yourself from the extensions directory:

```bash
cd extensions/vscode
npm install
npm run compile
npm run package
```

This produces `edgecoder-0.1.0.vsix` in the same directory.

### Language always shows as Python

Open VS Code settings and either:
- Set `edgecoder.defaultLanguage` to `javascript`
- Or ensure `edgecoder.autoDetectLanguage` is `true` and open a `.js`/`.ts` file

### Swarm tasks time out

Swarm tasks poll up to 90 seconds. If the coordinator is unreachable or no agents are available, the router falls back to the edgecoder-local stub. Check `MESH_AUTH_TOKEN` and `COORDINATOR_URL` environment variables on the provider server.

---

## Building the extension from source

```bash
cd extensions/vscode

# Install dev dependencies (TypeScript compiler + vsce)
npm install

# Compile TypeScript → out/extension.js
npm run compile

# Watch mode (auto-recompile on save)
npm run watch

# Package into .vsix
npm run package
```

The compiled output goes to `out/extension.js`. The `.vsix` is a zip archive containing the compiled output and `package.json`.
