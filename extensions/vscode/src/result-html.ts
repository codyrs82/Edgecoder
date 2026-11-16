// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/** The result webview's HTML (no vscode import, so it can be tested on its own). */

export interface RunResult {
  plan: string;
  generatedCode: string;
  runResult: { stdout: string; stderr: string; exitCode: number | null };
  /** false when the code was not executed locally (e.g. swarm results). */
  ran?: boolean;
  route: "bluetooth-local" | "ollama-local" | "swarm" | "edgecoder-local";
  latencyMs: number;
  creditsSpent?: number;
  swarmTaskId?: string;
  routeError?: string;
}

export function escapeHtml(s: unknown): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** `nonce`: a fresh random value per render; only the script carrying it may run. */
export function renderResultHtml(result: RunResult, task: string, showRoute: boolean, nonce: string): string {
  const routeColor: Record<string, string> = {
    "ollama-local":    "#22c55e",
    "bluetooth-local": "#3b82f6",
    "swarm":           "#f59e0b",
    "edgecoder-local": "#94a3b8"
  };
  const color = Object.prototype.hasOwnProperty.call(routeColor, result.route) ? routeColor[result.route] : "#94a3b8";
  // Server fields are untrusted (swarm results pass through a coordinator): escape every one, and
  // a CSP lets only this page's own nonce'd script run.
  const credits = Number(result.creditsSpent);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"/>
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
${showRoute ? `<span class="badge">${escapeHtml(String(result.route))}</span>` : ""}
<div class="meta">
  ${escapeHtml(String(result.latencyMs))}ms
  ${result.creditsSpent !== undefined && Number.isFinite(credits) ? ` &middot; <span class="credits">${credits} credits spent</span>` : ""}
  ${result.swarmTaskId ? ` &middot; task ${escapeHtml(String(result.swarmTaskId))}` : ""}
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
  <button id="apply">Apply to Editor</button>
</div>

${result.ran === false ? `<div class="section"><h3>Not executed</h3><pre>This result came from the swarm and was not run or tested locally.</pre></div>` : ""}
${result.runResult?.stdout ? `<div class="section"><h3>Output</h3><pre>${escapeHtml(result.runResult.stdout)}</pre></div>` : ""}
${result.runResult?.stderr ? `<div class="section"><h3>Stderr</h3><pre>${escapeHtml(result.runResult.stderr)}</pre></div>` : ""}
${result.routeError ? `<div class="section"><h3>Route Warning</h3><pre>${escapeHtml(result.routeError)}</pre></div>` : ""}

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('apply').addEventListener('click', () => {
  const code = document.getElementById('code').innerText;
  vscode.postMessage({ command: 'applyCode', code });
});
</script>
</body>
</html>`;
}
