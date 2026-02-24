<script lang="ts">
  import {
    getHealth,
    getStatus,
    getDashboardOverview,
    getSystemMetrics,
  } from "../lib/api";
  import { formatUptime } from "../lib/format";
  import StatCard from "../components/StatCard.svelte";
  import ErrorBanner from "../components/ErrorBanner.svelte";
  import Skeleton from "../components/Skeleton.svelte";

  import type {
    HealthRuntime,
    CoordinatorStatus,
    DashboardOverview,
    SystemMetrics,
  } from "../lib/types";

  interface Props {
    /** Optional external refresh trigger (unused for now). */
    refreshKey?: number;
  }
  let { refreshKey = 0 }: Props = $props();

  // ---------------------------------------------------------------------------
  // Core data
  // ---------------------------------------------------------------------------

  let health: HealthRuntime | null = $state(null);
  let status: CoordinatorStatus | null = $state(null);
  let overview: DashboardOverview | null = $state(null);
  let metrics: SystemMetrics | null = $state(null);
  let metricsSupported: boolean = $state(true);

  let loading: boolean = $state(true);
  let error: string = $state("");

  // ---------------------------------------------------------------------------
  // Throughput chart state (Section D)
  // ---------------------------------------------------------------------------

  const MAX_HISTORY = 30;
  let resultsHistory: number[] = $state([]);
  let deltas: number[] = $derived(
    resultsHistory.length < 2
      ? []
      : resultsHistory.slice(1).map((v, i) => Math.max(0, v - resultsHistory[i]))
  );

  let polylinePoints: string = $derived.by(() => {
    if (deltas.length === 0) return "";
    const maxDelta = Math.max(...deltas, 1);
    const stepX = 300 / Math.max(deltas.length - 1, 1);
    return deltas
      .map((d, i) => `${i * stepX},${80 - (d / maxDelta) * 70}`)
      .join(" ");
  });

  // ---------------------------------------------------------------------------
  // Derived convenience values
  // ---------------------------------------------------------------------------

  let nodeOnline: boolean = $derived(health?.ok ?? false);
  let providerName: string = $derived(health?.coordinator.provider ?? "---");
  let agentCount: number = $derived(status?.agents ?? 0);
  let queuedTasks: number = $derived(status?.queued ?? 0);
  let completedResults: number = $derived(status?.results ?? 0);

  let ollamaVersion: string = $derived(
    health?.ollama.reachable ? `v${health!.ollama.version}` : "Unreachable"
  );
  let ollamaReachable: boolean = $derived(health?.ollama.reachable ?? false);
  let activeModel: string = $derived(overview?.activeModel ?? "---");
  let modelCount: number = $derived(health?.ollama.modelCount ?? 0);
  let uptimeFormatted: string = $derived(
    overview ? formatUptime(overview.uptimeSeconds) : "---"
  );
  let memoryMB: string = $derived(
    overview ? `${overview.memoryMB} MB` : "---"
  );

  // System resources derived
  let cpuPercent: number = $derived(metrics?.cpu_usage_percent ?? 0);
  let memUsedGB: string = $derived(
    metrics ? (metrics.memory_used_mb / 1024).toFixed(1) : "0"
  );
  let memTotalGB: string = $derived(
    metrics ? (metrics.memory_total_mb / 1024).toFixed(1) : "0"
  );
  let memPercent: number = $derived(
    metrics && metrics.memory_total_mb > 0
      ? (metrics.memory_used_mb / metrics.memory_total_mb) * 100
      : 0
  );
  let diskUsedGB: string = $derived(
    metrics ? metrics.disk_used_gb.toFixed(1) : "0"
  );
  let diskTotalGB: string = $derived(
    metrics ? metrics.disk_total_gb.toFixed(1) : "0"
  );
  let diskPercent: number = $derived(
    metrics && metrics.disk_total_gb > 0
      ? (metrics.disk_used_gb / metrics.disk_total_gb) * 100
      : 0
  );

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  async function refreshCoreData() {
    try {
      const [h, s, o] = await Promise.all([
        getHealth(),
        getStatus(),
        getDashboardOverview(),
      ]);
      health = h;
      status = s;
      overview = o;
      error = "";
      loading = false;

      // Track results history for throughput chart
      resultsHistory = [...resultsHistory, s.results].slice(-MAX_HISTORY);
    } catch (e) {
      error = e instanceof Error ? e.message : "Connection failed";
      loading = false;
    }
  }

  async function refreshMetrics() {
    const m = await getSystemMetrics();
    if (m === null) {
      metricsSupported = false;
    } else {
      metrics = m;
    }
  }

  // ---------------------------------------------------------------------------
  // Polling effects
  // ---------------------------------------------------------------------------

  // Core data poll: every 5 seconds
  $effect(() => {
    // Re-run when refreshKey changes (allows parent to force refresh)
    void refreshKey;

    refreshCoreData();
    const interval = setInterval(refreshCoreData, 5000);
    return () => clearInterval(interval);
  });

  // System metrics poll: every 3 seconds
  $effect(() => {
    refreshMetrics();
    const interval = setInterval(refreshMetrics, 3000);
    return () => clearInterval(interval);
  });
</script>

<div class="dashboard">
  <h1 class="page-title">Dashboard</h1>

  {#if error}
    <ErrorBanner message={error} onRetry={refreshCoreData} />
  {/if}

  {#if loading}
    <!-- Loading skeleton -->
    <section class="section">
      <h2 class="section-title">Connection & Status</h2>
      <div class="card-row">
        {#each Array(5) as _}
          <div class="card-slot"><Skeleton lines={2} height="1.4rem" /></div>
        {/each}
      </div>
    </section>
    <section class="section">
      <h2 class="section-title">Ollama Details</h2>
      <div class="card-row">
        {#each Array(5) as _}
          <div class="card-slot"><Skeleton lines={2} height="1.4rem" /></div>
        {/each}
      </div>
    </section>
  {:else if !error}
    <!-- ================================================================= -->
    <!-- Section A: Connection & Status                                     -->
    <!-- ================================================================= -->
    <section class="section">
      <h2 class="section-title">Connection & Status</h2>
      <div class="card-row">
        <StatCard
          label="Node Status"
          value={nodeOnline ? "Online" : "Offline"}
          color={nodeOnline ? "#4ade80" : "#f87171"}
        />
        <StatCard label="Provider" value={providerName} />
        <StatCard label="Connected Agents" value={agentCount} />
        <StatCard label="Queued Tasks" value={queuedTasks} />
        <StatCard label="Completed Results" value={completedResults} />
      </div>
    </section>

    <!-- ================================================================= -->
    <!-- Section B: Ollama Details                                          -->
    <!-- ================================================================= -->
    <section class="section">
      <h2 class="section-title">Ollama Details</h2>
      <div class="card-row">
        <StatCard
          label="Ollama Version"
          value={ollamaVersion}
          color={ollamaReachable ? "#4ade80" : "#f87171"}
        />
        <StatCard label="Active Model" value={activeModel} />
        <StatCard label="Models Installed" value={modelCount} />
        <StatCard label="Uptime" value={uptimeFormatted} />
        <StatCard label="Service Memory" value={memoryMB} />
      </div>
    </section>

    <!-- ================================================================= -->
    <!-- Section C: System Resources                                        -->
    <!-- ================================================================= -->
    <section class="section">
      <h2 class="section-title">System Resources</h2>
      {#if metricsSupported}
        <div class="card-row">
          <StatCard
            label="CPU"
            value="{cpuPercent.toFixed(1)}%"
            progress={cpuPercent}
          />
          <StatCard
            label="Memory"
            value="{memUsedGB} / {memTotalGB} GB"
            progress={memPercent}
          />
          <StatCard
            label="Disk"
            value="{diskUsedGB} / {diskTotalGB} GB"
            progress={diskPercent}
          />
        </div>
      {:else}
        <div class="placeholder-card">
          <span class="placeholder-icon">&#x1F4BB;</span>
          <p>System metrics are only available when running inside Tauri.</p>
          <p class="placeholder-hint">Run the desktop app to see CPU, memory, and disk usage.</p>
        </div>
      {/if}
    </section>

    <!-- ================================================================= -->
    <!-- Section D: Throughput Chart                                         -->
    <!-- ================================================================= -->
    <section class="section">
      <h2 class="section-title">Throughput</h2>
      <div class="chart-card">
        {#if deltas.length >= 2}
          <svg class="throughput-chart" viewBox="0 0 300 80" preserveAspectRatio="none">
            <!-- grid lines -->
            <line x1="0" y1="20" x2="300" y2="20" class="grid-line" />
            <line x1="0" y1="40" x2="300" y2="40" class="grid-line" />
            <line x1="0" y1="60" x2="300" y2="60" class="grid-line" />
            <!-- data line -->
            <polyline
              fill="none"
              stroke="var(--accent, #3b82f6)"
              stroke-width="2"
              stroke-linejoin="round"
              stroke-linecap="round"
              points={polylinePoints}
            />
          </svg>
          <div class="chart-legend">
            <span class="legend-label">Results / 5s interval</span>
            <span class="legend-value">{deltas[deltas.length - 1]} latest</span>
          </div>
        {:else}
          <div class="chart-placeholder">
            <p>Collecting data&hellip; ({resultsHistory.length}/{MAX_HISTORY} samples)</p>
          </div>
        {/if}
      </div>
    </section>
  {/if}
</div>

<style>
  .dashboard {
    padding: 1.5rem;
    max-width: 1200px;
    margin: 0 auto;
  }

  .page-title {
    font-size: 1.8rem;
    font-weight: 700;
    margin-bottom: 1.5rem;
    color: var(--text-primary, #e2e8f0);
  }

  .section {
    margin-bottom: 2rem;
  }

  .section-title {
    font-size: 1rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary, #94a3b8);
    margin-bottom: 0.75rem;
  }

  .card-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 1rem;
  }

  .card-slot {
    background: var(--bg-card, #1a1a2e);
    padding: 1.2rem;
    border-radius: 8px;
  }

  /* ---- Section C placeholder ---- */
  .placeholder-card {
    background: var(--bg-card, #1a1a2e);
    padding: 2rem;
    border-radius: 8px;
    text-align: center;
    color: var(--text-secondary, #94a3b8);
  }

  .placeholder-icon {
    font-size: 2rem;
    display: block;
    margin-bottom: 0.5rem;
  }

  .placeholder-hint {
    font-size: 0.8rem;
    opacity: 0.6;
    margin-top: 0.25rem;
  }

  /* ---- Section D chart ---- */
  .chart-card {
    background: var(--bg-card, #1a1a2e);
    padding: 1.2rem;
    border-radius: 8px;
  }

  .throughput-chart {
    width: 100%;
    height: 80px;
    display: block;
  }

  .grid-line {
    stroke: var(--border, #2d2d5f);
    stroke-width: 0.5;
    stroke-dasharray: 4 4;
  }

  .chart-legend {
    display: flex;
    justify-content: space-between;
    margin-top: 0.5rem;
    font-size: 0.8rem;
    color: var(--text-secondary, #94a3b8);
  }

  .legend-value {
    font-weight: 600;
    color: var(--accent, #3b82f6);
  }

  .chart-placeholder {
    text-align: center;
    padding: 1.5rem;
    color: var(--text-secondary, #94a3b8);
    font-size: 0.9rem;
  }
</style>
