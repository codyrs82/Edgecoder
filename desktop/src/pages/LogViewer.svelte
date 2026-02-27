<script lang="ts">
  import { getHealth, getStatus, getDashboardOverview, backendReady, isRemoteMode } from "../lib/api";

  // --- Types ---
  interface LogEntry {
    timestamp: string;
    level: "info" | "warn" | "error";
    message: string;
  }

  // --- State ---
  let logs: LogEntry[] = $state([]);
  let filter: "all" | "info" | "warn" | "error" = $state("all");
  let autoScroll = $state(true);
  let prevResults = $state(-1);
  let visibleLimit = $state(100);
  let lastErrorMsg = $state("");
  let polling = $state(false);

  // Derived filtered logs — capped at visibleLimit for DOM perf
  let allFilteredLogs = $derived(
    filter === "all" ? logs : logs.filter((e) => e.level === filter)
  );
  let filteredLogs = $derived(allFilteredLogs.slice(0, visibleLimit));
  let hasMore = $derived(allFilteredLogs.length > visibleLimit);

  // Reference for the scroll container
  let scrollContainer: HTMLDivElement | undefined = $state(undefined);

  // --- Helpers ---
  function now(): string {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");
  }

  function addEntry(level: LogEntry["level"], message: string) {
    // Deduplicate consecutive identical errors
    if (level === "error" && message === lastErrorMsg) return;
    if (level === "error") lastErrorMsg = message;
    else lastErrorMsg = "";
    logs = [{ timestamp: now(), level, message }, ...logs].slice(0, 500);
  }

  function clearLogs() {
    logs = [];
    prevResults = -1;
    visibleLimit = 100;
    lastErrorMsg = "";
  }

  // Auto-scroll effect: scroll to top when new entries are prepended (newest-first)
  $effect(() => {
    // Access logs.length to register the dependency
    const _len = logs.length;
    if (autoScroll && scrollContainer) {
      scrollContainer.scrollTop = 0;
    }
  });

  // --- Polling ---
  async function poll() {
    if (polling) return; // skip if previous poll still in-flight
    polling = true;
    try {
      const [health, status] = await Promise.all([
        getHealth(),
        getStatus(),
      ]);

      // Main health line
      addEntry(
        "info",
        `Health OK | agents=${status.agents} queued=${status.queued} results=${status.results}`
      );

      // Check if results increased
      if (prevResults >= 0 && status.results > prevResults) {
        const delta = status.results - prevResults;
        addEntry("info", `+${delta} task(s) completed`);
      }
      prevResults = status.results;

      // Ollama reachability
      if (!health.ollama.reachable) {
        addEntry("warn", "Ollama unreachable");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Poll error";
      addEntry("error", msg);
    } finally {
      polling = false;
    }
  }

  // Mount: start polling
  $effect(() => {
    addEntry("info", "Log viewer started");
    backendReady.then(() => {
      if (isRemoteMode()) {
        addEntry("warn", "No local agent running — logs require a local agent");
        return;
      }
      poll();
    });
    const interval = setInterval(() => {
      if (!isRemoteMode()) poll();
    }, 5000);
    return () => clearInterval(interval);
  });
</script>

<div class="log-viewer">
  <div class="header">
    <h1>Activity Log</h1>
    <div class="controls">
      <div class="filter-tabs">
        {#each ["all", "info", "warn", "error"] as tab}
          <button
            class="tab {filter === tab ? 'active' : ''} {tab !== 'all' ? `tab-${tab}` : ''}"
            onclick={() => (filter = tab as typeof filter)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
            {#if tab !== "all"}
              <span class="tab-count">
                {logs.filter((e) => tab === "all" || e.level === tab).length}
              </span>
            {/if}
          </button>
        {/each}
      </div>
      <label class="auto-scroll-toggle">
        <input type="checkbox" bind:checked={autoScroll} />
        <span>Auto-scroll</span>
      </label>
      <button class="btn-clear" onclick={clearLogs}>Clear</button>
    </div>
  </div>

  <div class="log-container" bind:this={scrollContainer}>
    {#if filteredLogs.length === 0}
      <div class="empty">No log entries{filter !== "all" ? ` for "${filter}"` : ""}</div>
    {:else}
      {#each filteredLogs as entry}
        <div class="log-line">
          <span class="ts">{entry.timestamp}</span>
          <span class="level-badge level-{entry.level}">{entry.level.toUpperCase()}</span>
          <span class="msg">{entry.message}</span>
        </div>
      {/each}
      {#if hasMore}
        <button class="btn-show-more" onclick={() => (visibleLimit += 100)}>
          Show more ({allFilteredLogs.length - visibleLimit} remaining)
        </button>
      {/if}
    {/if}
  </div>

  <div class="footer">
    <span class="entry-count">{logs.length} entries (showing {filteredLogs.length} of {allFilteredLogs.length})</span>
  </div>
</div>

<style>
  .log-viewer {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    height: 100%;
    box-sizing: border-box;
  }

  .header {
    flex-shrink: 0;
    margin-bottom: 1rem;
  }

  h1 {
    margin: 0 0 0.75rem;
    font-size: 1.4rem;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .filter-tabs {
    display: flex;
    gap: 0;
    border: 1px solid var(--border, #1e1e3f);
    border-radius: 6px;
    overflow: hidden;
  }

  .tab {
    padding: 0.35rem 0.75rem;
    background: var(--bg-surface, #1a1a2e);
    color: var(--text-muted, #94a3b8);
    border: none;
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    transition: background 0.15s, color 0.15s;
    border-right: 1px solid var(--border, #1e1e3f);
  }

  .tab:last-child {
    border-right: none;
  }

  .tab:hover {
    background: #1e1e4f;
  }

  .tab.active {
    background: var(--accent, #3b82f6);
    color: white;
  }

  .tab-count {
    font-size: 0.7rem;
    opacity: 0.7;
  }

  .auto-scroll-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    color: var(--text-muted, #94a3b8);
    cursor: pointer;
    margin-left: auto;
  }

  .auto-scroll-toggle input {
    accent-color: var(--accent, #3b82f6);
  }

  .btn-clear {
    padding: 0.35rem 0.7rem;
    background: transparent;
    color: var(--text-muted, #94a3b8);
    border: 1px solid var(--border, #1e1e3f);
    border-radius: 5px;
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 600;
    transition: color 0.15s, border-color 0.15s;
  }

  .btn-clear:hover {
    color: var(--red, #f87171);
    border-color: var(--red, #f87171);
  }

  /* Log container */
  .log-container {
    flex: 1;
    overflow-y: auto;
    background: #0a0a15;
    border: 1px solid var(--border, #1e1e3f);
    border-radius: 8px;
    padding: 0.5rem;
    font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
    font-size: 0.78rem;
    line-height: 1.7;
    min-height: 300px;
    contain: content;
  }

  .empty {
    color: var(--text-muted, #94a3b8);
    text-align: center;
    padding: 3rem 1rem;
    opacity: 0.6;
    font-family: inherit;
  }

  .log-line {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    transition: background 0.1s;
  }

  .log-line:hover {
    background: rgba(255, 255, 255, 0.03);
  }

  .ts {
    color: var(--text-muted, #94a3b8);
    opacity: 0.6;
    flex-shrink: 0;
    min-width: 5.5em;
  }

  .level-badge {
    font-size: 0.65rem;
    font-weight: 700;
    padding: 0.05rem 0.4rem;
    border-radius: 3px;
    text-align: center;
    min-width: 3.5em;
    flex-shrink: 0;
  }

  .level-info {
    color: var(--accent, #3b82f6);
    background: rgba(59, 130, 246, 0.12);
  }

  .level-warn {
    color: var(--yellow, #fbbf24);
    background: rgba(251, 191, 36, 0.12);
  }

  .level-error {
    color: var(--red, #f87171);
    background: rgba(248, 113, 113, 0.12);
  }

  .msg {
    flex: 1;
    word-break: break-word;
  }

  .btn-show-more {
    display: block;
    width: 100%;
    margin-top: 0.5rem;
    padding: 0.4rem;
    background: var(--bg-surface, #1a1a2e);
    color: var(--accent, #3b82f6);
    border: 1px solid var(--border, #1e1e3f);
    border-radius: 5px;
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 600;
    text-align: center;
    transition: background 0.15s;
  }

  .btn-show-more:hover {
    background: #1e1e4f;
  }

  /* Footer */
  .footer {
    flex-shrink: 0;
    margin-top: 0.5rem;
    display: flex;
    justify-content: flex-end;
  }

  .entry-count {
    font-size: 0.75rem;
    color: var(--text-muted, #94a3b8);
    opacity: 0.6;
  }
</style>
