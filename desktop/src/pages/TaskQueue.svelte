<script lang="ts">
  // Settings → Tasks: your history on this computer, from the stores that already keep it (the
  // app's chat and Code conversations, `edgecoder code` sessions, bot runs, helpers, recent API calls
  // and the network's usage records), merged in lib/task-history.ts.
  import { onMount } from "svelte";
  import { Download, RefreshCw } from "@lucide/svelte";
  import { backendReady, botHistory, getRecentActivity, getSession, getUsage, isRemoteMode, listAllSessions, listBots, sessionTentacles } from "../lib/api";
  import { listConversations } from "../lib/chat-store";
  import { filterTasks, KIND_LABEL, mergeTaskHistory, STATUS_LABEL, tasksCsv, type HistorySources, type TaskFilter, type TaskKind, type TaskRow, type TaskStatus } from "../lib/task-history";
  import { elapsedText } from "../lib/activity-view";
  import { scrollRegion } from "../lib/scroll-region";
  import EmptyNote from "../components/EmptyNote.svelte";
  import StatusPill from "../components/StatusPill.svelte";
  import ServiceNotice from "../components/ServiceNotice.svelte";
  import { onServiceReady, serviceStatus } from "../lib/service-status";

  const MAX_SESSIONS = 20;
  const SHOWN = 300;
  const RANGES: Array<{ value: string; label: string; ms: number }> = [
    { value: "1d", label: "Last 24 hours", ms: 86_400_000 },
    { value: "7d", label: "Last 7 days", ms: 7 * 86_400_000 },
    { value: "30d", label: "Last 30 days", ms: 30 * 86_400_000 },
    { value: "all", label: "Any time", ms: 0 },
  ];

  let rows = $state<TaskRow[]>([]);
  let loading = $state(true);
  let unread = $state<string[]>([]);
  let kind = $state<TaskKind | "all">("all");
  let status = $state<TaskStatus | "all">("all");
  let range = $state("30d");
  let query = $state("");
  let open = $state<string | null>(null);
  let loadedAt = $state(Date.now());

  async function settle<T>(name: string, p: Promise<T>, failed: string[]): Promise<T | undefined> {
    try {
      return await p;
    } catch {
      failed.push(name);
      return undefined;
    }
  }

  async function load() {
    loading = true;
    await backendReady;
    const failed: string[] = [];
    // While the local service starts or restarts its parts aren't "couldn't read": the notice says
    // it's starting, and the page loads again once it answers.
    const serviceUp = $serviceStatus.phase === "ready";
    const local = !isRemoteMode() && serviceUp;
    const [conversations, bots, sessions, recent, usage] = await Promise.all([
      settle("chats", listConversations(), failed),
      local ? settle("bots", listBots().then((list) => Promise.all(list.map(async (bot) => ({ bot, runs: await botHistory(bot.id).catch(() => []) })))), failed) : undefined,
      local
        ? settle("sessions", listAllSessions().then((list) =>
            Promise.all(
              list.slice(0, MAX_SESSIONS).map(async (s) => {
                const [snap, tent] = await Promise.all([getSession(s.id).catch(() => null), sessionTentacles(s.id).catch(() => null)]);
                return { id: s.id, title: s.title, model: s.model, transcript: snap?.session.transcript ?? [], tentacles: tent?.tentacles ?? [] };
              }),
            )), failed)
        : undefined,
      local ? settle("recent API calls", getRecentActivity(), failed) : undefined,
      // Not enrolled answers 409: no network usage to add, not a failure.
      local ? getUsage(30).then((u) => u.records).catch(() => undefined) : undefined,
    ]);
    const src: HistorySources = { conversations, bots, sessions, recent, usage };
    rows = mergeTaskHistory(src);
    unread = failed;
    loadedAt = Date.now();
    loading = false;
  }
  onMount(() => {
    void load();
    return onServiceReady(() => void load());
  });

  let filter = $derived<TaskFilter>({ kind, status, query, sinceMs: (() => { const r = RANGES.find((x) => x.value === range); return r && r.ms ? loadedAt - r.ms : 0; })() });
  let shown = $derived(filterTasks(rows, filter));

  const fmt = (n: number, d = 3) => n.toLocaleString(undefined, { maximumFractionDigits: d });
  const tok = (n: number | null) => (n === null ? "" : n >= 1000 ? `${fmt(n / 1000, 1)}k` : String(n));
  const when = (ms: number) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  function exportCsv() {
    const url = URL.createObjectURL(new Blob([tasksCsv(shown)], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `edgecoder-tasks-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
</script>

<div class="sp sp-wide">
  <h1>Tasks</h1>
  <p class="sp-lead">Everything you ran from this computer: chats, Code turns, bot runs, helper jobs and API calls, with where each ran and what it cost.</p>

  <section class="sp-group" aria-labelledby="tq-history">
    <h2 class="sp-group-title" id="tq-history">
      History
      <span class="sp-link actions">
        <button class="small" onclick={() => void load()} disabled={loading}><RefreshCw size={13} aria-hidden="true" /> Refresh</button>
        <button class="small" onclick={exportCsv} disabled={!shown.length}><Download size={13} aria-hidden="true" /> CSV</button>
      </span>
    </h2>

    <div class="filters" role="group" aria-label="Filter tasks">
      <div class="sp-seg" role="group" aria-label="Kind">
        {#each [["all", "All"], ...Object.entries(KIND_LABEL)] as [k, label]}
          <button aria-pressed={kind === k} class:active={kind === k} onclick={() => (kind = k as TaskKind | "all")}>{label}</button>
        {/each}
      </div>
      <label class="field">Status
        <select bind:value={status}>
          <option value="all">Any status</option>
          {#each Object.entries(STATUS_LABEL) as [v, label]}<option value={v}>{label}</option>{/each}
        </select>
      </label>
      <label class="field">Time
        <select bind:value={range}>
          {#each RANGES as r}<option value={r.value}>{r.label}</option>{/each}
        </select>
      </label>
      <label class="field grow"><span class="sr-only">Search tasks</span>
        <input type="search" placeholder="Search what, where, model or error" bind:value={query} />
      </label>
    </div>

    {#if $serviceStatus.phase !== "ready"}<ServiceNotice />{/if}
    {#if unread.length}<p class="sp-warn" role="status">Couldn't read: {unread.join(", ")}. The rest is shown.</p>{/if}

    <div class="sp-card">
      {#if loading && !rows.length}
        <div class="sp-row"><span class="sp-muted">Loading…</span></div>
      {:else if !rows.length}
        <EmptyNote title="No tasks yet." description="Chats, Code turns, bot runs, helper jobs and API calls you run from this computer show here, with where each ran, its tokens and its cost." />
      {:else if !shown.length}
        <EmptyNote title="Nothing matches these filters." description="Try another kind, status or time range, or clear the search." />
      {:else}
        <div class="sp-table-scroll" role="group" aria-labelledby="tq-history" use:scrollRegion>
          <table>
            <thead><tr><th scope="col">When</th><th scope="col" class="what-col">What</th><th scope="col" class="where-col">Where it ran</th><th scope="col" class="num">Tokens in / out</th><th scope="col" class="num">cSats</th><th scope="col">Status</th><th scope="col" class="num">Time</th></tr></thead>
            <tbody>
              {#each shown.slice(0, SHOWN) as r (r.id)}
                <tr class:failed={r.status === "failed"}>
                  <td class="sp-muted">{when(r.atMs)}</td>
                  <td class="what">
                    <button class="link" title={r.title} aria-expanded={open === r.id} aria-controls="task-{r.id}" onclick={() => (open = open === r.id ? null : r.id)}>
                      <span class="kind">{KIND_LABEL[r.kind]}</span> {r.title}
                    </button>
                    {#if r.context}<div class="sp-muted ctx">{r.context}</div>{/if}
                  </td>
                  <td class="where"><span class="where-text" title={r.where ?? undefined}>{r.where ?? "–"}</span></td>
                  <td class="num">{r.promptTokens === null && r.outputTokens === null ? "–" : `${tok(r.promptTokens) || "0"} / ${tok(r.outputTokens) || "0"}`}</td>
                  <td class="num">{r.cSats === null ? "–" : fmt(r.cSats)}{#if r.usd}<div class="sp-muted">${r.usd.toFixed(2)}</div>{/if}</td>
                  <td><StatusPill status={r.status} />{#if r.error}<div class="sp-err reason">{r.error}</div>{/if}</td>
                  <td class="num">{r.durationMs === null ? "–" : elapsedText(r.durationMs)}</td>
                </tr>
                {#if open === r.id}
                  <tr class="details" id="task-{r.id}">
                    <td colspan="7">
                      <dl>
                        <dt>Asked</dt><dd>{r.title}</dd>
                        {#if r.context}<dt>In</dt><dd>{r.context}</dd>{/if}
                        {#if r.model}<dt>Model</dt><dd>{r.model}</dd>{/if}
                        <dt>Where</dt><dd>{r.where ?? "Not recorded"}</dd>
                        {#if r.error}<dt>Error</dt><dd class="sp-err">{r.error}</dd>{/if}
                      </dl>
                      {#if r.steps.length}
                        <p class="sp-muted steps-title">Steps and tool calls ({r.steps.length})</p>
                        <ol class="steps">{#each r.steps as s}<li><code>{s}</code></li>{/each}</ol>
                      {:else}
                        <p class="sp-muted">No tool calls.</p>
                      {/if}
                    </td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </div>
        {#if shown.length > SHOWN}<div class="sp-row"><span class="sp-muted">Showing the newest {SHOWN} of {shown.length}. Narrow the filters or export CSV for all of them.</span></div>{/if}
      {/if}
    </div>
  </section>
</div>

<style>
  .actions { display: inline-flex; gap: 6px; }
  .filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .field { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-xs); color: var(--text-secondary); }
  .field.grow { flex: 1 1 200px; }
  .field.grow input { width: 100%; }
  /* What and Where share the spare width; each line is cut with an ellipsis (the full text is in
     the tooltip and the row's details) instead of wrapping into a tall stack;
     max-width: 0 lets the percentage, not the untruncated text, size the column.
  */
  .what-col, .what { width: 45%; min-width: 220px; max-width: 0; }
  .where-col, .where { width: 30%; min-width: 180px; max-width: 0; }
  .what .link { all: unset; cursor: pointer; color: var(--text-primary); display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .where-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; white-space: normal; }
  .what .link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
  .what .kind { font-size: 11px; color: var(--text-secondary); margin-right: 4px; }
  .ctx { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.sp-muted, th { white-space: nowrap; }
  /* A narrow pane: tighter cells, and the headers may take two lines, so What and Where
     keep a readable width without the table scrolling sideways at a ~900px window. */
  @container settings-pane (max-width: 760px) {
    th, td { padding: 8px; }
    th { white-space: normal; }
    .what-col, .what { min-width: 130px; }
    .where-col, .where { min-width: 110px; }
  }
  .reason { max-width: 220px; white-space: normal; }
  tr.details td { background: var(--bg-base); }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0 0 8px; }
  dt { color: var(--text-secondary); }
  dd { margin: 0; white-space: normal; overflow-wrap: anywhere; }
  .steps-title { margin: 8px 0 4px; }
  .steps { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 2px; }
  .steps code { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
