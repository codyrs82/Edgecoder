import type { FastifyInstance } from "fastify";
import type { ModelSwapState } from "../model/swap-routes.js";

export function buildDashboardRoutes(
  app: FastifyInstance,
  state: ModelSwapState,
): void {
  app.get("/dashboard", async (_req, reply) => {
    return reply.type("text/html").send(dashboardHtml());
  });

  // Dashboard API endpoints (no auth required — served alongside dashboard)
  app.get("/dashboard/api/overview", async (_req, reply) => {
    const ollamaHealthy = await checkOllamaHealth();
    return reply.send({
      activeModel: state.activeModel,
      activeModelParamSize: state.activeModelParamSize,
      ollamaHealthy,
      uptimeSeconds: Math.floor(process.uptime()),
      memoryMB: Math.round(process.memoryUsage.rss() / 1_048_576),
      nodeVersion: process.version,
    });
  });
}

async function checkOllamaHealth(): Promise<boolean> {
  const host = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EdgeCoder Agent Dashboard</title>
<style>
  :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff; --green: #3fb950; --orange: #d29922; --red: #f85149; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  .container { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
  header h1 { font-size: 20px; font-weight: 600; }
  header .badge { font-size: 12px; padding: 2px 8px; border-radius: 12px; background: var(--green); color: #000; font-weight: 600; }
  header .badge.offline { background: var(--red); color: #fff; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); margin-bottom: 12px; }
  .stat { font-size: 28px; font-weight: 700; margin-bottom: 4px; }
  .stat-label { font-size: 13px; color: var(--muted); }
  .model-list { list-style: none; }
  .model-list li { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--border); }
  .model-list li:last-child { border-bottom: none; }
  .model-name { font-weight: 500; }
  .model-meta { font-size: 12px; color: var(--muted); }
  .active-badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; background: var(--green); color: #000; font-weight: 600; }
  button { background: var(--accent); color: #fff; border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; }
  button:hover { opacity: 0.9; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button.danger { background: var(--red); }
  .swap-btn { background: transparent; border: 1px solid var(--accent); color: var(--accent); padding: 4px 10px; font-size: 12px; }
  .swap-btn:hover { background: var(--accent); color: #fff; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .dot.green { background: var(--green); }
  .dot.orange { background: var(--orange); }
  .dot.red { background: var(--red); }
  .dot.gray { background: var(--muted); }
  .status-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 14px; }
  .status-row:last-child { border-bottom: none; }
  .status-label { color: var(--muted); }
  .log { font-family: 'SF Mono', Monaco, monospace; font-size: 12px; background: #0d1117; border: 1px solid var(--border); border-radius: 6px; padding: 12px; max-height: 240px; overflow-y: auto; white-space: pre-wrap; color: var(--muted); }
  .toast { position: fixed; bottom: 24px; right: 24px; background: var(--card); border: 1px solid var(--green); padding: 12px 20px; border-radius: 8px; font-size: 14px; display: none; z-index: 100; }
  .toast.error { border-color: var(--red); }
  #refresh-timer { font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<div class="container">
  <header>
    <div>
      <h1>EdgeCoder Agent Dashboard</h1>
      <span id="refresh-timer">Auto-refresh: 5s</span>
    </div>
    <span id="health-badge" class="badge">Connecting...</span>
  </header>

  <div class="grid">
    <div class="card">
      <h2>Active Model</h2>
      <div class="stat" id="active-model">--</div>
      <div class="stat-label" id="model-params">--</div>
    </div>
    <div class="card">
      <h2>Ollama</h2>
      <div class="stat" id="ollama-status">--</div>
      <div class="stat-label" id="ollama-detail">Checking connection...</div>
    </div>
    <div class="card">
      <h2>Service Uptime</h2>
      <div class="stat" id="uptime">--</div>
      <div class="stat-label" id="memory-usage">--</div>
    </div>
  </div>

  <div class="grid">
    <div class="card" style="grid-column: 1 / -1;">
      <h2>Installed Models</h2>
      <ul class="model-list" id="model-list">
        <li><span class="model-meta">Loading...</span></li>
      </ul>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Model Status</h2>
      <div id="model-status-detail">
        <div class="status-row"><span class="status-label">State</span><span id="status-state">--</span></div>
        <div class="status-row"><span class="status-label">Ollama Host</span><span id="status-host">--</span></div>
        <div class="status-row"><span class="status-label">Node.js</span><span id="status-node">--</span></div>
        <div class="status-row"><span class="status-label">Memory</span><span id="status-mem">--</span></div>
      </div>
    </div>
    <div class="card">
      <h2>Activity Log</h2>
      <div class="log" id="activity-log">Dashboard started.\n</div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const API = window.location.origin;
const logEl = document.getElementById('activity-log');

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent = ts + ' | ' + msg + '\\n' + logEl.textContent;
  if (logEl.textContent.length > 5000) logEl.textContent = logEl.textContent.slice(0, 5000);
}

function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = isError ? 'toast error' : 'toast';
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

function formatUptime(secs) {
  if (secs < 60) return secs + 's';
  if (secs < 3600) return Math.floor(secs/60) + 'm ' + (secs%60) + 's';
  const h = Math.floor(secs/3600);
  const m = Math.floor((secs%3600)/60);
  return h + 'h ' + m + 'm';
}

async function fetchOverview() {
  try {
    const res = await fetch(API + '/dashboard/api/overview');
    const data = await res.json();

    document.getElementById('active-model').textContent = data.activeModel || 'None';
    document.getElementById('model-params').textContent = data.activeModelParamSize ? data.activeModelParamSize + 'B parameters' : 'No model loaded';
    document.getElementById('ollama-status').innerHTML = data.ollamaHealthy
      ? '<span class="dot green"></span>Connected'
      : '<span class="dot red"></span>Disconnected';
    document.getElementById('ollama-detail').textContent = data.ollamaHealthy ? 'Ollama is running' : 'Start with: ollama serve';
    document.getElementById('uptime').textContent = formatUptime(data.uptimeSeconds);
    document.getElementById('memory-usage').textContent = data.memoryMB + ' MB RSS';
    document.getElementById('status-state').textContent = data.ollamaHealthy ? 'Ready' : 'Ollama offline';
    document.getElementById('status-node').textContent = data.nodeVersion;
    document.getElementById('status-mem').textContent = data.memoryMB + ' MB';
    document.getElementById('status-host').textContent = '${process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434"}';

    const badge = document.getElementById('health-badge');
    if (data.ollamaHealthy) {
      badge.textContent = 'Online';
      badge.className = 'badge';
    } else {
      badge.textContent = 'Ollama Offline';
      badge.className = 'badge offline';
    }
  } catch (e) {
    log('Failed to fetch overview: ' + e.message);
  }
}

async function fetchModels() {
  try {
    const res = await fetch(API + '/model/list');
    const models = await res.json();
    const list = document.getElementById('model-list');

    if (!models.length) {
      list.innerHTML = '<li><span class="model-meta">No models installed</span></li>';
      return;
    }

    const statusRes = await fetch(API + '/model/status');
    const status = await statusRes.json();

    list.innerHTML = models
      .filter(m => m.installed)
      .map(m => {
        const isActive = m.active;
        return '<li>' +
          '<div><span class="model-name">' + m.modelId + '</span>' +
          '<div class="model-meta">' + m.paramSize + 'B | ' + m.quantization + '</div></div>' +
          (isActive
            ? '<span class="active-badge">Active</span>'
            : '<button class="swap-btn" onclick="swapModel(\\'' + m.modelId + '\\')">Activate</button>') +
          '</li>';
      }).join('');
  } catch (e) {
    log('Failed to fetch models: ' + e.message);
  }
}

async function swapModel(model) {
  log('Swapping to ' + model + '...');
  try {
    const res = await fetch(API + '/model/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model })
    });
    const result = await res.json();
    if (result.status === 'ready') {
      toast('Swapped to ' + result.active);
      log('Swapped: ' + result.previous + ' -> ' + result.active + ' (' + result.paramSize + 'B)');
    } else if (result.status === 'pulling') {
      toast('Pulling ' + model + '...');
      log('Pulling ' + model + ' (' + (result.progress || 0) + '%)');
    } else {
      toast('Swap error: ' + (result.error || result.status), true);
      log('Swap failed: ' + JSON.stringify(result));
    }
    await refresh();
  } catch (e) {
    toast('Swap failed: ' + e.message, true);
    log('Swap error: ' + e.message);
  }
}

async function refresh() {
  await Promise.all([fetchOverview(), fetchModels()]);
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
}
