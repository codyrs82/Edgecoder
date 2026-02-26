# IDE Extensions Implementation Plan

**Date**: 2026-02-25
**Status**: Draft
**Relates to**: EDGECODER_PLAN.md Section 9 (User Interfaces), Phase 4 (IDE Connectivity)

---

## 1. Overview

EdgeCoder exposes a local provider server (`src/apps/ide/provider-server.ts`) on port 4304 that implements the OpenAI-compatible Chat Completions API. This plan defines the implementation of IDE extensions for three editor families so that users can consume EdgeCoder completions, chat, and inline suggestions directly from their editors.

### Target IDEs

| IDE Family | Extension Type | Priority |
|---|---|---|
| VS Code / Cursor | VS Code extension (.vsix) | P0 — ship first |
| JetBrains (IntelliJ, WebStorm, PyCharm, etc.) | IntelliJ Platform Plugin (.zip) | P1 |
| Neovim | Lua plugin (lazy.nvim / packer compatible) | P1 |

### API Surface (provider-server.ts, port 4304)

All extensions connect to the same local HTTP server. The relevant endpoints are:

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/models` | GET | List available models (returns `OpenAiModelsResponse`) |
| `/v1/chat/completions` | POST | Chat completions, streaming or non-streaming |
| `/v1/router/status` | GET | Router health, latency, concurrency, route metadata |

**Request schema** (`/v1/chat/completions`):

```typescript
{
  model: string           // default: "edgecoder-local"
  messages: Array<{
    role: string          // "system" | "user" | "assistant"
    content: string
  }>
  stream?: boolean        // default: false
  temperature?: number
  max_tokens?: number
}
```

**Streaming**: Server-Sent Events (SSE) format. The first event carries `route_info` metadata (route, label, model, latency, concurrency). Subsequent events follow the standard OpenAI `chat.completion.chunk` shape. The stream terminates with `data: [DONE]`.

**Non-streaming**: Standard `chat.completion` JSON response.

**Route labels**: Responses include routing provenance — `"local model"`, `"nearby device"` (Bluetooth), `"swarm network"`, or `"offline"` (deterministic stub). Extensions should surface this to the user.

---

## 2. Directory Structure

All extensions live under a new top-level `extensions/` directory. Each extension is an independent buildable/publishable package.

```
extensions/
  vscode/                          # VS Code / Cursor extension
    .vscode/
      launch.json                  # Extension debug launch config
    src/
      extension.ts                 # Activation entry point
      provider.ts                  # OpenAI-compat client (shared HTTP layer)
      completion-provider.ts       # InlineCompletionItemProvider
      chat-provider.ts             # Chat panel (webview or ChatParticipant API)
      status-bar.ts                # Status bar: model, route, health
      configuration.ts             # Reads VS Code settings, exports typed config
      diagnostics.ts               # Health checks, connection validation
      commands.ts                  # Command palette registrations
    test/
      provider.test.ts
      completion-provider.test.ts
    package.json                   # Extension manifest (contributes, activationEvents)
    tsconfig.json
    esbuild.config.mjs             # Bundle for .vsix
    README.md
    CHANGELOG.md

  jetbrains/                       # JetBrains (IntelliJ Platform) plugin
    src/main/
      kotlin/io/edgecoder/plugin/
        EdgeCoderPlugin.kt         # Plugin lifecycle
        EdgeCoderClient.kt         # HTTP client for provider-server
        EdgeCoderCompletionProvider.kt   # CompletionContributor
        EdgeCoderInlineProvider.kt       # InlineCompletionProvider (2024.2+ API)
        EdgeCoderChatToolWindow.kt       # Tool window for chat panel
        EdgeCoderStatusWidget.kt         # Status bar widget
        EdgeCoderSettings.kt             # Persistent settings (endpoint, model, etc.)
      resources/
        META-INF/
          plugin.xml               # Plugin descriptor
        messages/
          EdgeCoderBundle.properties
    src/test/
      kotlin/io/edgecoder/plugin/
        EdgeCoderClientTest.kt
    build.gradle.kts               # Gradle build with IntelliJ Platform Plugin
    gradle.properties
    settings.gradle.kts

  neovim/                          # Neovim plugin
    lua/
      edgecoder/
        init.lua                   # Plugin setup, commands, keymaps
        client.lua                 # HTTP client (curl or plenary.curl)
        completion.lua             # nvim-cmp source or built-in omnifunc
        chat.lua                   # Split-buffer chat UI
        inline.lua                 # Virtual-text inline suggestions
        config.lua                 # User configuration with defaults
        health.lua                 # :checkhealth edgecoder
        status.lua                 # Lualine / statusline component
    plugin/
      edgecoder.vim                # Vim autoload bootstrap (optional)
    doc/
      edgecoder.txt                # Vim help file
    tests/
      minimal_init.lua
      client_spec.lua
    README.md
```

---

## 3. Discovery and Connection

### 3.1 How each extension finds the provider server

The provider server binds to `0.0.0.0:4304` by default. All extensions use the same discovery logic:

1. **User-configured endpoint** (highest priority): The user can explicitly set the endpoint URL in extension settings. This is the only option for non-default ports or remote agents.

2. **Default localhost**: If no explicit setting, try `http://127.0.0.1:4304/v1/models`. If the response is a valid `OpenAiModelsResponse` with `owned_by: "edgecoder"`, the server is confirmed.

3. **Health polling**: On activation (and periodically every 30 seconds), the extension calls `GET /v1/router/status` to check health and update the status bar. If the server goes down, the extension shows a degraded state and stops offering completions until the server is back.

### 3.2 Startup sequence (all extensions)

```
Extension activates
  -> Read endpoint from settings (or use default 127.0.0.1:4304)
  -> GET /v1/models to verify connectivity
  -> If success: populate model picker, enable features, show status bar
  -> If failure: show "EdgeCoder: Not connected" in status bar, offer retry
  -> Start background health poll (GET /v1/router/status every 30s)
```

### 3.3 Connection to Cursor's "Add Model" flow

Cursor supports adding custom OpenAI-compatible endpoints. For Cursor users, EdgeCoder can work without a dedicated extension: the user opens Cursor settings, selects "Add Model," enters `http://127.0.0.1:4304/v1` as the base URL, and selects a model from the list. The dedicated VS Code extension provides richer UX (route labels, status bar, chat panel) but Cursor's native flow is a zero-install option.

---

## 4. Authentication

### 4.1 Current state

The provider server at `src/apps/ide/provider-server.ts` does **not** enforce authentication. It binds to `0.0.0.0:4304` and accepts unauthenticated requests. This is appropriate for a local-only server.

### 4.2 Planned approach

Extensions should be designed to support an optional API key header from the start, even though it is not currently enforced:

- **Header**: `Authorization: Bearer <token>` (standard OpenAI convention).
- **Setting**: Each extension exposes an optional `edgecoder.apiKey` setting. If blank, no header is sent.
- **Server-side**: When the provider server adds optional auth (planned in EDGECODER_PLAN.md Section 18: "IDE requires local agent"), the extensions will already support it without code changes.

### 4.3 Security considerations

- The server currently binds `0.0.0.0`, which means it is reachable from the local network. The plan should add a `--bind 127.0.0.1` option to restrict to localhost-only for security-conscious users. Extensions should document this.
- No secrets are embedded in the extension packages. The API key (if any) is stored in the IDE's native secret/settings storage (VS Code `SecretStorage`, JetBrains `PasswordSafe`, Neovim environment variable or encrypted config).

---

## 5. Features

### 5.1 Code Completion (inline / ghost text)

**How it works**: The extension intercepts the editor's typing events, constructs a chat message with context (current file content, cursor position, language), sends a streaming request to `/v1/chat/completions`, and renders the response as inline ghost text that the user can accept with Tab.

**System prompt for completions**:

```
You are an inline code completion engine. Given the code context, suggest the most likely next line(s) of code. Output ONLY the code to insert, no explanation, no markdown fences.
```

**Message construction**:

```json
{
  "model": "<user-selected or edgecoder-local>",
  "messages": [
    { "role": "system", "content": "<completion system prompt>" },
    { "role": "user", "content": "File: example.py\nLanguage: python\nPrefix:\n```\n<code before cursor>\n```\nSuffix:\n```\n<code after cursor>\n```\nComplete the code at the cursor position." }
  ],
  "stream": true,
  "temperature": 0.2,
  "max_tokens": 256
}
```

**Debouncing**: Completions fire after 300ms of typing inactivity (configurable). Intermediate requests are cancelled.

**Cancellation**: If the user continues typing, the in-flight SSE stream is aborted via `AbortController` (VS Code/Node), HTTP client cancellation (JetBrains), or `curl` process kill (Neovim).

| IDE | API Used |
|---|---|
| VS Code / Cursor | `InlineCompletionItemProvider` (native ghost text API) |
| JetBrains | `InlineCompletionProvider` (2024.2+) or `CompletionContributor` with custom rendering |
| Neovim | `nvim-cmp` source (via `complete()` callback) or `vim.lsp.buf.completion` adapter; inline ghost text via virtual text extmarks |

### 5.2 Chat Panel

A conversational interface for multi-turn interactions with the EdgeCoder agent.

**Message flow**: User types a question -> extension sends to `/v1/chat/completions` with full conversation history -> streamed response renders in the panel.

**Route metadata**: The first SSE event in a streaming response contains `route_info` with `{ route, label, model, p95Ms, concurrent }`. The chat panel should display a subtle badge showing where the response was routed (e.g., "via local model" or "via swarm network").

| IDE | Implementation |
|---|---|
| VS Code / Cursor | Webview panel with HTML/CSS/JS (or the Chat Participant API if targeting VS Code 1.93+). Webview communicates with the extension host via `postMessage`. |
| JetBrains | Tool window (`ToolWindowFactory`) with a JBCef browser panel or Swing-based Markdown renderer. |
| Neovim | Split buffer with syntax highlighting for Markdown. Input via a command-line prompt (`:EdgeCoderChat`) or a floating window. Streaming tokens append to the buffer in real time. |

**Chat context enrichment**: The chat panel should support `/file` and `/selection` context commands that inject the current file or selected text into the next message as a user message prefix.

### 5.3 Inline Suggestions (FIM — Fill-in-the-Middle)

A more advanced form of completion where the model sees both prefix and suffix around the cursor. This uses the same `/v1/chat/completions` endpoint but with a specially constructed prompt that includes code before and after the cursor.

This is structurally identical to Section 5.1 but triggers differently:
- Completions trigger on pause after typing.
- Inline suggestions can also trigger on explicit invocation (e.g., `Ctrl+Shift+Space` or `:EdgeCoderSuggest`).

### 5.4 Model Picker

Each extension should expose a model selection UI that:

1. Calls `GET /v1/models` to fetch available models.
2. Displays a picker (VS Code QuickPick, JetBrains ComboBox, Neovim Telescope/fzf-lua).
3. Persists the selected model in settings.
4. Uses the selected model ID in all subsequent requests.

Available models from the current provider registry: `edgecoder-local`, `ollama-local`, `ollama-edge`, `ollama-coordinator`.

### 5.5 Status Bar

A persistent status indicator showing:

- **Connection state**: Connected / Disconnected / Connecting
- **Active model**: The currently selected model name
- **Route label**: From the last response's `route_info` (e.g., "local model", "swarm")
- **Health metrics**: Latency P95, active concurrency (from `/v1/router/status`)

Clicking the status bar opens the model picker or a quick-action menu.

---

## 6. VS Code / Cursor Extension — Detailed Design

### 6.1 Extension Manifest (`package.json`)

Key `contributes` sections:

```jsonc
{
  "contributes": {
    "configuration": {
      "title": "EdgeCoder",
      "properties": {
        "edgecoder.endpoint": {
          "type": "string",
          "default": "http://127.0.0.1:4304",
          "description": "EdgeCoder provider server URL"
        },
        "edgecoder.model": {
          "type": "string",
          "default": "edgecoder-local",
          "description": "Model to use for completions and chat"
        },
        "edgecoder.completion.enabled": {
          "type": "boolean",
          "default": true,
          "description": "Enable inline code completions"
        },
        "edgecoder.completion.debounceMs": {
          "type": "number",
          "default": 300,
          "description": "Debounce delay for completion requests (ms)"
        },
        "edgecoder.completion.maxTokens": {
          "type": "number",
          "default": 256,
          "description": "Maximum tokens for completion responses"
        },
        "edgecoder.completion.temperature": {
          "type": "number",
          "default": 0.2,
          "description": "Temperature for completion requests"
        },
        "edgecoder.chat.temperature": {
          "type": "number",
          "default": 0.7,
          "description": "Temperature for chat requests"
        },
        "edgecoder.apiKey": {
          "type": "string",
          "default": "",
          "description": "Optional API key for authenticated endpoints"
        }
      }
    },
    "commands": [
      { "command": "edgecoder.chat", "title": "EdgeCoder: Open Chat" },
      { "command": "edgecoder.selectModel", "title": "EdgeCoder: Select Model" },
      { "command": "edgecoder.showStatus", "title": "EdgeCoder: Show Router Status" },
      { "command": "edgecoder.restart", "title": "EdgeCoder: Reconnect" }
    ],
    "viewsContainers": {
      "activitybar": [
        { "id": "edgecoder", "title": "EdgeCoder", "icon": "media/icon.svg" }
      ]
    },
    "views": {
      "edgecoder": [
        { "type": "webview", "id": "edgecoder.chatView", "name": "Chat" }
      ]
    }
  },
  "activationEvents": ["onStartupFinished"]
}
```

### 6.2 Build and Packaging

- **Bundler**: esbuild (fast, single-file output).
- **Output**: `dist/extension.js` (CommonJS for VS Code host).
- **Package**: `vsce package` produces a `.vsix` file.
- **CI**: GitHub Actions workflow that runs tests, bundles, and publishes to the VS Code Marketplace and Open VSX Registry.
- **Cursor compatibility**: VS Code extensions work in Cursor without changes. Test in both.

### 6.3 Activation

```typescript
// extension.ts
export async function activate(context: vscode.ExtensionContext) {
  const config = readConfiguration();
  const client = new EdgeCoderClient(config);

  // Verify server connectivity
  const connected = await client.checkHealth();

  // Register inline completion provider
  const completionProvider = new EdgeCoderCompletionProvider(client, config);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      completionProvider
    )
  );

  // Register chat webview
  const chatProvider = new EdgeCoderChatProvider(client, context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("edgecoder.chatView", chatProvider)
  );

  // Register status bar
  const statusBar = new EdgeCoderStatusBar(client);
  context.subscriptions.push(statusBar);

  // Register commands
  registerCommands(context, client, chatProvider, statusBar);

  // Start health polling
  startHealthPoll(client, statusBar, 30_000);
}
```

### 6.4 Cursor-specific notes

- Cursor already has a built-in "Add Model" UI that accepts OpenAI-compatible endpoints. Users can point this at `http://127.0.0.1:4304/v1` with no extension needed.
- The dedicated extension adds value beyond native Cursor support: route labels in status bar, chat panel with routing metadata, model picker integrated with EdgeCoder's provider registry, and health monitoring.
- If Cursor exposes its own extension APIs for model providers in the future, the extension should adopt those APIs for tighter integration.

---

## 7. JetBrains Plugin — Detailed Design

### 7.1 Plugin Descriptor (`plugin.xml`)

```xml
<idea-plugin>
  <id>io.edgecoder.plugin</id>
  <name>EdgeCoder</name>
  <vendor>EdgeCoder</vendor>
  <depends>com.intellij.modules.platform</depends>

  <extensions defaultExtensionNs="com.intellij">
    <applicationConfigurable
      instance="io.edgecoder.plugin.EdgeCoderSettings"
      displayName="EdgeCoder" />
    <statusBarWidgetFactory
      implementation="io.edgecoder.plugin.EdgeCoderStatusWidgetFactory" />
    <completion.contributor
      language="any"
      implementationClass="io.edgecoder.plugin.EdgeCoderCompletionProvider" />
    <toolWindow
      id="EdgeCoder Chat"
      anchor="right"
      factoryClass="io.edgecoder.plugin.EdgeCoderChatToolWindowFactory" />
    <notificationGroup
      id="EdgeCoder Notifications"
      displayType="BALLOON" />
  </extensions>

  <actions>
    <action id="edgecoder.selectModel"
      class="io.edgecoder.plugin.SelectModelAction"
      text="EdgeCoder: Select Model" />
    <action id="edgecoder.openChat"
      class="io.edgecoder.plugin.OpenChatAction"
      text="EdgeCoder: Open Chat" />
  </actions>
</idea-plugin>
```

### 7.2 HTTP Client

Use `java.net.http.HttpClient` (Java 11+) for the HTTP layer. Streaming uses the reactive `BodyHandlers.ofLines()` subscriber for SSE.

```kotlin
class EdgeCoderClient(private val settings: EdgeCoderSettings) {
    private val httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build()

    fun chatCompletion(messages: List<ChatMessage>, stream: Boolean): Flow<String> {
        // POST to /v1/chat/completions, parse SSE chunks
    }

    fun listModels(): List<ModelInfo> {
        // GET /v1/models
    }

    fun routerStatus(): RouterStatus {
        // GET /v1/router/status
    }
}
```

### 7.3 Inline Completion

For JetBrains 2024.2+, use the `InlineCompletionProvider` API which supports native ghost text rendering:

```kotlin
class EdgeCoderInlineProvider : InlineCompletionProvider {
    override suspend fun getSuggestion(request: InlineCompletionRequest): InlineCompletionSuggestion {
        // Build prompt from editor context (prefix/suffix around caret)
        // Call /v1/chat/completions with stream=true
        // Return InlineCompletionSuggestion with the streamed text
    }
}
```

For older JetBrains versions, fall back to `CompletionContributor` which renders in the standard completion popup.

### 7.4 Build and Packaging

- **Build system**: Gradle with `org.jetbrains.intellij.platform` plugin.
- **Language**: Kotlin (idiomatic for IntelliJ plugins).
- **Target platform**: IntelliJ Platform 2024.1+ (covers IntelliJ IDEA, WebStorm, PyCharm, GoLand, CLion, etc.).
- **Output**: Plugin ZIP via `./gradlew buildPlugin`.
- **Distribution**: JetBrains Marketplace upload via `./gradlew publishPlugin`.
- **CI**: GitHub Actions with `actions/setup-java`, Gradle build, and marketplace publish step.

### 7.5 Settings Persistence

Use IntelliJ's `PersistentStateComponent` for settings:

```kotlin
@State(name = "EdgeCoderSettings", storages = [Storage("edgecoder.xml")])
class EdgeCoderSettings : PersistentStateComponent<EdgeCoderSettings.State> {
    data class State(
        var endpoint: String = "http://127.0.0.1:4304",
        var model: String = "edgecoder-local",
        var completionEnabled: Boolean = true,
        var completionDebounceMs: Int = 300,
        var completionMaxTokens: Int = 256,
        var completionTemperature: Double = 0.2,
        var chatTemperature: Double = 0.7,
        var apiKey: String = ""   // stored via PasswordSafe in production
    )
}
```

---

## 8. Neovim Plugin — Detailed Design

### 8.1 Plugin Structure

The plugin uses pure Lua and targets Neovim 0.9+. It integrates with the Neovim ecosystem through standard conventions.

### 8.2 Setup and Configuration

```lua
-- lua/edgecoder/init.lua
local M = {}

M.setup = function(opts)
  local config = require("edgecoder.config")
  config.set(vim.tbl_deep_extend("force", config.defaults, opts or {}))

  -- Register commands
  vim.api.nvim_create_user_command("EdgeCoderChat", function() require("edgecoder.chat").open() end, {})
  vim.api.nvim_create_user_command("EdgeCoderModels", function() require("edgecoder.completion").pick_model() end, {})
  vim.api.nvim_create_user_command("EdgeCoderStatus", function() require("edgecoder.status").show() end, {})
  vim.api.nvim_create_user_command("EdgeCoderSuggest", function() require("edgecoder.inline").trigger() end, {})

  -- Start health poll
  require("edgecoder.status").start_poll()
end

return M
```

**User configuration** (in `init.lua` or `lazy.nvim` spec):

```lua
require("edgecoder").setup({
  endpoint = "http://127.0.0.1:4304",
  model = "edgecoder-local",
  completion = {
    enabled = true,
    debounce_ms = 300,
    max_tokens = 256,
    temperature = 0.2,
  },
  chat = {
    temperature = 0.7,
    split = "vertical",  -- "vertical", "horizontal", "float"
  },
  api_key = "",  -- optional
  keymaps = {
    accept_suggestion = "<Tab>",
    dismiss_suggestion = "<Esc>",
    open_chat = "<leader>ec",
    select_model = "<leader>em",
  },
})
```

### 8.3 HTTP Client

Two strategies, chosen based on available dependencies:

1. **plenary.nvim** (if available): Use `plenary.curl` for async HTTP requests. Plenary is widely installed as a dependency of telescope.nvim and other popular plugins.

2. **vim.system / curl fallback**: Use `vim.system()` (Neovim 0.10+) or `vim.fn.jobstart()` with `curl` for streaming SSE. This avoids hard dependencies.

Streaming implementation:

```lua
-- Spawn curl in streaming mode, read chunks via stdout callback
local function stream_chat(messages, on_chunk, on_done)
  local body = vim.fn.json_encode({
    model = config.get().model,
    messages = messages,
    stream = true,
    temperature = config.get().chat.temperature,
  })

  vim.system({
    "curl", "-s", "-N",
    "-H", "Content-Type: application/json",
    "-H", "Authorization: Bearer " .. (config.get().api_key or ""),
    "-d", body,
    config.get().endpoint .. "/v1/chat/completions",
  }, {
    stdout = function(_, data)
      -- Parse SSE lines, extract content deltas, call on_chunk
    end,
  }, function()
    on_done()
  end)
end
```

### 8.4 Completion Integration

**nvim-cmp source** (recommended for users who have nvim-cmp):

```lua
-- lua/edgecoder/completion.lua
local source = {}

function source:complete(params, callback)
  local context = build_context(params)
  client.chat_completion(context.messages, function(result)
    callback({
      items = {{ label = result.text, kind = vim.lsp.protocol.CompletionItemKind.Text }},
    })
  end)
end

-- Register with nvim-cmp
require("cmp").register_source("edgecoder", source)
```

**Inline ghost text** (for users without nvim-cmp or who prefer ghost text):

```lua
-- Use extmarks with virt_text to show inline suggestions
local ns = vim.api.nvim_create_namespace("edgecoder_inline")

local function show_suggestion(bufnr, line, col, text)
  vim.api.nvim_buf_set_extmark(bufnr, ns, line, col, {
    virt_text = {{ text, "Comment" }},
    virt_text_pos = "overlay",
  })
end
```

### 8.5 Chat Buffer

The chat UI is a scratch buffer with Markdown syntax highlighting:

- `:EdgeCoderChat` opens a vertical split (or floating window) with a scratch buffer.
- User input is collected via `vim.fn.input()` or a prompt buffer at the bottom of the split.
- Streaming tokens are appended to the buffer in real time using `nvim_buf_set_lines`.
- Route metadata from the first SSE event is displayed as a comment line (e.g., `-- [via local model, qwen2.5-coder:latest, p95: 1200ms]`).

### 8.6 Health Check

Implement `:checkhealth edgecoder` for diagnostics:

```lua
-- lua/edgecoder/health.lua
local M = {}

M.check = function()
  vim.health.start("EdgeCoder")

  -- Check endpoint connectivity
  local ok, models = pcall(client.list_models)
  if ok then
    vim.health.ok("Connected to " .. config.get().endpoint)
    vim.health.info("Available models: " .. table.concat(models, ", "))
  else
    vim.health.error("Cannot reach EdgeCoder at " .. config.get().endpoint,
      { "Ensure the provider server is running: npm run dev:ide",
        "Check endpoint setting in setup()" })
  end

  -- Check router status
  local ok2, status = pcall(client.router_status)
  if ok2 then
    vim.health.ok("Router healthy: p95=" .. status.localLatencyP95Ms .. "ms, concurrent=" .. status.activeConcurrent)
  end

  -- Check curl availability
  if vim.fn.executable("curl") == 1 then
    vim.health.ok("curl found")
  else
    vim.health.error("curl not found", { "Install curl for HTTP requests" })
  end
end

return M
```

### 8.7 Statusline Component

Expose a function that statusline plugins (lualine, etc.) can call:

```lua
-- lua/edgecoder/status.lua
function M.statusline()
  if not state.connected then return "EC: --" end
  return string.format("EC: %s [%s]", state.model, state.route_label or "local")
end
```

### 8.8 Distribution

- **lazy.nvim** (recommended):
  ```lua
  { "edgecoder/edgecoder.nvim", config = function() require("edgecoder").setup() end }
  ```
- **packer.nvim**:
  ```lua
  use { "edgecoder/edgecoder.nvim", config = function() require("edgecoder").setup() end }
  ```
- No compiled dependencies. Pure Lua + curl.
- Optional dependency: `plenary.nvim` (for async HTTP), `nvim-cmp` (for completion integration), `telescope.nvim` (for model picker).

---

## 9. Configuration Options (All Extensions)

All extensions expose the same logical configuration surface, adapted to each IDE's settings mechanism.

| Setting | Type | Default | Description |
|---|---|---|---|
| `endpoint` | string | `http://127.0.0.1:4304` | Provider server URL |
| `model` | string | `edgecoder-local` | Default model for requests |
| `apiKey` | string | `""` | Optional Bearer token |
| `completion.enabled` | boolean | `true` | Enable inline completions |
| `completion.debounceMs` | number | `300` | Typing debounce before triggering completion |
| `completion.maxTokens` | number | `256` | Max tokens in completion response |
| `completion.temperature` | number | `0.2` | Temperature for completions (low for determinism) |
| `chat.temperature` | number | `0.7` | Temperature for chat (higher for conversational) |
| `chat.maxTokens` | number | `4096` | Max tokens in chat response |
| `statusBar.enabled` | boolean | `true` | Show status bar widget |
| `healthPollIntervalMs` | number | `30000` | Health check polling interval |

---

## 10. Build, Test, and CI

### 10.1 VS Code / Cursor

| Step | Command | Tool |
|---|---|---|
| Install | `npm install` | npm |
| Build | `npm run build` (esbuild) | esbuild |
| Test | `npm test` (vitest or mocha) | vitest |
| Package | `npx @vscode/vsce package` | vsce |
| Publish | `npx @vscode/vsce publish` | vsce |
| Publish (Open VSX) | `npx ovsx publish` | ovsx |

### 10.2 JetBrains

| Step | Command | Tool |
|---|---|---|
| Build | `./gradlew build` | Gradle |
| Test | `./gradlew test` | JUnit 5 |
| Package | `./gradlew buildPlugin` | IntelliJ Platform Plugin |
| Publish | `./gradlew publishPlugin` | JetBrains Marketplace |
| Verify | `./gradlew runPluginVerifier` | IntelliJ Plugin Verifier |

### 10.3 Neovim

| Step | Command | Tool |
|---|---|---|
| Test | `nvim --headless -u tests/minimal_init.lua -c "PlenaryBustedDirectory tests/"` | plenary.nvim test runner |
| Lint | `luacheck lua/` | luacheck |
| Format | `stylua lua/` | StyLua |
| Doc gen | `lemmy-help lua/edgecoder/ > doc/edgecoder.txt` | lemmy-help (optional) |

### 10.4 CI Matrix

A single GitHub Actions workflow at `.github/workflows/extensions.yml` runs all three:

```yaml
jobs:
  vscode:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: cd extensions/vscode && npm ci && npm test && npm run build

  jetbrains:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { java-version: "17", distribution: "temurin" }
      - run: cd extensions/jetbrains && ./gradlew build test

  neovim:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: rhysd/action-setup-vim@v1
        with: { neovim: true, version: "v0.10.0" }
      - run: cd extensions/neovim && luacheck lua/
```

---

## 11. Provider Server Enhancements Needed

The current `provider-server.ts` works for MVP but the following enhancements would improve the extension experience:

### 11.1 Required before extension GA

| Enhancement | Reason |
|---|---|
| **Bind option**: Support `--bind 127.0.0.1` flag or `BIND_HOST` env var | Security: prevent unintended LAN exposure |
| **CORS headers**: Add `Access-Control-Allow-Origin: *` for webview chat panels | VS Code webviews and JetBrains JBCef panels make requests from non-localhost origins |
| **Completion-optimized endpoint** (optional): `POST /v1/completions` | Some IDE integrations expect the legacy completions endpoint (single prompt, no messages array). Can be a thin wrapper over chat completions. |

### 11.2 Nice-to-have

| Enhancement | Reason |
|---|---|
| **Token counting**: Return real `prompt_tokens` and `completion_tokens` in usage field | Extensions can show token usage to the user |
| **Request cancellation**: Support for request ID-based cancellation | When the user types past a completion, the extension can cancel the in-flight request server-side |
| **FIM endpoint**: `POST /v1/fim/completions` with explicit `prefix` and `suffix` fields | Cleaner than encoding FIM as a chat message; better for Ollama's native FIM support |

---

## 12. Implementation Sequence

### Phase 1: VS Code Extension MVP (Week 1-2)

- [ ] Scaffold `extensions/vscode/` with package.json, tsconfig, esbuild config
- [ ] Implement `EdgeCoderClient` (HTTP client with SSE streaming)
- [ ] Implement `InlineCompletionItemProvider` with debounce and cancellation
- [ ] Implement status bar with connection state and model name
- [ ] Implement model picker (QuickPick from `/v1/models`)
- [ ] Implement chat webview panel with streaming Markdown rendering
- [ ] Add configuration schema and settings reader
- [ ] Write tests for client, completion provider
- [ ] Test in both VS Code and Cursor
- [ ] Package as .vsix

### Phase 2: Neovim Plugin (Week 2-3)

- [ ] Scaffold `extensions/neovim/` with lua module structure
- [ ] Implement curl-based HTTP client with SSE parsing
- [ ] Implement nvim-cmp source for completions
- [ ] Implement inline ghost text via extmarks
- [ ] Implement chat split buffer with streaming
- [ ] Implement `:checkhealth edgecoder`
- [ ] Implement statusline component
- [ ] Write plenary-based tests
- [ ] Document in `doc/edgecoder.txt`

### Phase 3: JetBrains Plugin (Week 3-4)

- [ ] Scaffold `extensions/jetbrains/` with Gradle and plugin.xml
- [ ] Implement Kotlin HTTP client with SSE
- [ ] Implement `InlineCompletionProvider` (or `CompletionContributor` fallback)
- [ ] Implement chat tool window
- [ ] Implement status bar widget
- [ ] Implement settings panel with `PersistentStateComponent`
- [ ] Write JUnit tests
- [ ] Package and test in IntelliJ IDEA, WebStorm, PyCharm

### Phase 4: Polish and Release (Week 4-5)

- [ ] Add provider server CORS and bind-host enhancements
- [ ] CI workflow for all three extensions
- [ ] Publish VS Code extension to Marketplace and Open VSX
- [ ] Publish JetBrains plugin to Marketplace
- [ ] Publish Neovim plugin repo (GitHub)
- [ ] Add extension install instructions to project README and docs site
- [ ] Document Cursor "Add Model" zero-install flow

---

## 13. Open Questions

| # | Question | Decision needed from |
|---|---|---|
| 1 | Should each extension live in its own git repo (e.g., `edgecoder/edgecoder-vscode`) or in the monorepo under `extensions/`? Monorepo is simpler for shared testing against the provider server; separate repos are conventional for IDE extensions. | Architecture lead |
| 2 | Should the VS Code extension use the Chat Participant API (VS Code 1.93+) in addition to or instead of a webview? The Chat Participant API provides tighter Copilot Chat integration but ties to a newer VS Code minimum version. | IDE lead |
| 3 | Should the provider server add a `/v1/completions` (legacy completions) endpoint for tools that expect it (e.g., some Neovim LSP-based completion plugins)? | Backend lead |
| 4 | Should extensions bundle a "start server" command that launches `npm run dev:ide` if the server is not running? This adds convenience but also complexity (finding the right Node.js, project path, etc.). | Product lead |
| 5 | For Cursor specifically, should we prioritize the native "Add Model" zero-install path over the dedicated extension, or ship both simultaneously? | Product lead |

---

## 14. References

- Provider server: `src/apps/ide/provider-server.ts` (port 4304, Fastify)
- OpenAI compatibility layer: `src/apps/ide/openai-compat.ts`
- Intelligent router: `src/model/router.ts` (Bluetooth -> Ollama -> Swarm -> Stub waterfall)
- Provider registry: `src/model/providers.ts` (edgecoder-local, ollama-local, ollama-edge, ollama-coordinator)
- Architecture plan: `EDGECODER_PLAN.md` Sections 9.1, 9.5
- VS Code InlineCompletionItemProvider API: https://code.visualstudio.com/api/references/vscode-api#InlineCompletionItemProvider
- JetBrains InlineCompletionProvider: https://plugins.jetbrains.com/docs/intellij/inline-completion.html
- Neovim nvim-cmp custom sources: https://github.com/hrsh7th/nvim-cmp/wiki/List-of-sources
