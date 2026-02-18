/**
 * EdgeCoder VS Code / Cursor Extension
 *
 * Connects to the local EdgeCoder provider server (localhost:4304) which
 * runs IntelligentRouter to decide: bluetooth-local → ollama-local → swarm → stub
 *
 * Commands:
 *   cmd+shift+e        — run selection/file as a task (auto-routed)
 *   right-click menu   — run local / run via swarm
 *   EdgeCoder: Show Router Status — see live routing stats
 */

import * as vscode from "vscode";
import * as http from "http";

// ---------------------------------------------------------------------------
// Types mirroring provider-server responses
// ---------------------------------------------------------------------------

interface RunResult {
  plan: string;
  generatedCode: string;
  runResult: { stdout: string; stderr: string; exitCode: number };
  route: "bluetooth-local" | "ollama-local" | "swarm" | "edgecoder-local";
  latencyMs: number;
  creditsSpent?: number;
  swarmTaskId?: string;
  routeError?: string;
}

interface RouterStatus {
  activeConcurrent: number;
  concurrencyCap: number;
  localLatencyP95Ms: number;
  latencyThresholdMs: number;
  latencySamples: number;
  bluetoothEnabled: boolean;
  swarmEnabled: boolean;
}

// ---------------------------------------------------------------------------
// HTTP helper (no external deps, uses built-in node http)
// ---------------------------------------------------------------------------

function postJson(url: string, body: object, timeoutMs = 90_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      },
      timeout: timeoutMs
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Non-JSON response: ${data.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    req.write(payload);
    req.end();
  });
}

function getJson(url: string, timeoutMs = 5_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname,
      method: "GET",
      timeout: timeoutMs
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Non-JSON response`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timed out")); });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

function detectLanguage(editor: vscode.TextEditor): "python" | "javascript" {
  const langId = editor.document.languageId;
  if (langId === "python") return "python";
  if (langId === "javascript" || langId === "typescript" || langId === "javascriptreact") {
    return "javascript";
  }
  const cfg = vscode.workspace.getConfiguration("edgecoder");
  return cfg.get<"python" | "javascript">("defaultLanguage") ?? "python";
}

// ---------------------------------------------------------------------------
// Result panel
// ---------------------------------------------------------------------------

let resultPanel: vscode.WebviewPanel | undefined;

function showResultPanel(
  context: vscode.ExtensionContext,
  result: RunResult,
  task: string
): void {
  if (!resultPanel) {
    resultPanel = vscode.window.createWebviewPanel(
      "edgecoderResult",
      "EdgeCoder Result",
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );
    resultPanel.onDidDispose(() => { resultPanel = undefined; }, null, context.subscriptions);
    resultPanel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === "applyCode") {
        await applyCodeToEditor(msg.code);
      }
    }, null, context.subscriptions);
  }

  const routeColor: Record<string, string> = {
    "ollama-local":    "#22c55e",
    "bluetooth-local": "#3b82f6",
    "swarm":           "#f59e0b",
    "edgecoder-local": "#94a3b8"
  };
  const color = routeColor[result.route] ?? "#94a3b8";
  const cfg = vscode.workspace.getConfiguration("edgecoder");
  const showRoute = cfg.get<boolean>("showRouteInfo") !== false;

  resultPanel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); padding: 16px; margin: 0; }
  h2 { margin-top: 0; font-size: 1.1em; }
  .badge { display:inline-block; padding: 2px 10px; border-radius: 999px;
           font-size: 0.8em; font-weight: 600; color: #000; background: ${color}; }
  .meta { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin: 6px 0 12px; }
  .section { margin-bottom: 16px; }
  .section h3 { font-size: 0.9em; text-transform: uppercase; letter-spacing: 0.05em;
                color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  pre { background: var(--vscode-textCodeBlock-background);
        border: 1px solid var(--vscode-editorWidget-border);
        border-radius: 6px; padding: 12px; overflow-x: auto;
        font-family: var(--vscode-editor-font-family); font-size: 0.9em;
        white-space: pre-wrap; word-break: break-word; }
  button { background: var(--vscode-button-background);
           color: var(--vscode-button-foreground);
           border: none; border-radius: 4px; padding: 6px 14px;
           cursor: pointer; font-size: 0.9em; margin-top: 8px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .credits { color: ${color}; font-weight: 600; }
</style>
</head>
<body>
<h2>EdgeCoder Result</h2>
${showRoute ? `<span class="badge">${result.route}</span>` : ""}
<div class="meta">
  ${result.latencyMs}ms
  ${result.creditsSpent !== undefined ? ` &middot; <span class="credits">${result.creditsSpent} credits spent</span>` : ""}
  ${result.swarmTaskId ? ` &middot; task ${result.swarmTaskId}` : ""}
</div>

<div class="section">
  <h3>Task</h3>
  <pre>${escapeHtml(task.slice(0, 500))}</pre>
</div>

<div class="section">
  <h3>Plan</h3>
  <pre>${escapeHtml(result.plan)}</pre>
</div>

<div class="section">
  <h3>Generated Code</h3>
  <pre id="code">${escapeHtml(result.generatedCode)}</pre>
  <button onclick="applyCode()">Apply to Editor</button>
</div>

${result.runResult?.stdout ? `<div class="section"><h3>Output</h3><pre>${escapeHtml(result.runResult.stdout)}</pre></div>` : ""}
${result.runResult?.stderr ? `<div class="section"><h3>Stderr</h3><pre>${escapeHtml(result.runResult.stderr)}</pre></div>` : ""}
${result.routeError ? `<div class="section"><h3>Route Warning</h3><pre>${escapeHtml(result.routeError)}</pre></div>` : ""}

<script>
const vscode = acquireVsCodeApi();
function applyCode() {
  const code = document.getElementById('code').innerText;
  vscode.postMessage({ command: 'applyCode', code });
}
function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
</script>
</body>
</html>`;

  function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

// ---------------------------------------------------------------------------
// Apply code to active editor
// ---------------------------------------------------------------------------

async function applyCodeToEditor(code: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("No active editor to apply code to.");
    return;
  }
  const selection = editor.selection;
  await editor.edit((editBuilder) => {
    if (selection.isEmpty) {
      editBuilder.insert(selection.active, "\n" + code);
    } else {
      editBuilder.replace(selection, code);
    }
  });
}

// ---------------------------------------------------------------------------
// Core run function
// ---------------------------------------------------------------------------

async function runEdgeCoder(
  context: vscode.ExtensionContext,
  endpoint: string
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("EdgeCoder: No active editor.");
    return;
  }

  const selection = editor.selection;
  const task = selection.isEmpty
    ? editor.document.getText()
    : editor.document.getText(selection);

  if (!task.trim()) {
    vscode.window.showErrorMessage("EdgeCoder: Nothing selected and file is empty.");
    return;
  }

  const cfg = vscode.workspace.getConfiguration("edgecoder");
  const baseUrl = cfg.get<string>("providerUrl") ?? "http://127.0.0.1:4304";
  const autoDetect = cfg.get<boolean>("autoDetectLanguage") !== false;
  const language = autoDetect ? detectLanguage(editor) : (cfg.get<"python" | "javascript">("defaultLanguage") ?? "python");

  // Check server is up
  try {
    await getJson(`${baseUrl}/health`, 3000);
  } catch {
    const launch = await vscode.window.showErrorMessage(
      "EdgeCoder agent is not running. Start it with: npm run dev:ide",
      "Copy command"
    );
    if (launch === "Copy command") {
      await vscode.env.clipboard.writeText("npm run dev:ide");
    }
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "EdgeCoder",
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: "Routing request…" });
      try {
        const result = await postJson(
          `${baseUrl}${endpoint}`,
          { task, language, maxTokens: 1024 },
          90_000
        ) as RunResult;
        const routeMsg = result.route ? ` via ${result.route}` : "";
        progress.report({ message: `Done${routeMsg} (${result.latencyMs}ms)` });
        showResultPanel(context, result, task);
      } catch (err) {
        vscode.window.showErrorMessage(`EdgeCoder error: ${String(err)}`);
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Extension activate / deactivate
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  // Status bar item showing current route capacity
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = "$(circuit-board) EdgeCoder";
  statusBar.tooltip = "EdgeCoder swarm agent";
  statusBar.command = "edgecoder.showStatus";
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Poll router status every 30s and update status bar
  const poll = async () => {
    const cfg = vscode.workspace.getConfiguration("edgecoder");
    const baseUrl = cfg.get<string>("providerUrl") ?? "http://127.0.0.1:4304";
    try {
      const s = await getJson(`${baseUrl}/status`, 3000) as RouterStatus;
      const load = s.activeConcurrent > 0 ? ` (${s.activeConcurrent}/${s.concurrencyCap})` : "";
      const bt = s.bluetoothEnabled ? " 📶" : "";
      const swarm = s.swarmEnabled ? " 🌐" : "";
      statusBar.text = `$(circuit-board) EdgeCoder${load}${bt}${swarm}`;
      statusBar.tooltip = [
        `Active: ${s.activeConcurrent}/${s.concurrencyCap}`,
        `Local p95 latency: ${s.localLatencyP95Ms}ms`,
        `Latency threshold: ${s.latencyThresholdMs}ms`,
        `Bluetooth: ${s.bluetoothEnabled ? "enabled" : "off"}`,
        `Swarm: ${s.swarmEnabled ? "enabled" : "no mesh token"}`
      ].join("\n");
    } catch {
      statusBar.text = "$(circuit-board) EdgeCoder (offline)";
      statusBar.tooltip = "Agent not running — npm run dev:ide";
    }
  };
  poll();
  const interval = setInterval(poll, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(interval) });

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("edgecoder.runTask", () =>
      runEdgeCoder(context, "/run")
    ),
    vscode.commands.registerCommand("edgecoder.runLocal", () =>
      runEdgeCoder(context, "/run/local")
    ),
    vscode.commands.registerCommand("edgecoder.runSwarm", () =>
      runEdgeCoder(context, "/run/swarm")
    ),
    vscode.commands.registerCommand("edgecoder.applyCode", async () => {
      if (!resultPanel) {
        vscode.window.showWarningMessage("No EdgeCoder result to apply.");
        return;
      }
      // Trigger via the webview message already wired
      vscode.window.showInformationMessage("Use the 'Apply to Editor' button in the EdgeCoder panel.");
    }),
    vscode.commands.registerCommand("edgecoder.showStatus", async () => {
      const cfg = vscode.workspace.getConfiguration("edgecoder");
      const baseUrl = cfg.get<string>("providerUrl") ?? "http://127.0.0.1:4304";
      try {
        const s = await getJson(`${baseUrl}/status`, 3000) as RouterStatus;
        const lines = [
          `Route capacity:   ${s.activeConcurrent}/${s.concurrencyCap} concurrent`,
          `Local p95:        ${s.localLatencyP95Ms}ms  (threshold ${s.latencyThresholdMs}ms)`,
          `Latency samples:  ${s.latencySamples}`,
          `Bluetooth:        ${s.bluetoothEnabled ? "✓ enabled" : "✗ off"}`,
          `Swarm:            ${s.swarmEnabled ? "✓ mesh token present" : "✗ no mesh token"}`
        ];
        vscode.window.showInformationMessage(lines.join("  |  "), { modal: false });
      } catch {
        vscode.window.showErrorMessage("EdgeCoder agent not reachable — run: npm run dev:ide");
      }
    })
  );
}

export function deactivate(): void {
  if (resultPanel) {
    resultPanel.dispose();
  }
}
