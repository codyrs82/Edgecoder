<script lang="ts">
  import { onMount } from "svelte";
  import { Download } from "@lucide/svelte";
  import { getUsage, computeErrorText, type UsageSummary, type UsageSlice } from "../lib/api";
  import { CLASS_LABELS, shortModel } from "../lib/compute-choice";
  import { budgetState, cSatsPerMillionTokens, loadBudget, monthToDate, saveBudget, usageCsv } from "../lib/usage-view";

  let days = $state(30);
  let data = $state<UsageSummary | null>(null);
  let error = $state("");
  let loading = $state(true);
  let tab = $state<"model" | "class" | "source" | "placement">("model");
  let budget = $state<number | null>(loadBudget());
  let budgetInput = $state(String(loadBudget() ?? ""));

  async function load() {
    loading = true;
    try {
      data = await getUsage(days);
      error = "";
    } catch (e) {
      error = computeErrorText(e);
    } finally {
      loading = false;
    }
  }
  onMount(load);

  const fmt = (n: number, d = 2) => n.toLocaleString(undefined, { maximumFractionDigits: d });
  const dur = (s: number) => (s < 90 ? `${fmt(s, 1)} s` : s < 5400 ? `${fmt(s / 60, 1)} min` : `${fmt(s / 3600, 1)} h`);
  const tokens = (n: number) => (n >= 1_000_000 ? `${fmt(n / 1_000_000, 2)}M` : n >= 1000 ? `${fmt(n / 1000, 1)}k` : String(n));
  const placementLabel: Record<string, string> = { network: "Network", mine: "My machines", reserved: "Reserved" };

  let slices = $derived<UsageSlice[]>(
    !data ? [] : tab === "model" ? data.byModel : tab === "class" ? data.byClass : tab === "source" ? data.bySource : data.byPlacement,
  );
  const sliceLabel = (key: string) =>
    tab === "class" ? CLASS_LABELS[key] ?? key : tab === "placement" ? placementLabel[key] ?? key : tab === "model" && key !== "other" ? shortModel(key) : key === "other" ? "Other" : key;

  let maxDay = $derived(Math.max(0.0001, ...(data?.byDay ?? []).map((d) => d.cSats)));
  let month = $derived(data ? monthToDate(data.byDay) : 0);
  let budgetInfo = $derived(budgetState(month, budget));
  let perMillion = $derived(data ? cSatsPerMillionTokens(data.totals) : null);

  function setBudget() {
    const v = Number(budgetInput);
    budget = Number.isFinite(v) && v > 0 ? v : null;
    saveBudget(budget);
  }

  function exportCsv() {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([usageCsv(data.records)], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `edgecoder-usage-${days}d.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
</script>

<div class="sp">
  <h1>Usage</h1>
  <p class="sp-lead">What you ran, where it ran and what it cost. Your own machines are free. Network model calls are paid per token and code jobs and reservations per second, in cSats (1 cSat = 1 sat).</p>

  <div class="sp-group">
    <div class="sp-group-title">
      <div class="sp-seg">
        {#each [7, 30, 90] as d}<button class:active={days === d} onclick={() => { days = d; void load(); }}>{d} days</button>{/each}
      </div>
      <button class="small sp-link" onclick={exportCsv} disabled={!data?.records.length}><Download size={13} /> CSV</button>
    </div>

    {#if error}<p class="sp-err">{error}</p>{/if}
    {#if loading && !data}
      <p class="sp-muted">Loading…</p>
    {:else if data}
      <div class="cards">
        <div class="sp-card stat"><span class="sp-desc">Spent</span><span class="sp-big">{fmt(data.totals.cSats)} <span class="sp-unit">cSats</span></span></div>
        <div class="sp-card stat"><span class="sp-desc">Requests</span><span class="sp-big">{data.totals.requests}</span>{#if data.totals.failed}<span class="sp-desc">{data.totals.failed} failed</span>{/if}</div>
        <div class="sp-card stat"><span class="sp-desc">Compute time</span><span class="sp-big">{dur(data.totals.seconds)}</span></div>
        <div class="sp-card stat">
          <span class="sp-desc">Tokens in / out</span>
          <span class="sp-big">{tokens(data.totals.promptTokens)} <span class="sp-unit">/ {tokens(data.totals.outputTokens)}</span></span>
          {#if perMillion !== null}<span class="sp-desc">{fmt(perMillion, 0)} cSats per million tokens</span>{/if}
        </div>
      </div>

      <div class="sp-card chart-card">
        <svg class="chart" viewBox="0 0 {data.byDay.length * 12} 100" preserveAspectRatio="none" role="img" aria-label="cSats spent per day">
          {#each data.byDay as d, i}
            {@const h = (d.cSats / maxDay) * 92}
            <rect x={i * 12 + 2} y={100 - h} width="8" height={Math.max(h, d.requests ? 1.5 : 0)} rx="1.5"><title>{d.day}: {fmt(d.cSats, 3)} cSats, {d.requests} requests</title></rect>
          {/each}
        </svg>
        <div class="axis"><span>{data.byDay[0]?.day}</span><span>{data.byDay.at(-1)?.day}</span></div>
      </div>
    {/if}
  </div>

  {#if data}
    <div class="sp-group">
      <div class="sp-group-title">Budget</div>
      <div class="sp-card">
        <div class="sp-row">
          <div class="sp-text">
            <span class="sp-title">{fmt(month)} cSats this month{budget ? ` of ${fmt(budget, 0)}` : ""}</span>
            <span class="sp-desc">
              {#if budgetInfo.level === "over"}<span class="sp-err">Over your monthly budget.</span>{:else if budgetInfo.level === "near"}<span class="sp-warn">{budgetInfo.percent}% of your monthly budget.</span>{:else if budget}{budgetInfo.percent}% used.{:else}Set a monthly budget to get a warning here.{/if}
              Connections can also have their own hard limit (Connect your tools).
            </span>
            {#if budget}<div class="meter"><div class="meter-fill {budgetInfo.level}" style="width: {Math.min(100, budgetInfo.percent)}%"></div></div>{/if}
          </div>
          <div class="sp-controls">
            <input type="number" min="0" step="100" placeholder="cSats / month" bind:value={budgetInput} style="width: 130px" aria-label="Monthly budget in cSats" />
            <button onclick={setBudget}>Save</button>
          </div>
        </div>
      </div>
    </div>

    <div class="sp-group">
      <div class="sp-group-title">
        <div class="sp-seg">
          {#each [["model", "Model"], ["class", "Class"], ["source", "Tool"], ["placement", "Where"]] as [id, label]}
            <button class:active={tab === id} onclick={() => (tab = id as typeof tab)}>{label}</button>
          {/each}
        </div>
      </div>
      <div class="sp-card">
        {#if slices.length === 0}
          <div class="sp-row"><span class="sp-muted">Nothing in this period yet.</span></div>
        {:else}
          <table>
            <thead><tr><th>{tab === "source" ? "Tool" : tab === "placement" ? "Where" : tab === "class" ? "Class" : "Model"}</th><th class="num">Requests</th><th class="num">Time</th><th class="num">Tokens in / out</th><th class="num">cSats / M tokens</th><th class="num">cSats</th></tr></thead>
            <tbody>
              {#each slices as s (s.key)}
                {@const pm = cSatsPerMillionTokens(s)}
                <tr><td>{sliceLabel(s.key)}</td><td class="num">{s.requests}</td><td class="num">{dur(s.seconds)}</td><td class="num">{tokens(s.promptTokens)} / {tokens(s.outputTokens)}</td><td class="num">{pm === null ? "–" : fmt(pm, 0)}</td><td class="num">{fmt(s.cSats, 3)}</td></tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    </div>

    <div class="sp-group">
      <div class="sp-group-title">Requests</div>
      <div class="sp-card log">
        {#if data.records.length === 0}
          <div class="sp-row"><span class="sp-muted">No requests in this period.</span></div>
        {:else}
          <table>
            <thead><tr><th>When</th><th>Model</th><th>Where</th><th>Tool</th><th class="num">Time</th><th class="num">Tokens</th><th class="num">cSats</th></tr></thead>
            <tbody>
              {#each data.records.slice(0, 200) as r (r.id)}
                <tr class:failed={!r.ok}>
                  <td class="sp-muted">{new Date(r.atMs).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                  <td>{r.kind === "reservation" ? `Reservation${r.model ? ` · ${shortModel(r.model)}` : ""}` : r.model ? shortModel(r.model) : "Code job"}</td>
                  <td>{placementLabel[r.placement] ?? r.placement}{r.computeClass ? ` · ${CLASS_LABELS[r.computeClass] ?? r.computeClass}` : ""}</td>
                  <td>{r.source ?? "–"}</td>
                  <td class="num">{dur(r.durationMs / 1000)}</td>
                  <td class="num">{r.promptTokens !== undefined || r.outputTokens !== undefined ? `${tokens(r.promptTokens ?? 0)} / ${tokens(r.outputTokens ?? 0)}` : "–"}</td>
                  <td class="num">{r.ok ? fmt(r.costMsat / 1000, 3) : "failed"}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
  .stat { padding: 14px 16px; display: flex; flex-direction: column; gap: 4px; }
  .chart-card { padding: 14px 16px 8px; margin-top: 10px; }
  .chart { width: 100%; height: 120px; display: block; }
  .chart rect { fill: var(--accent); opacity: 0.85; }
  .chart rect:hover { opacity: 1; }
  .axis { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-secondary); margin-top: 6px; }
  .meter { height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; margin-top: 8px; max-width: 360px; }
  .meter-fill { height: 100%; background: var(--success, #3fb950); }
  .meter-fill.near { background: var(--warning, #d29922); }
  .meter-fill.over { background: var(--danger, #e5484d); }
  .log { max-height: 460px; overflow-y: auto; }
  tr.failed td { color: var(--text-secondary); }
</style>
