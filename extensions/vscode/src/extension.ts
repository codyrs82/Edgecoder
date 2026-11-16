// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

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
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";
import { renderResultHtml, type RunResult } from "./result-html";

// ---------------------------------------------------------------------------
// Types mirroring provider-server responses
// ---------------------------------------------------------------------------

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

// #4: the provider server requires a bearer token on every route except /health.
// Uses the edgecoder.providerToken setting, else ~/.edgecoder/ide-token (written by the server).
function providerToken(): string {
  const configured = vscode.workspace.getConfiguration("edgecoder").get<string>("providerToken", "").trim();
  if (configured) return configured;
  try {
    return fs.readFileSync(path.join(os.homedir(), ".edgecoder", "ide-token"), "utf8").trim();
  } catch {
    return "";
  }
}

function authHeaders(): Record<string, string> {
  const token = providerToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

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
        "Content-Length": Buffer.byteLength(payload),
        ...authHeaders()
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
      headers: authHeaders(),
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

  const cfg = vscode.workspace.getConfiguration("edgecoder");
  const showRoute = cfg.get<boolean>("showRouteInfo") !== false;
  resultPanel.webview.html = renderResultHtml(result, task, showRoute, randomBytes(16).toString("base64"));
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
        ) as RunResult & { error?: string; message?: string };
        if (result.error) {
          vscode.window.showErrorMessage(`EdgeCoder: ${result.message ?? result.error}`);
          return;
        }
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
