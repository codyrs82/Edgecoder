<script lang="ts">
  // Settings > Network: the whole network, worldwide (GET /v1/ide/network/world through this
  // machine's agent). Coordinators are hubs, machines sit around the coordinator they are on at a
  // distance set by the coordinator's measured round trip to them. Other people's machines are
  // masked (an OS family and a short hash); yours are named. "Latency to you" is an estimate:
  // your round trip to the machine's coordinator plus the coordinator's round trip to the machine.
  // Your own machines on the same local network are measured directly by this computer's IDE
  // provider (src/apps/ide/network-world.ts) and sit beside "You" with a "Same network" badge.
  // A failed refresh is quiet (lib/refresh-quiet.ts): the last view stays, retried on a backoff.
  import { backendReady, isRemoteMode, networkWorld, type WorldView } from "../lib/api";
  import ErrorBanner from "../components/ErrorBanner.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import { clampIndex, nextNodeIndex } from "../lib/mesh-layout";
  import {
    continentName,
    displayName,
    filterRows,
    formatMs,
    hostOf,
    nearestText,
    nearestToYou,
    nearness,
    regionText,
    rowsFor,
    sortRows,
    worldLayout,
    RING_MAX,
    type SortKey,
    type WorldRow,
  } from "../lib/world-view";
  import { initialRefreshState, refreshFailed, refreshSucceeded, retryDelayMs, showBanner, staleNote } from "../lib/refresh-quiet";

  interface Props {
    /** Polling interval in ms (default 15 000). */
    pollInterval?: number;
  }
  let { pollInterval = 15_000 }: Props = $props();

  let view = $state<WorldView | null>(null);
  let offline = $state<string | null>(null);
  let loading = $state(true);
  let noLocalAgent = $state(false);
  let refreshState = $state(initialRefreshState());
  let now = $state(Date.now());
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let error = $derived(showBanner(refreshState, now) ? (view ? "Couldn't refresh the network view. Showing the last one." : "Couldn't load the network. Is your agent running?") : "");
  let quietNote = $derived(view ? staleNote(refreshState, now) : null);

  let mode: "graph" | "cards" = $state("graph");
  let scope: "all" | "mine" = $state("all");
  let model = $state("");
  let sortKey: SortKey = $state("latency");
  let sortDir: "asc" | "desc" = $state("asc");

  let rows = $derived(view ? rowsFor(view) : []);
  let visible = $derived(sortRows(filterRows(rows, { scope, model }), sortKey, sortDir));
  let layout = $derived(view ? worldLayout(view, visible) : null);
  let nearest = $derived(nearestToYou(rows, view?.selfAgentId));
  let coordById = $derived(new Map((view?.coordinators ?? []).map((c) => [c.id, c])));
  let hubById = $derived(new Map((layout?.hubs ?? []).map((h) => [h.id, h])));
  let modelOptions = $derived((view?.models ?? []).filter((m) => m.online > 0 || m.model === model));
  let showLabels = $derived(visible.length <= 24);

  // Graph selection: hover shows a machine, click (or Enter) pins it.
  let selectedId: string | null = $state(null);
  let hoverId: string | null = $state(null);
  let focusIndex = $state(0);
  let safeFocus = $derived(clampIndex(focusIndex, layout?.agents.length ?? 0));
  let graphEl: SVGSVGElement | undefined = $state(undefined);
  let detail: WorldRow | null = $derived(rows.find((r) => r.agent.id === (hoverId ?? selectedId)) ?? null);
  $effect(() => {
    if (selectedId !== null && !visible.some((r) => r.agent.id === selectedId)) selectedId = null;
  });

  async function refresh(): Promise<void> {
    await backendReady;
    if (isRemoteMode()) {
      noLocalAgent = true;
      loading = false;
      return;
    }
    noLocalAgent = false;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    try {
      const r = await networkWorld();
      if (r.connected) {
        view = r as WorldView;
        offline = null;
      } else {
        offline = r.reason ?? "not_connected";
      }
      refreshState = refreshSucceeded(refreshState, Date.now());
    } catch (e) {
      const status = (e as { status?: number }).status;
      // A rate limit only delays the next refresh; the last view stays up.
      if (status !== 429) {
        refreshState = refreshFailed(refreshState, Date.now(), status);
        // Retry soon (2 s, 5 s, then 15 s) rather than waiting out the poll interval.
        if (!refreshState.authError) retryTimer = setTimeout(refresh, retryDelayMs(refreshState.failures));
      }
    } finally {
      now = Date.now();
      loading = false;
    }
  }

  $effect(() => {
    void refresh();
    const t = setInterval(refresh, pollInterval);
    // Keeps "Updated 40 s ago" and the banner's 60 s rule current between refreshes.
    const tick = setInterval(() => (now = Date.now()), 5_000);
    return () => {
      clearInterval(t);
      clearInterval(tick);
      if (retryTimer) clearTimeout(retryTimer);
    };
  });

  function setSort(key: SortKey): void {
    if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
    else {
      sortKey = key;
      sortDir = "asc";
    }
  }

  function statusText(s: string): string {
    return s === "busy" ? "Busy" : s === "idle" ? "Idle" : "Not seen lately";
  }

  function nodeLabel(r: WorldRow): string {
    const a = r.agent;
    const who = a.mine ? `Your machine ${displayName(a, view?.selfAgentId)}` : `Machine ${a.label}`;
    const lat = r.estimateMs === null ? "latency unknown" : r.sameNetwork ? `on your network, ${formatMs(r.estimateMs)} from you` : `about ${r.estimateMs} ms from you`;
    return `${who}, ${statusText(a.status).toLowerCase()}, ${regionText(a)}, ${a.models.length} model${a.models.length === 1 ? "" : "s"}, ${lat}`;
  }

  function onNodeKey(e: KeyboardEvent, i: number, id: string): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectedId = selectedId === id ? null : id;
      return;
    }
    if (e.key === "Escape") {
      selectedId = null;
      return;
    }
    const next = nextNodeIndex(e.key, i, layout?.agents.length ?? 0);
    if (next === null) return;
    e.preventDefault();
    focusIndex = next;
    graphEl?.querySelectorAll<SVGGElement>("[data-node]")[next]?.focus();
  }

  function coordName(id: string): string {
    const c = coordById.get(id);
    return c ? `${hostOf(c.url)}${c.region ? ` (${c.region})` : ""}` : "unknown coordinator";
  }

  const SORTS: Array<[SortKey, string]> = [["latency", "Nearest"], ["region", "Region"], ["model", "Model"], ["status", "Status"]];
</script>

<div class="sp world">
  <h1>Network</h1>
  <p class="sp-lead">Every EdgeCoder machine online, worldwide, and the coordinators that connect them. Other people's machines are masked; yours are named.</p>

  {#if noLocalAgent}
    <div class="sp-card"><div class="sp-row"><span class="sp-muted">No local agent is running. Start the EdgeCoder agent on this computer to see the network.</span></div></div>
  {:else if error}
    <ErrorBanner message={error} onRetry={refresh} />
  {:else if quietNote}
    <p class="sp-muted quiet-note" role="status">{quietNote}</p>
  {/if}

  {#if loading && !view}
    <div class="stats" aria-busy="true">
      {#each Array(4) as _}<div class="sp-card stat"><Skeleton lines={2} height="1rem" /></div>{/each}
    </div>
  {:else if offline && !view}
    <div class="sp-card notice">
      <h2>This computer isn't on the network yet</h2>
      <p class="sp-muted">
        {#if offline === "not_enrolled"}
          Turn on network compute in Settings › Compute. Once this computer is enrolled, every coordinator and every machine on the network shows here, with how far each one is from you.
        {:else if offline === "rate_limited"}
          The coordinator asked us to slow down; the view will refresh in a moment.
        {:else}
          Your agent couldn't reach its coordinator. The view will refresh when it does.
        {/if}
      </p>
    </div>
  {:else if view}
    <section class="stats" aria-label="Network summary">
      <div class="sp-card stat">
        <span class="sp-desc">Machines online</span>
        <span class="sp-big">{view.totals.online}</span>
        <span class="sp-desc">{view.totals.busy} busy · {view.totals.slotsUsed} of {view.totals.slots} slots in use</span>
      </div>
      <div class="sp-card stat">
        <span class="sp-desc">Coordinators</span>
        <span class="sp-big">{view.totals.coordinators}</span>
        <span class="sp-desc">{view.coordinators.map((c) => c.region ?? hostOf(c.url)).join(" · ")}</span>
      </div>
      <div class="sp-card stat">
        <span class="sp-desc">Models available</span>
        <span class="sp-big">{view.totals.models}</span>
        <span class="sp-desc">{view.models.slice(0, 2).map((m) => m.model).join(", ") || "None online"}</span>
      </div>
      <div class="sp-card stat">
        <span class="sp-desc">Nearest to you</span>
        {#if nearest.length}
          <span class="sp-big">{formatMs(nearest[0].estimateMs, !nearest[0].sameNetwork)}</span>
          <span class="sp-desc" title={nearest.map((r) => nearestText(r, view?.selfAgentId)).join(" · ")}>{nearest.map((r) => nearestText(r, view?.selfAgentId)).join(" · ")}</span>
        {:else}
          <span class="sp-big">—</span>
          <span class="sp-desc">No latency measured yet</span>
        {/if}
      </div>
    </section>

    <section class="sp-group" aria-label="Machines">
      <div class="toolbar">
        <div class="sp-seg" role="group" aria-label="View">
          <button type="button" class:active={mode === "graph"} aria-pressed={mode === "graph"} onclick={() => (mode = "graph")}>Graph</button>
          <button type="button" class:active={mode === "cards"} aria-pressed={mode === "cards"} onclick={() => (mode = "cards")}>Cards</button>
        </div>
        <div class="sp-seg" role="group" aria-label="Whose machines">
          <button type="button" class:active={scope === "all"} aria-pressed={scope === "all"} onclick={() => (scope = "all")}>Everyone</button>
          <button type="button" class:active={scope === "mine"} aria-pressed={scope === "mine"} onclick={() => (scope = "mine")}>My machines ({view.totals.mine})</button>
        </div>
        <label class="model-filter">
          <span>Model</span>
          <select bind:value={model}>
            <option value="">Any model</option>
            {#each modelOptions as m (m.model)}<option value={m.model}>{m.model} ({m.online})</option>{/each}
          </select>
        </label>
        {#if mode === "cards"}
          <div class="sp-seg sorts" role="group" aria-label="Sort machines">
            {#each SORTS as [key, label] (key)}
              <button type="button" class:active={sortKey === key} aria-pressed={sortKey === key} onclick={() => setSort(key)}>
                {label}{#if sortKey === key}<span aria-hidden="true"> {sortDir === "asc" ? "↑" : "↓"}</span><span class="vh">, {sortDir === "asc" ? "ascending" : "descending"}</span>{/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      {#if mode === "graph" && layout}
        <div class="graph-wrap">
          <div class="sp-card graph-card">
            <svg
              bind:this={graphEl}
              class="graph"
              viewBox="0 0 {layout.width} {layout.height}"
              role="group"
              aria-label="Network graph: {layout.hubs.length} coordinators and {layout.agents.length} machines. Arrow keys move between machines, Enter pins a machine's details."
            >
              {#each layout.rings as ring (ring.hubId + ring.ms)}
                {@const hub = hubById.get(ring.hubId)}
                {#if hub}
                  <circle class="ring" cx={hub.x} cy={hub.y} r={ring.r} aria-hidden="true" />
                  <text class="ring-label" x={hub.x + 4} y={hub.y - ring.r - 3} aria-hidden="true">{ring.ms} ms</text>
                {/if}
              {/each}
              {#each view.links as link (link.from + link.to)}
                {@const a = hubById.get(link.from)}
                {@const b = hubById.get(link.to)}
                {#if a && b}
                  <line class="clink" x1={a.x} y1={a.y} x2={b.x} y2={b.y} aria-hidden="true" />
                  <text class="clink-label" x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 8} text-anchor="middle" aria-hidden="true">{formatMs(link.rttMs)}</text>
                {/if}
              {/each}
              {#if layout.you}
                {#each layout.agents.filter((n) => n.lan) as node (node.id)}
                  <line class="lan-link" x1={layout.you.x} y1={layout.you.y} x2={node.x} y2={node.y} aria-hidden="true" />
                  <text class="lan-link-label" x={(layout.you.x + node.x) / 2} y={layout.you.y - 8} text-anchor="middle" aria-hidden="true">{formatMs(node.row.estimateMs)}</text>
                {/each}
                {#each layout.hubs as hub (hub.id)}
                  {#if typeof hub.coordinator.myRttMs === "number"}
                    <line class="you-link" x1={layout.you.x} y1={layout.you.y} x2={hub.x} y2={hub.y} aria-hidden="true" />
                    <text class="you-link-label" x={(layout.you.x + hub.x) / 2 + 6} y={(layout.you.y + hub.y) / 2 + 40} aria-hidden="true">{formatMs(hub.coordinator.myRttMs)}</text>
                  {/if}
                {/each}
              {/if}
              {#each layout.agents as node (node.id)}
                {@const hub = hubById.get(node.hubId)}
                {#if hub}<line class="spoke" class:spoke-on={detail?.agent.id === node.id} x1={hub.x} y1={hub.y} x2={node.x} y2={node.y} aria-hidden="true" />{/if}
              {/each}
              {#each layout.hubs as hub (hub.id)}
                <g class="hub" class:hub-down={!hub.coordinator.reachable} transform="translate({hub.x} {hub.y})">
                  <title>{hostOf(hub.coordinator.url)} · {hub.coordinator.agentsOnline} machines online{hub.coordinator.reachable ? "" : " · not reachable"}</title>
                  <circle r="26" />
                  <text class="hub-region" y="4" text-anchor="middle">{(hub.coordinator.region ?? "?").toUpperCase()}</text>
                  <text class="hub-host" y={RING_MAX + 22} text-anchor="middle">{hostOf(hub.coordinator.url)}</text>
                </g>
              {/each}
              {#each layout.agents as node, i (node.id)}
                {@const a = node.row.agent}
                <g
                  data-node
                  class="node st-{a.status}"
                  class:mine={a.mine}
                  class:lan={node.lan}
                  class:selected={selectedId === a.id}
                  transform="translate({node.x} {node.y})"
                  role="button"
                  tabindex={i === safeFocus ? 0 : -1}
                  aria-pressed={selectedId === a.id}
                  aria-label={nodeLabel(node.row)}
                  onclick={() => { focusIndex = i; selectedId = selectedId === a.id ? null : a.id; }}
                  onkeydown={(e) => onNodeKey(e, i, a.id)}
                  onmouseenter={() => (hoverId = a.id)}
                  onmouseleave={() => (hoverId = null)}
                  onfocus={() => (focusIndex = i)}
                >
                  <circle r={node.r} />
                  {#if a.mine}<circle class="mine-ring" r={node.r + 4} />{/if}
                  {#if a.mine || showLabels}
                    <text y={node.r + 13} text-anchor="middle" aria-hidden="true">{a.mine ? displayName(a) : a.label}</text>
                  {/if}
                </g>
              {/each}
              {#if layout.you}
                <g class="you" transform="translate({layout.you.x} {layout.you.y})" aria-hidden="true">
                  <circle r="10" />
                  <text y="26" text-anchor="middle">You</text>
                </g>
              {/if}
            </svg>
            <div class="legend" aria-hidden="true">
              <span><i class="dot idle"></i>Idle</span>
              <span><i class="dot busy"></i>Busy</span>
              <span><i class="dot stale"></i>Not seen lately</span>
              <span><i class="dot mine"></i>Yours</span>
              {#if layout.agents.some((n) => n.lan)}<span>Beside You: your machines on the same network, measured directly.</span>{/if}
              <span>Distance from a coordinator: its round trip to the machine. Size: model slots.</span>
            </div>
          </div>
          <aside class="sp-card details" aria-label="Machine details">
            {#if detail}
              {@const a = detail.agent}
              <h2>{displayName(a, view.selfAgentId)}</h2>
              <span class="badges">
                <span class="sp-pill st-{a.status}">{statusText(a.status)}</span>
                {#if a.mine}<span class="sp-pill yours">Yours</span>{/if}
                {#if detail.sameNetwork}<span class="sp-pill lan">Same network</span>{/if}
              </span>
              <dl>
                {#if detail.sameNetwork}
                  <dt>Latency to you</dt><dd>{formatMs(detail.estimateMs)} <span class="est">measured directly on your local network</span></dd>
                {:else}
                  <dt>Latency to you</dt><dd>{formatMs(detail.estimateMs, true)} <span class="est">estimate</span></dd>
                {/if}
                <dt>Region</dt><dd>{regionText(a)}{a.continent ? ` · ${continentName(a.continent)}` : ""}</dd>
                <dt>Class</dt><dd>{a.computeClass}{a.tier ? ` · ${a.tier}` : ""}{a.vramGb ? ` · ${a.vramGb} GB` : ""}</dd>
                <dt>Load</dt><dd>{a.slotsUsed} of {a.slots} slot{a.slots === 1 ? "" : "s"} in use</dd>
                <dt>Coordinator</dt><dd>{coordName(a.coordinatorId)} · {formatMs(a.rttMs)}</dd>
                <dt>Models</dt>
                <dd class="models">
                  {#each a.models as m (m)}<span class="chip" class:active={m === a.activeModel}>{m}</span>{:else}<span class="sp-muted">None reported</span>{/each}
                  {#if a.modelsTotal > a.models.length}<span class="sp-muted">+{a.modelsTotal - a.models.length} more</span>{/if}
                </dd>
              </dl>
            {:else}
              <h2>Select a machine</h2>
              <p class="sp-muted">Hover or select a machine to see its models, class, region, load and how far it is from you.</p>
            {/if}
          </aside>
        </div>
      {:else if mode === "cards"}
        {#if visible.length === 0}
          <div class="sp-card"><div class="sp-row"><span class="sp-muted">{scope === "mine" ? "None of your machines match." : "No machines match these filters."}</span></div></div>
        {:else}
          <ul class="cards" aria-label="Machines, sorted by {SORTS.find(([k]) => k === sortKey)?.[1].toLowerCase()}">
            {#each visible as r (r.agent.id)}
              {@const a = r.agent}
              <li class="sp-card wcard" class:mine={a.mine}>
                <div class="whead">
                  <span class="dot {a.status}" aria-hidden="true"></span>
                  <span class="wname" class:masked={!a.mine}>{displayName(a, view.selfAgentId)}</span>
                  {#if a.mine}<span class="sp-pill yours">Yours</span>{/if}
                  {#if r.sameNetwork}<span class="sp-pill lan">Same network</span>{/if}
                  {#if r.sameNetwork}
                    <span class="lat near-near" title="Measured directly from this computer over your local network">{formatMs(r.estimateMs)}</span>
                  {:else}
                    <span class="lat near-{nearness(r.estimateMs)}" title="Estimated: your round trip to its coordinator plus the coordinator's to the machine">{formatMs(r.estimateMs, true)}</span>
                  {/if}
                </div>
                <div class="wmeta">
                  <span>{statusText(a.status)} · {a.slotsUsed}/{a.slots} slots</span>
                  <span>{regionText(a)}</span>
                  <span>{a.computeClass}{a.tier ? ` · ${a.tier}` : ""}</span>
                  <span>via {coordById.get(a.coordinatorId)?.region ?? hostOf(coordById.get(a.coordinatorId)?.url ?? "")}</span>
                </div>
                <div class="models">
                  {#each a.models.slice(0, 4) as m (m)}<span class="chip" class:active={m === a.activeModel}>{m}</span>{/each}
                  {#if a.modelsTotal > 4}<span class="sp-muted">+{a.modelsTotal - 4}</span>{/if}
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
      {#if view.truncated}<p class="sp-muted">Showing the first {view.agents.length} of {view.totals.agents} machines.</p>{/if}
    </section>

    <section class="sp-group" aria-labelledby="coord-title">
      <h2 class="sp-group-title" id="coord-title">Coordinators</h2>
      <div class="sp-card">
        {#each view.coordinators as c (c.id)}
          <div class="sp-row">
            <span class="sp-dot" class:on={c.reachable} class:err={!c.reachable} aria-hidden="true"></span>
            <div class="sp-text">
              <span class="sp-title">{hostOf(c.url)}{c.self ? " · answering" : ""}</span>
              <span class="sp-desc">{c.region ?? "region unknown"}{c.continent ? ` · ${continentName(c.continent)}` : ""} · {c.reachable ? `${c.agentsOnline} machine${c.agentsOnline === 1 ? "" : "s"} online` : "not reachable right now"}</span>
            </div>
            <span class="sp-desc">Your round trip {formatMs(c.myRttMs)}</span>
          </div>
        {/each}
        {#each view.links as l (l.from + l.to)}
          <div class="sp-row">
            <div class="sp-text">
              <span class="sp-desc">{coordName(l.from)} ↔ {coordName(l.to)} · meshed{l.rttMs !== null ? `, ${l.rttMs} ms apart` : ""}</span>
            </div>
          </div>
        {/each}
      </div>
      <p class="sp-muted footnote">Latency to a machine is an estimate: your round trip to its coordinator (measured from this computer) plus the coordinator's round trip to the machine (measured on its connection). Your own machines on the same local network are pinged directly from this computer and marked "Same network"; other people's machines are never probed. Regions come from where a machine is hosted or was enrolled; no location lookups are made.</p>
    </section>
  {/if}
</div>

<style>
  .sp.world { max-width: 1040px; }
  .vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
  .stat { padding: 14px 16px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .stat .sp-desc { font-size: var(--fs-xs); color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .notice { padding: 20px; }
  .notice h2 { margin: 0 0 6px; font-size: var(--fs-base); font-weight: 600; }
  .notice p { margin: 0; line-height: var(--lh-ui); }

  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .toolbar .sorts { margin-left: auto; }
  .model-filter { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-sm); color: var(--text-secondary); }
  .model-filter select {
    height: var(--control-md); padding: 0 8px; max-width: 240px; background: var(--bg-input); color: var(--text-primary);
    border: 0.5px solid var(--border-control); border-radius: var(--radius-sm); font: inherit; font-size: var(--fs-sm);
  }

  .graph-wrap { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 10px; align-items: start; }
  @media (max-width: 860px) { .graph-wrap { grid-template-columns: 1fr; } }
  .graph-card { padding: 8px; }
  .graph { display: block; width: 100%; height: auto; max-height: 70vh; }
  .ring { fill: none; stroke: var(--border); stroke-dasharray: 2 4; }
  .ring-label { fill: var(--text-muted); font-size: 10px; }
  .clink { stroke: var(--accent-secondary); stroke-width: 2.5; opacity: 0.7; }
  .clink-label, .you-link-label { fill: var(--text-secondary); font-size: 11px; }
  .lan-link { stroke: var(--green); stroke-width: 1.5; stroke-dasharray: 3 3; }
  .lan-link-label { fill: var(--green); font-size: 10.5px; font-weight: 600; }
  .sp-pill.lan { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, transparent); }
  .quiet-note { margin: 0; font-size: var(--fs-xs); }
  .you-link { stroke: var(--text-muted); stroke-width: 1.2; stroke-dasharray: 5 5; }
  .spoke { stroke: var(--border-strong); stroke-width: 1; }
  .spoke-on { stroke: var(--accent); stroke-width: 2; }
  .hub circle { fill: var(--accent-secondary); stroke: var(--bg-surface); stroke-width: 3; }
  .hub-down circle { fill: var(--text-muted); }
  .hub-region { fill: var(--on-accent); font-size: 12px; font-weight: 700; letter-spacing: 0.04em; }
  .hub-host { fill: var(--text-primary); font-size: 11px; font-weight: 500; }
  .node { cursor: pointer; outline: none; }
  .node circle { stroke: var(--bg-surface); stroke-width: 1.5; }
  .node.st-idle circle { fill: var(--green); }
  .node.st-busy circle { fill: var(--yellow); }
  .node.st-stale circle { fill: var(--text-muted); }
  .node .mine-ring { fill: none; stroke: var(--text-primary); stroke-width: 2; }
  .node text { fill: var(--text-secondary); font-size: 10.5px; pointer-events: none; }
  .node.mine text { fill: var(--text-primary); font-weight: 600; }
  .node.selected circle:first-child, .node:focus-visible circle:first-child { stroke: var(--text-primary); stroke-width: 3; }
  .you circle { fill: var(--text-primary); stroke: var(--bg-surface); stroke-width: 3; }
  .you text { fill: var(--text-primary); font-size: 11px; font-weight: 600; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 6px 8px 2px; font-size: var(--fs-2xs); color: var(--text-secondary); }
  .legend span { display: inline-flex; align-items: center; gap: 5px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--text-muted); }
  .dot.idle { background: var(--green); }
  .dot.busy { background: var(--yellow); }
  .dot.mine { background: none; box-shadow: inset 0 0 0 2px var(--text-primary); }

  .details { padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
  .details h2 { margin: 0; font-size: var(--fs-base); font-weight: 600; font-family: var(--font-mono); word-break: break-all; }
  .details p { margin: 0; line-height: var(--lh-ui); }
  .badges { display: flex; gap: 6px; }
  .details dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; font-size: var(--fs-xs); }
  .details dt { color: var(--text-secondary); }
  .details dd { margin: 0; color: var(--text-primary); min-width: 0; }
  .est { color: var(--text-secondary); }
  .sp-pill.st-idle { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
  .sp-pill.st-busy { color: var(--text-primary); border-color: color-mix(in srgb, var(--yellow) 60%, transparent); }
  .sp-pill.yours { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
  .models { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  .chip { padding: 1px 7px; border-radius: 999px; font-size: var(--fs-2xs); font-family: var(--font-mono); background: var(--bg-base); border: 0.5px solid var(--border); color: var(--text-secondary); }
  .chip.active { color: var(--text-primary); border-color: var(--border-strong); }

  .cards { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
  .wcard { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
  .wcard.mine { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
  .whead { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .wname { font-size: var(--fs-sm); font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wname.masked { font-family: var(--font-mono); font-weight: 500; }
  .lat { margin-left: auto; font-size: var(--fs-xs); font-variant-numeric: tabular-nums; color: var(--text-secondary); white-space: nowrap; }
  .lat.near-near { color: var(--green); }
  .wmeta { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: var(--fs-xs); color: var(--text-secondary); }
  .footnote { margin: 4px 4px 0; line-height: var(--lh-ui); }
  .sp-group-title { margin: 0; }
</style>
