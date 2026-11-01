// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

// #16: moved verbatim from src/portal/server.ts.
export function portalAuthedPageHtml(input: {
  title: string;
  activeTab: "chat" | "dashboard" | "wallet" | "settings" | "download" | "reviews";
  heading: string;
  subtitle: string;
  content: string;
  script: string;
}): string {

  const navItems = [
    { key: "dashboard", href: "/portal/dashboard", label: "Dashboard", icon: "&#9632;" },
    { key: "chat", href: "/portal/chat", label: "Chat", icon: "&#9993;" },
    { key: "reviews", href: "/portal/reviews", label: "Reviews", icon: "&#9998;", hasBadge: true },
    { key: "wallet", href: "/portal/wallet", label: "Wallet", icon: "&#9733;" },
    { key: "settings", href: "/portal/settings", label: "Settings", icon: "&#9881;" },
  ];
  const navHtml = navItems.map((item) => {
    const active = item.key === input.activeTab ? " topbar-nav-active" : "";
    const badge = item.hasBadge ? `<span class="nav-badge" id="reviewsBadge" style="display:none;">0</span>` : "";
    return `<a class="topbar-nav-link${active}" href="${item.href}" title="${item.label}"><span class="nav-icon">${item.icon}</span><span class="nav-label">${item.label}</span>${badge}</a>`;
  }).join("");

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${input.title}</title>
      <style>
        :root {
          --bg: #1a1a18;
          --bg-soft: #2f2f2d;
          --bg-surface: #3a3a37;
          --bg-elevated: #454542;
          --bg-input: #262624;
          --card: rgba(58, 58, 55, 0.96);
          --card-border: rgba(214, 204, 194, 0.08);
          --border-strong: rgba(214, 204, 194, 0.15);
          --text: #f7f5f0;
          --text-secondary: #b8b0a4;
          --muted: #8a8478;
          --brand: #c17850;
          --brand-2: #d4895f;
          --ok: #4ade80;
          --danger: #f87171;
          --yellow: #fbbf24;
          --font-mono: "SF Mono", "Fira Code", "Cascadia Code", monospace;
          --transition-fast: 0.15s ease;
          --transition-med: 0.25s ease;
          --radius-sm: 6px;
          --radius-md: 10px;
          --radius-lg: 14px;
        }
        * { box-sizing: border-box; }
        body {
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 14px;
          line-height: 1.5;
          margin: 0;
          color: var(--text);
          background: var(--bg);
          min-height: 100vh;
          -webkit-font-smoothing: antialiased;
        }
        .shell { max-width: 1360px; margin: 0 auto; padding: 0 14px; }
        /* ── Topbar ── */
        .topbar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 6px 16px;
          border-bottom: 1px solid var(--card-border);
          background: var(--bg-soft);
          position: sticky;
          top: 0;
          z-index: 50;
          backdrop-filter: blur(12px);
        }
        .topbar-left { display: flex; align-items: center; gap: 10px; }
        .topbar-left a { text-decoration: none; color: var(--text); display: flex; align-items: center; gap: 8px; }
        .topbar-nav { display: flex; align-items: center; gap: 2px; margin-left: 16px; }
        .topbar-nav-link {
          display: inline-flex; align-items: center; gap: 5px;
          padding: 6px 12px; border-radius: var(--radius-sm);
          font-size: 13px; font-weight: 500; color: var(--muted);
          text-decoration: none; transition: all var(--transition-fast);
          position: relative; border: 1px solid transparent;
        }
        .topbar-nav-link:hover { color: var(--text); background: var(--bg-surface); }
        .topbar-nav-link.topbar-nav-active {
          color: var(--brand); background: rgba(193, 120, 80, 0.1);
          border-color: rgba(193, 120, 80, 0.25);
        }
        .topbar-nav-link .nav-icon { font-size: 14px; }
        .nav-badge {
          position: absolute; top: -4px; right: -2px;
          background: var(--danger); color: #fff; font-size: 9px;
          font-weight: 700; min-width: 16px; height: 16px;
          border-radius: 999px; display: inline-flex;
          align-items: center; justify-content: center;
          padding: 0 4px; line-height: 1;
        }
        .topbar-right { display: flex; align-items: center; gap: 10px; }
        .topbar-credits {
          font-family: var(--font-mono);
          font-size: 12px;
          color: var(--muted);
          padding: 4px 10px;
          border: 1px solid var(--card-border);
          border-radius: var(--radius-sm);
          background: var(--bg);
          transition: border-color var(--transition-fast);
        }
        .topbar-credits:hover { border-color: var(--brand); }
        .topbar-icon {
          width: 32px; height: 32px;
          display: inline-flex; align-items: center; justify-content: center;
          border-radius: var(--radius-sm); border: 1px solid var(--card-border);
          background: var(--bg); color: var(--muted); text-decoration: none;
          font-size: 16px; cursor: pointer; transition: all var(--transition-fast);
        }
        .topbar-icon:hover { background: var(--card); color: var(--text); border-color: var(--brand); }
        /* ── Hamburger (mobile) ── */
        .hamburger-btn {
          display: none; background: none; border: none; color: var(--text);
          font-size: 22px; cursor: pointer; padding: 4px 6px; line-height: 1;
        }
        .main { min-width: 0; }
        .brand { display: inline-flex; align-items: center; gap: 10px; }
        .mark {
          width: 28px;
          height: 28px;
          border-radius: 7px;
          background: linear-gradient(140deg, var(--brand), var(--brand-2));
          display: inline-flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 0 0 1px rgba(255,255,255,0.12) inset;
          font-size: 12px;
        }
        .topbar-title { font-size: 14px; font-weight: 700; letter-spacing: 0.02em; }
        .muted { color: var(--muted); font-size: 11px; }
        /* ── Cards ── */
        .card {
          background: var(--card);
          border: 1px solid var(--card-border);
          border-radius: var(--radius-md);
          padding: 14px;
          margin-bottom: 10px;
          backdrop-filter: blur(10px);
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.15);
          transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
          animation: fadeSlideIn 0.3s ease both;
        }
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .content-stack { margin-top: 0; }
        .row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
        /* ── Buttons ── */
        button {
          padding: 7px 12px;
          border-radius: var(--radius-sm);
          border: 1px solid var(--card-border);
          background: var(--bg-soft);
          color: var(--text);
          cursor: pointer;
          font-size: 12px;
          font-weight: 500;
          transition: all var(--transition-fast);
        }
        button:hover { border-color: var(--border-strong); background: var(--bg-surface); transform: translateY(-1px); }
        button:active { transform: translateY(0); }
        button.primary {
          background: linear-gradient(140deg, var(--brand), var(--brand-2));
          border-color: rgba(193, 120, 80, 0.75);
          color: white;
        }
        button.primary:hover { filter: brightness(1.1); box-shadow: 0 2px 12px rgba(193, 120, 80, 0.3); }
        /* ── Inputs ── */
        input, select, textarea {
          width: 100%;
          padding: 8px 10px;
          border: 1px solid var(--card-border);
          border-radius: var(--radius-sm);
          background: var(--bg-input);
          color: var(--text);
          font-size: 13px;
          font-family: inherit;
          transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
        }
        input:focus, select:focus, textarea:focus {
          outline: none;
          border-color: var(--brand);
          box-shadow: 0 0 0 2px rgba(193, 120, 80, 0.15);
        }
        input::placeholder, textarea::placeholder { color: var(--muted); opacity: 0.7; }
        label {
          display: block;
          margin: 8px 0 4px;
          font-size: 10px;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.06em;
          font-weight: 600;
        }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th, td {
          border-bottom: 1px solid var(--card-border);
          text-align: left;
          padding: 6px 5px;
          vertical-align: top;
          font-family: inherit;
        }
        th {
          color: var(--muted);
          font-weight: 600;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .grid2 { display: grid; grid-template-columns: repeat(2, minmax(260px, 1fr)); gap: 10px; }
        .kpis { display: grid; grid-template-columns: repeat(3, minmax(110px, 1fr)); gap: 8px; margin-top: 8px; }
        .kpi {
          border: 1px solid var(--card-border); border-radius: var(--radius-sm);
          padding: 10px; background: var(--card);
          transition: border-color var(--transition-fast), transform var(--transition-fast);
        }
        .kpi:hover { border-color: rgba(193, 120, 80, 0.25); transform: translateY(-1px); }
        .kpi .label {
          color: var(--muted);
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .kpi .value {
          font-size: 15px;
          font-weight: 700;
          margin-top: 2px;
          font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        .status-badge {
          display: inline-flex;
          align-items: center;
          padding: 2px 7px;
          border-radius: 999px;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          border: 1px solid var(--card-border);
          background: var(--bg-soft);
          color: var(--text);
        }
        .status-badge.ok {
          border-color: rgba(34, 197, 94, 0.6);
          color: #86efac;
          background: rgba(20, 83, 45, 0.35);
        }
        .status-badge.warn {
          border-color: rgba(245, 158, 11, 0.62);
          color: #fcd34d;
          background: rgba(120, 53, 15, 0.32);
        }
        .status-badge.danger {
          border-color: rgba(239, 68, 68, 0.62);
          color: #fca5a5;
          background: rgba(127, 29, 29, 0.32);
        }
        .table-controls {
          display: flex;
          gap: 6px;
          align-items: center;
          flex-wrap: wrap;
          margin: 0 0 8px;
        }
        .table-controls input, .table-controls select {
          width: auto;
          min-width: 150px;
        }
        .token-box {
          border: 1px dashed rgba(193, 120, 80, 0.42);
          border-radius: var(--radius-sm);
          padding: 8px;
          background: var(--bg-soft);
          word-break: break-all;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 12px;
        }
        /* ── Loading spinner ── */
        .loading-spinner {
          width: 20px; height: 20px;
          border: 2px solid var(--card-border);
          border-top-color: var(--brand);
          border-radius: 50%;
          animation: spin 0.7s linear infinite;
          display: inline-block;
        }
        .loading-spinner.sm { width: 14px; height: 14px; border-width: 2px; }
        .loading-spinner.lg { width: 32px; height: 32px; border-width: 3px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .loading-state {
          display: flex; align-items: center; gap: 8px;
          color: var(--muted); font-size: 12px; padding: 12px 0;
        }
        /* ── Toast ── */
        #toast {
          position: fixed;
          top: 12px;
          right: 12px;
          width: min(420px, calc(100vw - 32px));
          z-index: 100;
          margin: 0;
          animation: slideInRight 0.3s ease;
        }
        @keyframes slideInRight {
          from { opacity: 0; transform: translateX(40px); }
          to { opacity: 1; transform: translateX(0); }
        }
        .hidden { display: none !important; }
        /* ── Mobile responsive ── */
        @media (max-width: 920px) {
          .grid2 { grid-template-columns: 1fr; }
          .kpis { grid-template-columns: 1fr 1fr; }
        }
        @media (max-width: 680px) {
          .kpis { grid-template-columns: 1fr; }
          .topbar-nav { display: none; }
          .topbar-nav.mobile-open {
            display: flex; flex-direction: column;
            position: absolute; top: 100%; left: 0; right: 0;
            background: var(--bg-soft); border-bottom: 1px solid var(--card-border);
            padding: 8px 16px; gap: 2px; z-index: 49;
            animation: fadeSlideIn 0.2s ease;
          }
          .topbar-nav.mobile-open .topbar-nav-link {
            padding: 10px 12px; width: 100%; border-radius: var(--radius-sm);
          }
          .hamburger-btn { display: block; }
          .topbar-nav-link .nav-label { display: inline; }
          .topbar-right .topbar-credits { font-size: 10px; padding: 3px 6px; }
        }
        @media (min-width: 681px) {
          .topbar-nav-link .nav-label { display: none; }
        }
        @media (min-width: 900px) {
          .topbar-nav-link .nav-label { display: inline; }
        }
      </style>
    </head>
    <body>
      <div class="topbar">
        <div class="topbar-left">
          <a href="/portal/dashboard">
            <div class="mark">E</div>
            <span class="topbar-title">EdgeCoder</span>
          </a>
          <button class="hamburger-btn" id="hamburgerBtn" aria-label="Menu">&#9776;</button>
          <nav class="topbar-nav" id="topbarNav">
            ${navHtml}
          </nav>
        </div>
        <div class="topbar-right">
          <span class="topbar-credits" id="topTickerCredits" title="Credits"><span class="loading-spinner sm"></span></span>
          <a class="topbar-icon" id="logoutBtn" href="#" title="Sign out">&#10140;</a>
        </div>
      </div>
      <div class="shell">
        <div class="content-stack" style="padding-top:12px;">
          ${input.content}
        </div>
      </div>
      <div id="toast" class="card hidden"></div>
      <script>
        const toast = document.getElementById("toast");
        const themePalettes = {
          warm: { "--bg": "#1a1a18", "--bg-soft": "#2f2f2d", "--bg-surface": "#3a3a37", "--bg-elevated": "#454542", "--bg-input": "#262624", "--card": "rgba(58, 58, 55, 0.96)", "--card-border": "rgba(214, 204, 194, 0.08)", "--border-strong": "rgba(214, 204, 194, 0.15)", "--text": "#f7f5f0", "--text-secondary": "#b8b0a4", "--muted": "#8a8478", "--brand": "#c17850", "--brand-2": "#d4895f" },
          midnight: { "--bg": "#0f0f1e", "--bg-soft": "#1a1a2e", "--bg-surface": "#252540", "--bg-elevated": "#30304a", "--bg-input": "#141428", "--card": "rgba(37, 37, 64, 0.96)", "--card-border": "rgba(99, 102, 241, 0.12)", "--border-strong": "rgba(99, 102, 241, 0.2)", "--text": "#e8e8f0", "--text-secondary": "#a0a0c0", "--muted": "#8888a0", "--brand": "#6366f1", "--brand-2": "#818cf8" },
          emerald: { "--bg": "#0f1e0f", "--bg-soft": "#1a2e1a", "--bg-surface": "#253025", "--bg-elevated": "#304030", "--bg-input": "#142814", "--card": "rgba(37, 48, 37, 0.96)", "--card-border": "rgba(34, 197, 94, 0.12)", "--border-strong": "rgba(34, 197, 94, 0.2)", "--text": "#e8f0e8", "--text-secondary": "#a0c0a0", "--muted": "#88a088", "--brand": "#22c55e", "--brand-2": "#4ade80" }
        };
        function applyTheme(theme) {
          const palette = themePalettes[theme] || themePalettes.warm;
          for (const [key, value] of Object.entries(palette)) document.documentElement.style.setProperty(key, value);
        }
        function showToast(message, isError = false) {
          toast.textContent = message;
          toast.classList.remove("hidden");
          toast.style.borderColor = isError ? "#ef4444" : "#22c55e";
          setTimeout(() => toast.classList.add("hidden"), 5000);
        }
        async function api(path, options = {}) {
          const res = await fetch(path, {
            credentials: "include",
            headers: { "content-type": "application/json", ...(options.headers || {}) },
            ...options
          });
          let payload = null;
          try { payload = await res.json(); } catch {}
          if (!res.ok) throw new Error(payload && payload.error ? payload.error : String(res.status));
          return payload;
        }
        async function requireAuth() {
          try {
            const me = await api("/me", { method: "GET", headers: {} });
            applyTheme("warm");
            return me;
          } catch {
            window.location.href = "/portal";
            throw new Error("not_authenticated");
          }
        }
        function statusBadge(text, tone = "neutral") {
          const toneClass = tone === "ok" ? "ok" : tone === "warn" ? "warn" : tone === "danger" ? "danger" : "";
          return "<span class='status-badge " + toneClass + "'>" + String(text) + "</span>";
        }
        function boolBadge(value, trueLabel = "YES", falseLabel = "NO") {
          return value ? statusBadge(trueLabel, "ok") : statusBadge(falseLabel, "warn");
        }
        /* ── Hamburger toggle ── */
        (function() {
          var btn = document.getElementById("hamburgerBtn");
          var nav = document.getElementById("topbarNav");
          if (btn && nav) {
            btn.addEventListener("click", function() {
              nav.classList.toggle("mobile-open");
            });
            document.addEventListener("click", function(e) {
              if (!btn.contains(e.target) && !nav.contains(e.target)) {
                nav.classList.remove("mobile-open");
              }
            });
          }
        })();
        /* ── Top ticker and reviews badge ── */
        async function loadTopTicker() {
          try {
            await requireAuth();
            var summary = await api("/dashboard/summary", { method: "GET", headers: {} });
            var credits = (summary.walletSnapshot || {}).credits;
            var creditVal = credits && typeof credits.balance !== "undefined" ? String(credits.balance) : "n/a";
            document.getElementById("topTickerCredits").textContent = creditVal + " credits";
          } catch {
            document.getElementById("topTickerCredits").textContent = "-";
          }
        }
        async function loadReviewsBadge() {
          try {
            var res = await api("/portal/api/reviews");
            var reviews = res.reviews || [];
            var badge = document.getElementById("reviewsBadge");
            if (badge && reviews.length > 0) {
              badge.textContent = String(reviews.length);
              badge.style.display = "inline-flex";
            }
          } catch { /* noop */ }
        }
        document.getElementById("logoutBtn").addEventListener("click", async (e) => {
          e.preventDefault();
          try {
            await api("/auth/logout", { method: "POST", body: JSON.stringify({}) });
          } finally {
            window.location.href = "/";
          }
        });
        loadTopTicker();
        loadReviewsBadge();
      </script>
      <script>
        ${input.script}
      </script>
    </body>
  </html>`;
}
