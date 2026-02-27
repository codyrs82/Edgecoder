<script lang="ts">
  import ErrorBanner from "../components/ErrorBanner.svelte";
  import SeedPhraseModal from "../components/SeedPhraseModal.svelte";
  import {
    getWalletOnboarding,
    setupWalletSeed,
    getWalletSendRequests,
    type WalletOnboarding,
    type WalletSeedSetup,
    type WalletSendRequest,
  } from "../lib/api";

  let onboarding = $state<WalletOnboarding | null>(null);
  let sendRequests = $state<WalletSendRequest[]>([]);
  let loading = $state(true);
  let error = $state("");

  // Seed phrase modal state
  let seedSetup = $state<WalletSeedSetup | null>(null);
  let showSeedModal = $state(false);
  let settingUpSeed = $state(false);

  async function loadWallet() {
    error = "";
    try {
      const [ob, reqs] = await Promise.all([
        getWalletOnboarding(),
        getWalletSendRequests(),
      ]);
      onboarding = ob;
      sendRequests = reqs;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  async function handleSetupSeed() {
    settingUpSeed = true;
    error = "";
    try {
      const setup = await setupWalletSeed();
      seedSetup = setup;
      showSeedModal = true;
      await loadWallet();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      settingUpSeed = false;
    }
  }

  function handleSeedDone() {
    showSeedModal = false;
    seedSetup = null;
    loadWallet();
  }

  function timeAgo(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  $effect(() => { loadWallet(); });
</script>

<div class="wallet">
  <h1>Wallet</h1>

  {#if error}
    <ErrorBanner message={error} />
  {/if}

  {#if loading}
    <p class="muted">Loading wallet...</p>
  {:else if !onboarding}
    <div class="setup-section">
      <h2>Set Up Your Wallet</h2>
      <p>Generate a recovery seed phrase to receive credits for contributing compute to the mesh.</p>
      <button class="btn-primary" onclick={handleSetupSeed} disabled={settingUpSeed}>
        {settingUpSeed ? "Generating..." : "Set up recovery seed phrase"}
      </button>
    </div>
  {:else}
    <div class="section">
      <h2>Account</h2>
      <div class="info-grid">
        <span class="info-label">Account ID</span>
        <span class="info-value mono">{onboarding.accountId}</span>
        <span class="info-label">Network</span>
        <span class="info-value">{onboarding.network}</span>
        {#if onboarding.derivedAddress}
          <span class="info-label">Address</span>
          <span class="info-value mono">{onboarding.derivedAddress}</span>
        {/if}
        <span class="info-label">Seed Backup</span>
        <span class="info-value">
          {#if onboarding.acknowledgedAtMs}
            <span class="badge-ok">Confirmed</span>
          {:else}
            <span class="badge-warn">Not confirmed</span>
            <button class="btn-sm" onclick={handleSetupSeed} disabled={settingUpSeed}>
              {settingUpSeed ? "..." : "Generate new seed"}
            </button>
          {/if}
        </span>
      </div>
    </div>

    <div class="section">
      <h2>Send Requests</h2>
      {#if sendRequests.length === 0}
        <p class="muted">No send requests yet.</p>
      {:else}
        <div class="tx-list">
          {#each sendRequests as req}
            <div class="tx-row">
              <div class="tx-info">
                <span class="tx-dest mono">{req.destination.slice(0, 16)}...</span>
                <span class="tx-note">{req.note ?? ""}</span>
              </div>
              <div class="tx-meta">
                <span class="tx-amount">{req.amountSats.toLocaleString()} sats</span>
                <span class="tx-status">{req.status}</span>
                <span class="tx-time">{timeAgo(req.createdAtMs)}</span>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if showSeedModal && seedSetup}
    <SeedPhraseModal
      seedPhrase={seedSetup.seedPhrase}
      derivedAddress={seedSetup.derivedAddress}
      guidance={seedSetup.guidance}
      onDone={handleSeedDone}
    />
  {/if}
</div>

<style>
  .wallet { padding: 1.5rem; max-width: 640px; }
  h1 { font-size: 1.4rem; margin: 0 0 1.5rem; color: var(--text-primary, #e2e8f0); }
  .section, .setup-section {
    background: var(--bg-surface, #1a1a2e);
    border: 1px solid var(--border, #1e1e3f);
    padding: 1.2rem 1.4rem;
    border-radius: 10px;
    margin-bottom: 1.2rem;
  }
  h2 {
    font-size: 0.92rem;
    margin: 0 0 1rem;
    color: var(--text-muted, #94a3b8);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  .setup-section p { color: var(--text-secondary, #94a3b8); font-size: 0.9rem; margin: 0 0 1rem; line-height: 1.5; }
  .info-grid {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 0.5rem 1rem;
    font-size: 0.85rem;
  }
  .info-label { color: var(--text-muted, #94a3b8); padding-top: 0.15rem; }
  .info-value { word-break: break-all; display: flex; align-items: center; gap: 0.5rem; }
  .mono { font-family: "SF Mono", "Fira Code", monospace; font-size: 0.8rem; }
  .muted { color: var(--text-muted, #94a3b8); font-size: 0.85rem; }
  .btn-primary {
    padding: 0.6rem 1.8rem;
    background: var(--accent, #3b82f6);
    color: white;
    border: none;
    border-radius: 7px;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.92rem;
    transition: opacity 0.15s;
  }
  .btn-primary:hover { opacity: 0.9; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-sm {
    padding: 0.3rem 0.6rem;
    background: var(--accent, #3b82f6);
    color: white;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 600;
  }
  .btn-sm:disabled { opacity: 0.5; cursor: not-allowed; }
  .badge-ok { color: var(--green, #4ade80); font-weight: 600; font-size: 0.85rem; }
  .badge-warn { color: #facc15; font-weight: 600; font-size: 0.85rem; }
  .tx-list { display: flex; flex-direction: column; gap: 0.5rem; }
  .tx-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.6rem 0;
    border-bottom: 1px solid var(--border, #1e1e3f);
    font-size: 0.85rem;
  }
  .tx-row:last-child { border-bottom: none; }
  .tx-info { display: flex; flex-direction: column; gap: 0.2rem; }
  .tx-dest { font-weight: 600; }
  .tx-note { color: var(--text-muted, #94a3b8); font-size: 0.8rem; }
  .tx-meta { display: flex; align-items: center; gap: 0.75rem; text-align: right; }
  .tx-amount { font-weight: 600; font-family: monospace; }
  .tx-status { font-size: 0.75rem; text-transform: uppercase; color: var(--text-secondary, #94a3b8); }
  .tx-time { font-size: 0.75rem; color: var(--text-muted, #64748b); }
</style>
