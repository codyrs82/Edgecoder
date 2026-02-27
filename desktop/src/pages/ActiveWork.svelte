<script lang="ts">
  import { getStatus, getCapacity, getMeshPeers, backendReady, isRemoteMode } from "../lib/api";
  import type { CoordinatorStatus, MeshPeer } from "../lib/types";
  import type { AgentCapacity, CapacityResponse } from "../lib/api";
  import { timeAgo } from "../lib/format";
  import StatusDot from "../components/StatusDot.svelte";
  import ErrorBanner from "../components/ErrorBanner.svelte";

  let status: CoordinatorStatus | null = $state(null);
  let capacity: CapacityResponse | null = $state(null);
  let peers: MeshPeer[] = $state([]);
  let error = $state("");
  let loading = $state(true);
  let noLocalAgent = $state(false);

  async function fetchAll() {
    await backendReady;
    if (isRemoteMode()) {
      noLocalAgent = true;
      loading = false;
      return;
    }
    noLocalAgent = false;
    error = "";
    try {
      const [s, c, p] = await Promise.all([
        getStatus(),
        getCapacity(),
        getMeshPeers().then((r) => r.peers),
      ]);
      status = s;
      capacity = c;
      peers = p;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  // Poll every 5 seconds
  $effect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 5000);
    return () => clearInterval(interval);
  });

  function agentHealth(agent: AgentCapacity): "online" | "degraded" | "offline" {
    const age = Date.now() - agent.lastSeenMs;
    if (agent.blacklisted) return "offline";
    if (age > 30000) return "degraded";
    return "online";
  }
</script>

<div class="active-work">
  <h1>Active Work</h1>

  {#if noLocalAgent}
    <div class="info-banner">No local agent running. Install and start the EdgeCoder agent to see active work.</div>
  {:else if error}
    <ErrorBanner message={error} onRetry={fetchAll} />
  {/if}

  <!-- Job Queue Summary -->
  <div class="section">
    <h2>Job Queue</h2>
    {#if loading}
      <p class="muted">Loading...</p>
    {:else if status}
      <div class="stat-row">
        <div class="stat">
          <span class="stat-value">{status.queued}</span>
          <span class="stat-label">Queued</span>
        </div>
        <div class="stat">
          <span class="stat-value">{status.agents}</span>
          <span class="stat-label">Active Workers</span>
        </div>
        <div class="stat">
          <span class="stat-value">{status.results}</span>
          <span class="stat-label">Completed</span>
        </div>
      </div>
    {/if}
  </div>

  <!-- Connected Agents -->
  <div class="section">
    <h2>Connected Agents ({capacity?.totals.agentsConnected ?? 0})</h2>
    {#if loading}
      <p class="muted">Loading...</p>
    {:else if capacity && capacity.agents.length > 0}
      <div class="agent-list">
        {#each capacity.agents as agent}
          <div class="agent-row">
            <div class="agent-main">
              <StatusDot status={agentHealth(agent)} />
              <div class="agent-info">
                <span class="agent-id">{agent.agentId.slice(0, 12)}...</span>
                <span class="agent-meta">
                  {agent.os} &middot; v{agent.version} &middot; {agent.mode}
                </span>
              </div>
            </div>
            <div class="agent-details">
              <span class="detail-badge" title="Max concurrent tasks">
                {agent.maxConcurrentTasks} slots
              </span>
              <span class="detail-badge" title="Connected peers">
                {agent.connectedPeers.length} peers
              </span>
              <span class="detail-time">
                {timeAgo(agent.lastSeenMs)}
              </span>
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <p class="muted">No agents connected</p>
    {/if}
  </div>

  <!-- Mesh Peers -->
  <div class="section">
    <h2>Mesh Peers ({peers.length})</h2>
    {#if loading}
      <p class="muted">Loading...</p>
    {:else if peers.length > 0}
      <div class="peer-list">
        {#each peers as peer}
          <div class="peer-row">
            <div class="peer-main">
              <StatusDot status="online" />
              <div class="peer-info">
                <span class="peer-id">{peer.peerId.slice(0, 16)}...</span>
                <span class="peer-meta">{peer.coordinatorUrl}</span>
              </div>
            </div>
            <span class="detail-badge">{peer.networkMode.replace("_", " ")}</span>
          </div>
        {/each}
      </div>
    {:else}
      <p class="muted">No mesh peers discovered</p>
    {/if}
  </div>
</div>

<style>
  .active-work {
    padding: 1.5rem;
    max-width: 860px;
  }
  h1 { margin: 0 0 1.5rem; font-size: 1.4rem; }
  .section {
    background: var(--bg-surface);
    border: 0.5px solid var(--border);
    padding: 1.2rem 1.4rem;
    border-radius: var(--radius-md);
    margin-bottom: 1.2rem;
  }
  .section h2 {
    font-size: 0.92rem;
    margin: 0 0 1rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  .muted {
    color: var(--text-muted);
    font-size: 0.85rem;
    margin: 0;
  }

  /* Stats row */
  .stat-row {
    display: flex;
    gap: 2rem;
  }
  .stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .stat-value {
    font-size: 1.8rem;
    font-weight: 700;
    color: var(--text-primary);
  }
  .stat-label {
    font-size: 0.78rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  /* Agent list */
  .agent-list, .peer-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .agent-row, .peer-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 0;
    border-bottom: 0.5px solid var(--border);
  }
  .agent-row:last-child, .peer-row:last-child {
    border-bottom: none;
  }
  .agent-main, .peer-main {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .agent-info, .peer-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .agent-id, .peer-id {
    font-family: var(--font-mono);
    font-size: 0.82rem;
    color: var(--text-primary);
  }
  .agent-meta, .peer-meta {
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .agent-details {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .detail-badge {
    font-size: 0.72rem;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
    background: rgba(193, 120, 80, 0.1);
    color: var(--accent);
    white-space: nowrap;
  }
  .detail-time {
    font-size: 0.75rem;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .info-banner { display: flex; align-items: center; background: rgba(59,130,246,0.1); color: var(--accent-secondary, #4a90d9); padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.9rem; }
</style>
