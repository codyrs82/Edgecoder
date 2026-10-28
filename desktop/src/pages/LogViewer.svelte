<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getHealth, getStatus, backendReady, isRemoteMode } from "../lib/api";
  import { visibleRange } from "../lib/virtual-list";

  // --- Types ---
  interface LogEntry {
    seq: number;
    timestamp: string;
    level: "info" | "warn" | "error";
    message: string;
  }

  // --- State ---
  let logs: LogEntry[] = $state([]);
  let filter: "all" | "info" | "warn" | "error" = $state("all");
  let autoScroll = $state(true);
  let prevResults = $state(-1);
  let lastErrorMsg = $state("");
  let polling = false;
  let seq = 0;
  let pollInterval: ReturnType<typeof setInterval> | undefined;

  // #28: the list is virtualized (only the rows in view are in the DOM), so the
  // history can be much longer than the old 500-entry / "Show more" cap.
  const MAX_ENTRIES = 5000;
  const ROW_HEIGHT = 22; // px; rows are single-line (full text in the title tooltip)
  let allFilteredLogs = $derived(
    filter === "all" ? logs : logs.filter((e) => e.level === filter)
  );
  let counts = $derived(
    logs.reduce((c, e) => { c[e.level]++; return c; }, { info: 0, warn: 0, error: 0 })
  );
  let scrollTop = $state(0);
  let viewportHeight = $state(400);
  let range = $derived(visibleRange(scrollTop, viewportHeight, ROW_HEIGHT, allFilteredLogs.length));
  let rows = $derived(allFilteredLogs.slice(range.start, range.end));

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
    const entry = { seq: ++seq, timestamp: now(), level, message };
    logs = [entry, ...logs].slice(0, MAX_ENTRIES);
    // Keep the rows the user is reading still: prepending pushes them down by one row.
    if (scrollContainer && !(autoScroll) && scrollContainer.scrollTop > 0 && (filter === "all" || filter === level)) {
      scrollContainer.scrollTop += ROW_HEIGHT;
      scrollTop = scrollContainer.scrollTop;
    }
  }

  function clearLogs() {
    logs = [];
    prevResults = -1;
    lastErrorMsg = "";
  }

  // Auto-scroll effect: scroll to top when new entries are prepended (newest-first)
  $effect(() => {
    // Access logs.length to register the dependency
    const _len = logs.length;
    if (autoScroll && scrollContainer) {
      scrollContainer.scrollTop = 0;
      scrollTop = 0;
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

  // Mount: start polling (use onMount to avoid $effect reactivity loops)
  onMount(() => {
    addEntry("info", "Log viewer started");
    backendReady.then(() => {
      if (isRemoteMode()) {
        addEntry("warn", "No local agent running — logs require a local agent");
        return;
      }
      poll();
    });
    pollInterval = setInterval(() => {
      if (!isRemoteMode()) poll();
    }, 5000);
  });

  onDestroy(() => {
    if (pollInterval) clearInterval(pollInterval);
  });
</script>

<div class="log-viewer">
  <div class="header">
    <h1>Activity Log</h1>
    <div class="controls">
      <div class="filter-tabs" role="group" aria-label="Filter by level">
        {#each ["all", "info", "warn", "error"] as const as tab}
          <button
            type="button"
            class="tab {filter === tab ? 'active' : ''} {tab !== 'all' ? `tab-${tab}` : ''}"
            aria-pressed={filter === tab}
            onclick={() => (filter = tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
            {#if tab !== "all"}
              <span class="tab-count">{counts[tab]}</span>
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

  <!-- Focusable so keyboard users can scroll it (axe: scrollable-region-focusable). -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="log-container"
    bind:this={scrollContainer}
    bind:clientHeight={viewportHeight}
    onscroll={(e) => (scrollTop = (e.currentTarget as HTMLDivElement).scrollTop)}
    role="log"
    aria-label="Activity log, newest first"
    tabindex="0"
  >
    {#if allFilteredLogs.length === 0}
      <div class="empty">No log entries{filter !== "all" ? ` for "${filter}"` : ""}</div>
    {:else}
      <div style="height: {range.padTop}px" aria-hidden="true"></div>
      {#each rows as entry (entry.seq)}
        <div class="log-line" style="height: {ROW_HEIGHT}px" title={entry.message}>
          <span class="ts">{entry.timestamp}</span>
          <span class="level-badge level-{entry.level}">{entry.level.toUpperCase()}</span>
          <span class="msg">{entry.message}</span>
        </div>
      {/each}
      <div style="height: {range.padBottom}px" aria-hidden="true"></div>
    {/if}
  </div>

  <div class="footer">
    <span class="entry-count">{logs.length} entries ({allFilteredLogs.length} shown by filter, max {MAX_ENTRIES})</span>
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
    background: var(--bg-base, #0a0a15);
    border: 1px solid var(--border, #1e1e3f);
    border-radius: var(--radius-md, 8px);
    padding: 0.5rem;
    font-family: var(--font-mono, "SF Mono", "Fira Code", "Cascadia Code", monospace);
    font-size: 0.78rem;
    line-height: 1.7;
    min-height: 300px;
    contain: content;
  }

  .log-container:focus-visible,
  .tab:focus-visible,
  .btn-clear:focus-visible {
    outline: 2px solid var(--accent, #3b82f6);
    outline-offset: 2px;
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
    align-items: center;
    box-sizing: border-box;
    overflow: hidden;
    white-space: nowrap;
    gap: 0.6rem;
    padding: 0 0.4rem;
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
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
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
