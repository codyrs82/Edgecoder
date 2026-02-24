<script lang="ts">
  import { getMeshPeers, getMeshReputation, getIdentity } from "../lib/api";
  import type { MeshPeer, PeerReputation, NodeIdentity } from "../lib/types";
  import ErrorBanner from "../components/ErrorBanner.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Skeleton from "../components/Skeleton.svelte";

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

  /** Peer count shown in the subtitle */
  let peerCount: number = $derived(peers.length);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  async function refresh(): Promise<void> {
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
  </header>

  {#if error}
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
</style>
