<script lang="ts">
  import { getMeshPeers, getMeshReputation, getIdentity, backendReady, isRemoteMode } from "../lib/api";
  import type { MeshPeer, PeerReputation, NodeIdentity } from "../lib/types";
  import ErrorBanner from "../components/ErrorBanner.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import { fitViewBox, nextNodeIndex, radialLayout } from "../lib/mesh-layout";

  interface Props {
    /** Override polling interval in ms (default 10 000) */
    pollInterval?: number;
  }

  let { pollInterval = 10_000 }: Props = $props();

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let peers: MeshPeer[] = $state([]);
  let reputations: PeerReputation[] = $state([]);
  let identity: NodeIdentity | null = $state(null);
  let loading: boolean = $state(true);
  let error: string = $state("");

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  /** Map peerId -> reputation score for O(1) lookups */
  let reputationMap: Map<string, number> = $derived(
    new Map(reputations.map((r) => [r.peerId, r.score])),
  );

  /** The local node's peerId (empty string when identity is unknown) */
  let selfPeerId: string = $derived(identity?.peerId ?? "");

  // #28: interactive graph view (default) alongside the card grid.
  let view: "graph" | "cards" = $state("graph");
  let layout = $derived(radialLayout(peers.map((p) => p.peerId), selfPeerId));
  let viewBox = $derived(fitViewBox(layout.nodes));
  let selectedId: string = $state("");
  let focusIndex = $state(0);
  let selectedPeer = $derived(peers.find((p) => p.peerId === selectedId) ?? null);
  let nodeById = $derived(new Map(layout.nodes.map((n) => [n.id, n])));
  let graphEl: SVGSVGElement | undefined = $state(undefined);

  function nodeLabel(id: string, self: boolean): string {
    const score = reputationMap.get(id);
    return `${self ? "This node" : "Peer"} ${truncate(id, 12)}${score !== undefined ? `, reputation ${score}` : ""}`;
  }

  function onNodeKey(e: KeyboardEvent, i: number, id: string) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectedId = selectedId === id ? "" : id;
      return;
    }
    if (e.key === "Escape") { selectedId = ""; return; }
    const next = nextNodeIndex(e.key, i, layout.nodes.length);
    if (next === null) return;
    e.preventDefault();
    focusIndex = next;
    graphEl?.querySelectorAll<SVGGElement>("[data-node]")[next]?.focus();
  }

  /** Peer count shown in the subtitle */
  let peerCount: number = $derived(peers.length);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  let noLocalAgent = $state(false);

  async function refresh(): Promise<void> {
    await backendReady;
    if (isRemoteMode()) {
      noLocalAgent = true;
      loading = false;
      return;
    }
    noLocalAgent = false;
    try {
      const [peersRes, repRes, idRes] = await Promise.all([
        getMeshPeers(),
        getMeshReputation(),
        getIdentity(),
      ]);

      peers = peersRes.peers ?? [];
      reputations = repRes.peers ?? [];
      identity = idRes;
      error = "";
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load mesh topology";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    refresh();
    const interval = setInterval(refresh, pollInterval);
    return () => clearInterval(interval);
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function truncate(value: string, length: number): string {
    if (value.length <= length) return value;
    return value.slice(0, length) + "\u2026";
  }

  function reputationColor(score: number): string {
    if (score >= 80) return "rep-green";
    if (score >= 50) return "rep-yellow";
    return "rep-red";
  }

  function networkModeLabel(mode: MeshPeer["networkMode"]): string {
    return mode === "enterprise_overlay" ? "Enterprise" : "Public Mesh";
  }
</script>

<div class="mesh-topology">
  <header class="page-header">
    <h1>Mesh Topology</h1>
    <p class="subtitle">{peerCount} {peerCount === 1 ? "peer" : "peers"} discovered</p>
    <div class="view-toggle" role="group" aria-label="View">
      <button type="button" aria-pressed={view === "graph"} onclick={() => (view = "graph")}>Graph</button>
      <button type="button" aria-pressed={view === "cards"} onclick={() => (view = "cards")}>Cards</button>
    </div>
  </header>

  {#if noLocalAgent}
    <div class="info-banner">No local agent running. Install and start the EdgeCoder agent to see mesh topology.</div>
  {:else if error}
    <ErrorBanner message={error} onRetry={refresh} />
  {/if}

  {#if loading && !error}
    <!-- Skeleton placeholder while first load is in progress -->
    <div class="peer-grid">
      {#each Array(6) as _}
        <div class="peer-card skeleton-card">
          <Skeleton lines={4} height="1rem" />
        </div>
      {/each}
    </div>
  {:else if !error && peerCount === 0}
    <EmptyState
      title="No Peers Discovered"
      description="Peers appear when other coordinators join the mesh network. Connect to a seed node to discover peers."
    />
  {:else if !error && view === "graph"}
    <div class="graph-wrap">
      <svg bind:this={graphEl} class="mesh-graph" {viewBox} role="group" aria-label="Mesh graph: this node and {peerCount} peers. Use arrow keys to move, Enter to show details.">
        {#each layout.edges as edge (edge.to)}
          {@const a = nodeById.get(edge.from)}
          {@const b = nodeById.get(edge.to)}
          {#if a && b}
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} class="edge" class:edge-active={selectedId === edge.to} aria-hidden="true" />
          {/if}
        {/each}
        {#each layout.nodes as node, i (node.id)}
          {@const score = reputationMap.get(node.id)}
          <g
            data-node
            class="node {node.self ? 'node-self' : score === undefined ? 'rep-unknown' : reputationColor(score)}"
            class:node-selected={selectedId === node.id}
            transform="translate({node.x} {node.y})"
            role="button"
            tabindex={i === focusIndex ? 0 : -1}
            aria-pressed={selectedId === node.id}
            aria-label={nodeLabel(node.id, node.self)}
            onclick={() => { focusIndex = i; selectedId = selectedId === node.id ? "" : node.id; }}
            onkeydown={(e) => onNodeKey(e, i, node.id)}
          >
            <circle r={node.self ? 22 : 16} />
            <text y={node.self ? 38 : 30} text-anchor="middle" aria-hidden="true">{node.self ? "This node" : truncate(node.id, 8)}</text>
          </g>
        {/each}
      </svg>
      <aside class="graph-details" aria-live="polite">
        {#if selectedPeer}
          {@const score = reputationMap.get(selectedPeer.peerId)}
          <h2 class="peer-id" title={selectedPeer.peerId}>{truncate(selectedPeer.peerId, 20)}</h2>
          <span class="mode-badge" class:mode-enterprise={selectedPeer.networkMode === "enterprise_overlay"} class:mode-public={selectedPeer.networkMode === "public_mesh"}>{networkModeLabel(selectedPeer.networkMode)}</span>
          <div class="detail-row"><span class="detail-label">Coordinator</span><span class="detail-value" title={selectedPeer.coordinatorUrl}>{selectedPeer.coordinatorUrl}</span></div>
          <div class="detail-row"><span class="detail-label">Reputation</span><span class="detail-value">{score ?? "no score"}</span></div>
        {:else}
          <p class="muted-hint">Select a node to see its details.</p>
        {/if}
      </aside>
    </div>
  {:else if !error}
    <div class="peer-grid">
      {#each peers as peer (peer.peerId)}
        {@const isSelf = peer.peerId === selfPeerId}
        {@const score = reputationMap.get(peer.peerId)}
        <div class="peer-card" class:self-node={isSelf}>
          <!-- Header row: truncated peerId + self badge -->
          <div class="card-header">
            <span class="peer-id" title={peer.peerId}>
              {truncate(peer.peerId, 12)}
            </span>
            {#if isSelf}
              <span class="self-badge">This Node</span>
            {/if}
          </div>

          <!-- Network mode badge -->
          <div class="network-mode">
            <span
              class="mode-badge"
              class:mode-enterprise={peer.networkMode === "enterprise_overlay"}
              class:mode-public={peer.networkMode === "public_mesh"}
            >
              {networkModeLabel(peer.networkMode)}
            </span>
          </div>

          <!-- Details -->
          <div class="card-details">
            <div class="detail-row">
              <span class="detail-label">Coordinator</span>
              <span class="detail-value" title={peer.coordinatorUrl}>
                {peer.coordinatorUrl}
              </span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Public Key</span>
              <span class="detail-value mono" title={peer.publicKeyPem}>
                {truncate(peer.publicKeyPem, 20)}
              </span>
            </div>
          </div>

          <!-- Reputation -->
          <div class="card-footer">
            {#if score !== undefined}
              <span class="rep-badge {reputationColor(score)}">
                {score}
              </span>
              <span class="rep-label">reputation</span>
            {:else}
              <span class="rep-badge rep-unknown">--</span>
              <span class="rep-label">no score</span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* ------------------------------------------------------------------
     Layout
  ------------------------------------------------------------------ */
  .mesh-topology {
    padding: 1.5rem;
  }

  .page-header {
    margin-bottom: 1.25rem;
  }

  .view-toggle { display: inline-flex; margin-top: 0.6rem; border: 1px solid var(--border, #1e1e3f); border-radius: var(--radius-sm, 6px); overflow: hidden; }
  .view-toggle button { background: none; border: none; color: var(--text-secondary, #94a3b8); padding: 0.3rem 0.8rem; cursor: pointer; font-size: 0.8rem; }
  .view-toggle button[aria-pressed="true"] { background: var(--accent, #3b82f6); color: #fff; }
  .view-toggle button:focus-visible { outline: 2px solid var(--accent, #3b82f6); outline-offset: -2px; }

  .graph-wrap { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 1rem; align-items: start; }
  @media (max-width: 760px) { .graph-wrap { grid-template-columns: 1fr; } }
  .mesh-graph { width: 100%; max-height: 70vh; background: var(--bg-surface, #1a1a2e); border-radius: var(--radius-md, 10px); }
  .edge { stroke: var(--border-strong, rgba(255, 255, 255, 0.15)); stroke-width: 1.5; }
  .edge-active { stroke: var(--accent, #3b82f6); stroke-width: 2.5; }
  .node { cursor: pointer; outline: none; }
  .node circle { fill: var(--bg-elevated, #2a2a40); stroke-width: 3; stroke: var(--text-muted, #64748b); }
  .node text { fill: var(--text-secondary, #94a3b8); font-size: 11px; pointer-events: none; }
  .node.rep-green circle { stroke: var(--green, #4ade80); }
  .node.rep-yellow circle { stroke: var(--yellow, #facc15); }
  .node.rep-red circle { stroke: var(--red, #f87171); }
  .node-self circle { fill: var(--accent, #3b82f6); stroke: var(--accent, #3b82f6); }
  .node-selected circle, .node:focus-visible circle { stroke: var(--text-primary, #e2e8f0); stroke-width: 4; }
  .graph-details { background: var(--bg-surface, #1a1a2e); border-radius: var(--radius-md, 10px); padding: 1rem; display: flex; flex-direction: column; gap: 0.6rem; }
  .graph-details h2 { margin: 0; font-size: 1rem; }
  .muted-hint { margin: 0; color: var(--text-secondary, #94a3b8); font-size: 0.85rem; }

  .page-header h1 {
    margin: 0 0 0.25rem;
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--text-primary, #e2e8f0);
  }

  .subtitle {
    margin: 0;
    font-size: 0.9rem;
    opacity: 0.6;
    color: var(--text-secondary, #94a3b8);
  }

  /* ------------------------------------------------------------------
     Peer grid
  ------------------------------------------------------------------ */
  .peer-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1rem;
  }

  /* ------------------------------------------------------------------
     Peer card
  ------------------------------------------------------------------ */
  .peer-card {
    background: var(--bg-surface, #1a1a2e);
    border: 1px solid var(--border-card, rgba(255, 255, 255, 0.06));
    border-radius: 10px;
    padding: 1.15rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
  }

  .peer-card:hover {
    border-color: var(--border-hover, rgba(255, 255, 255, 0.12));
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2);
  }

  /* Self-node highlight */
  .peer-card.self-node {
    border-color: var(--color-self, #3b82f6);
    box-shadow: 0 0 0 1px var(--color-self, #3b82f6),
      0 2px 16px rgba(59, 130, 246, 0.15);
  }

  /* Skeleton placeholder cards */
  .skeleton-card {
    min-height: 160px;
  }

  /* ------------------------------------------------------------------
     Card header
  ------------------------------------------------------------------ */
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .peer-id {
    font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--text-primary, #e2e8f0);
    letter-spacing: 0.02em;
  }

  .self-badge {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-self, #3b82f6);
    background: rgba(59, 130, 246, 0.12);
    border: 1px solid rgba(59, 130, 246, 0.3);
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    white-space: nowrap;
  }

  /* ------------------------------------------------------------------
     Network mode badge
  ------------------------------------------------------------------ */
  .network-mode {
    display: flex;
  }

  .mode-badge {
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.2rem 0.55rem;
    border-radius: 4px;
  }

  .mode-public {
    color: #4ade80;
    background: rgba(74, 222, 128, 0.1);
    border: 1px solid rgba(74, 222, 128, 0.25);
  }

  .mode-enterprise {
    color: #a78bfa;
    background: rgba(167, 139, 250, 0.1);
    border: 1px solid rgba(167, 139, 250, 0.25);
  }

  /* ------------------------------------------------------------------
     Card details
  ------------------------------------------------------------------ */
  .card-details {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .detail-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.75rem;
    font-size: 0.82rem;
  }

  .detail-label {
    color: var(--text-secondary, #94a3b8);
    opacity: 0.7;
    flex-shrink: 0;
  }

  .detail-value {
    color: var(--text-primary, #e2e8f0);
    opacity: 0.85;
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .detail-value.mono {
    font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
    font-size: 0.78rem;
  }

  /* ------------------------------------------------------------------
     Reputation footer
  ------------------------------------------------------------------ */
  .card-footer {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin-top: auto;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border-card, rgba(255, 255, 255, 0.06));
  }

  .rep-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.2rem;
    font-size: 0.82rem;
    font-weight: 700;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    font-variant-numeric: tabular-nums;
  }

  .rep-green {
    color: #4ade80;
    background: rgba(74, 222, 128, 0.12);
  }

  .rep-yellow {
    color: #facc15;
    background: rgba(250, 204, 21, 0.12);
  }

  .rep-red {
    color: #f87171;
    background: rgba(248, 113, 113, 0.12);
  }

  .rep-unknown {
    color: var(--text-secondary, #94a3b8);
    background: rgba(148, 163, 184, 0.1);
    opacity: 0.6;
  }

  .rep-label {
    font-size: 0.75rem;
    color: var(--text-secondary, #94a3b8);
    opacity: 0.6;
  }
  .info-banner { display: flex; align-items: center; background: rgba(59,130,246,0.1); color: var(--accent-secondary, #4a90d9); padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.9rem; }
</style>
