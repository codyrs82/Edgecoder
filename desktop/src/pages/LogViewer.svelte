<script lang="ts">
  // Settings → Logs: the app's real log (~/.edgecoder/agent.log: the coordinator, inference, IDE
  // server and agent), live from the IDE server's /v1/ide/logs, as "time · service · level · message".
  // Routine polling is folded away by default; warnings and errors are highlighted.
  import { tick } from "svelte";
  import { Copy, Pause, Play } from "@lucide/svelte";
  import { backendReady, computeErrorText, getLogTail, isRemoteMode, type LogSourceInfo } from "../lib/api";
  import { filterRows, LogParser, rowTime, supportText, type LogLevel, type LogRow } from "../lib/log-parse";
  import { livePoll } from "../lib/live-poll";
  import { scrollRegion } from "../lib/scroll-region";
  import EmptyNote from "../components/EmptyNote.svelte";
  import ServiceNotice from "../components/ServiceNotice.svelte";
  import { onServiceReady, serviceStatus } from "../lib/service-status";

  let { pollMs = 2000 }: { pollMs?: number } = $props();

  /** Rows kept in memory, and the newest drawn (the rest are in the file and in "Copy for support"). */
  const MAX_ROWS = 5000;
  const SHOWN = 400;

  let source = $state("agent");
  let sources = $state<LogSourceInfo[]>([]);
  let rows = $state<LogRow[]>([]);
  let exists = $state(true);
  let truncated = $state(false);
  let error = $state("");
  let loading = $state(true);
  let remote = $state(false);
  let follow = $state(true);
  let hideRoutine = $state(true);
  let levels = $state<Record<"error" | "warn" | "info", boolean>>({ error: true, warn: true, info: true });
  let service = $state("");
  let query = $state("");
  let maskEmails = $state(true);
  let copied = $state("");
  let announce = $state("");

  let parser = new LogParser();
  let offset: number | undefined;
  let scroller: HTMLDivElement | undefined = $state();

  async function fetchMore() {
    await backendReady;
    if (isRemoteMode()) {
      remote = true;
      loading = false;
      return;
    }
    // Read through the local service: while it starts or restarts, ServiceNotice says so instead.
    if ($serviceStatus.phase !== "ready") {
      loading = false;
      return;
    }
    const src = source;
    try {
      const t = await getLogTail(src, offset);
      if (src !== source) return; // switched while it was loading
      sources = t.sources;
      exists = t.exists;
      if (t.reset) {
        parser.reset();
        rows = [];
      }
      if (offset === undefined) truncated = t.truncated;
      offset = t.next;
      const added = parser.push(t.lines);
      if (added.length) {
        rows = rows.length + added.length > MAX_ROWS ? [...rows, ...added].slice(-MAX_ROWS) : [...rows, ...added];
        const errors = added.filter((r) => r.level === "error").length;
        if (errors && offset !== undefined && !loading) announce = `${errors} new error${errors === 1 ? "" : "s"} in the log`;
        if (follow) {
          await tick();
          if (scroller) scroller.scrollTop = scroller.scrollHeight;
        }
      }
      error = "";
    } catch (e) {
      error = computeErrorText(e);
    } finally {
      loading = false;
    }
  }

  // Follow: poll every 2 s while visible. Paused: nothing new is read until it follows again.
  $effect(() => {
    if (!follow) return;
    void source;
    const poll = livePoll(fetchMore, pollMs);
    const offReady = onServiceReady(() => void poll.now());
    return () => {
      poll.stop();
      offReady();
    };
  });

  function switchSource(id: string) {
    source = id;
    parser = new LogParser();
    offset = undefined;
    rows = [];
    truncated = false;
    loading = true;
    service = "";
    if (!follow) void fetchMore();
  }

  let levelSet = $derived(new Set(Object.entries(levels).filter(([, on]) => on).map(([k]) => k as LogLevel)));
  let filtered = $derived(filterRows(rows, { levels: levelSet, service, query, hideRoutine }));
  let shown = $derived(filtered.slice(-SHOWN));
  let routineHidden = $derived(hideRoutine ? rows.filter((r) => r.routine).length : 0);
  let services = $derived([...new Set(rows.map((r) => r.service))].sort());
  let counts = $derived(rows.reduce((c, r) => { if (r.level === "error") c.error++; else if (r.level === "warn") c.warn++; return c; }, { error: 0, warn: 0 }));

  async function copyForSupport() {
    const label = sources.find((s) => s.id === source)?.label ?? source;
    const text = supportText(rows, { max: 200, emails: maskEmails, source: label });
    try {
      await navigator.clipboard.writeText(text);
      const n = Math.min(200, rows.filter((r) => !r.routine).length);
      copied = `Copied ${n} line${n === 1 ? "" : "s"}, with credentials masked.`;
    } catch {
      copied = "Couldn't copy to the clipboard.";
    }
  }
</script>

<div class="sp sp-wide">
  <h1>Logs</h1>
  <p class="sp-lead">The app's own log, live: the agent, the coordinator, inference and the IDE server. Credentials are masked.</p>
  <p class="sr-only" aria-live="polite">{announce}</p>

  {#if remote}
    <div class="sp-card"><EmptyNote title="Not available in the web app" description="Logs are read from the computer running the EdgeCoder app. Open this page in the app." /></div>
  {:else}
    <div class="toolbar" role="group" aria-label="Log filters">
      {#if sources.length > 1}
        <label class="field">Log
          <select value={source} onchange={(e) => switchSource((e.currentTarget as HTMLSelectElement).value)}>
            {#each sources as s}<option value={s.id} disabled={!s.exists && s.id !== source}>{s.label}{s.exists ? "" : " (none)"}</option>{/each}
          </select>
        </label>
      {/if}
      <fieldset class="levels">
        <legend class="sr-only">Levels</legend>
        <label><input type="checkbox" bind:checked={levels.error} /> Errors{counts.error ? ` (${counts.error})` : ""}</label>
        <label><input type="checkbox" bind:checked={levels.warn} /> Warnings{counts.warn ? ` (${counts.warn})` : ""}</label>
        <label><input type="checkbox" bind:checked={levels.info} /> Info</label>
      </fieldset>
      <label class="field">Service
        <select bind:value={service}>
          <option value="">All</option>
          {#each services as s}<option value={s}>{s}</option>{/each}
        </select>
      </label>
      <label class="field grow"><span class="sr-only">Search the log</span>
        <input type="search" placeholder="Search" bind:value={query} />
      </label>
    </div>
    <div class="toolbar">
      <label><input type="checkbox" bind:checked={hideRoutine} /> Hide routine requests</label>
      <button class="small" aria-pressed={!follow} onclick={() => (follow = !follow)}>
        {#if follow}<Pause size={13} aria-hidden="true" /> Pause{:else}<Play size={13} aria-hidden="true" /> Follow{/if}
      </button>
      <span class="spacer"></span>
      <label class="mask"><input type="checkbox" bind:checked={maskEmails} /> Mask emails</label>
      <button class="small" onclick={copyForSupport} disabled={!rows.length}><Copy size={13} aria-hidden="true" /> Copy for support</button>
    </div>
    {#if copied}<p class="sp-muted" role="status">{copied}</p>{/if}
    {#if $serviceStatus.phase !== "ready"}
      <ServiceNotice />
    {:else if error}<p class="sp-err" role="alert">Couldn't read the log: {error}</p>{/if}

    <div class="sp-card">
      {#if loading && !rows.length}
        <div class="sp-row"><span class="sp-muted">Loading…</span></div>
      {:else if !exists}
        <EmptyNote title="This log doesn't exist yet." description="It is created the first time the app starts that part. Lines appear here as they are written." />
      {:else if !rows.length}
        <EmptyNote title="The log is empty." description="New lines appear here as the agent and services write them." />
      {:else if !shown.length}
        <EmptyNote title="No lines match these filters." description={routineHidden ? `${routineHidden} routine requests are hidden. Turn off "Hide routine requests" to see them.` : "Try other levels or clear the search."} />
      {:else}
        <div class="log-scroll" bind:this={scroller} role="group" aria-label="Log lines" use:scrollRegion>
          <table class="log">
            <thead><tr><th scope="col">Time</th><th scope="col">Service</th><th scope="col">Level</th><th scope="col">Message</th></tr></thead>
            <tbody>
              {#each shown as r (r.seq)}
                <tr class="lvl-{r.level}" class:plain={r.plain && r.level !== "info"}>
                  <td class="t">{rowTime(r)}</td>
                  <td class="svc">{r.service}</td>
                  <td class="lv">{r.level === "warn" ? "warning" : r.level}</td>
                  <td class="msg">{r.message}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      {#if rows.length}
        <div class="sp-row foot">
          <span class="sp-muted">
            {filtered.length > SHOWN ? `Newest ${SHOWN} of ${filtered.length} matching lines` : `${filtered.length} line${filtered.length === 1 ? "" : "s"}`}{routineHidden ? ` · ${routineHidden} routine requests hidden` : ""}{truncated ? " · older lines are in the file" : ""}{follow ? "" : " · paused"}
          </span>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: var(--fs-sm); color: var(--text-secondary); }
  .toolbar label { display: inline-flex; align-items: center; gap: 5px; }
  .field { font-size: var(--fs-xs); }
  .field.grow { flex: 1 1 160px; }
  .field.grow input { width: 100%; }
  .levels { border: none; margin: 0; padding: 0; display: inline-flex; gap: 10px; }
  .spacer { flex: 1; }
  .log-scroll { max-height: 60vh; overflow: auto; }
  table.log { font-family: var(--font-mono); font-size: 11.5px; }
  table.log th, table.log td { padding: 3px 10px; vertical-align: top; }
  table.log thead th { position: sticky; top: 0; background: var(--bg-surface); }
  .t, .svc, .lv { white-space: nowrap; color: var(--text-secondary); }
  .msg { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-primary); }
  tr.lvl-error .lv, tr.lvl-error .msg { color: var(--danger); }
  tr.lvl-warn .lv { color: var(--yellow); }
  tr.lvl-error { background: color-mix(in srgb, var(--danger) 7%, transparent); }
  tr.lvl-warn { background: color-mix(in srgb, var(--yellow) 6%, transparent); }
  tr.plain td.msg { font-weight: 600; }
  tr.plain td:first-child { box-shadow: inset 3px 0 0 currentColor; }
  tr.plain.lvl-warn td:first-child { color: var(--yellow); }
  tr.plain.lvl-error td:first-child { color: var(--danger); }
  .foot { min-height: 36px; padding: 6px 16px; }
</style>
