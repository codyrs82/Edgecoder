<script lang="ts">
  import ErrorBanner from "../components/ErrorBanner.svelte";
  import { open as openUrl } from "@tauri-apps/plugin-shell";
  import {
    portalWebUrl,
    getPayoutDestination,
    savePayoutDestination,
    getWalletSendRequests,
    type PayoutDestinationView,
    type WalletSendRequest,
  } from "../lib/api";

  let payout = $state<PayoutDestinationView | null>(null);
  const originHost = (o: string) => {
    try {
      return new URL(o).host;
    } catch {
      return o;
    }
  };
  let sendRequests = $state<WalletSendRequest[]>([]);
  let loading = $state(true);
  let error = $state("");

  // "Where should we pay you?" card
  let destInput = $state("");
  let emailCode = $state("");
  let challengeId = $state<string | null>(null);
  let destError = $state("");
  let destInfo = $state("");
  let saving = $state(false);

  async function loadWallet() {
    error = "";
    try {
      const [view, reqs] = await Promise.all([getPayoutDestination(), getWalletSendRequests()]);
      payout = view;
      if (view.destination && !destInput) destInput = view.destination.destination;
      sendRequests = reqs;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  async function saveDestination(withCode: boolean) {
    destError = "";
    destInfo = "";
    const destination = destInput.trim();
    if (!destination) {
      destError = "Enter a Lightning address from your wallet.";
      return;
    }
    if (withCode && (!challengeId || !emailCode.trim())) {
      destError = "Enter the code from the email.";
      return;
    }
    saving = true;
    try {
      const r = await savePayoutDestination(
        withCode ? { destination, challengeId: challengeId!, emailCode: emailCode.trim() } : { destination },
      );
      if (r.status === "saved") {
        payout = r.view;
        challengeId = null;
        emailCode = "";
        const reg = r.view.registration;
        destInfo = reg && (reg.controlPlane === "ok" || reg.coordinator === "ok")
          ? `Saved. Payouts will go to ${r.view.destination?.destination}.`
          : "Saved here, but the payout service could not be reached. Save again later so payouts can reach you.";
      } else if (r.status === "verification_required") {
        challengeId = r.challengeId;
        destInfo = r.detail;
      } else {
        if (withCode) challengeId = null;
        destError = r.detail;
      }
    } finally {
      saving = false;
    }
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
  {:else}
    <div class="section">
      <h2>Where should we pay you?</h2>
      <p class="hint">
        Earnings are paid to a wallet you control. Enter the Lightning address your wallet gives you
        (it looks like name@wallet-domain.com). EdgeCoder never creates or stores your wallet keys.
        On-chain Bitcoin addresses are not supported for payouts yet.
      </p>
      {#if payout?.callbackChange}
        <p class="notice" role="alert">
          Your wallet's payment server changed from {originHost(payout.callbackChange.previousOrigin)} to {originHost(payout.callbackChange.newOrigin)}.
          Confirm to keep receiving payouts. Payouts are paused until then and your earnings are kept.
          <button class="btn-primary" onclick={() => openUrl(portalWebUrl("/portal/settings/plan"))}>Confirm in the portal ↗</button>
        </p>
      {/if}
      {#if payout?.legacyAddressRetired && !payout?.destination}
        <p class="notice">
          The address EdgeCoder generated for this account earlier has been retired because no one holds its keys.
          Nothing was ever paid to it. Your earnings are kept until you set a destination below.
        </p>
      {/if}
      <div class="info-grid">
        <span class="info-label">Current</span>
        <span class="info-value mono">
          {payout?.destination ? payout.destination.destination : "Not set. Payouts are held until you add one."}
        </span>
        {#if payout}
          <span class="info-label">Network</span>
          <span class="info-value">{payout.network}</span>
        {/if}
      </div>
      <label class="field-label" for="payout-dest">Lightning address</label>
      <div class="field-row">
        <input
          id="payout-dest"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="you@wallet.example"
          bind:value={destInput}
          aria-invalid={destError ? "true" : undefined}
        />
        <button class="btn-primary" onclick={() => saveDestination(false)} disabled={saving}>
          {saving && !challengeId ? "Saving..." : "Save"}
        </button>
      </div>
      {#if challengeId}
        <label class="field-label" for="payout-code">Email code</label>
        <div class="field-row">
          <input id="payout-code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" bind:value={emailCode} />
          <button class="btn-primary" onclick={() => saveDestination(true)} disabled={saving}>
            {saving ? "Confirming..." : "Confirm change"}
          </button>
        </div>
      {/if}
      {#if destError}
        <p class="field-error" role="alert">{destError}</p>
      {/if}
      {#if destInfo}
        <p class="muted">{destInfo}</p>
      {/if}
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
</div>

<style>
  .hint { color: var(--text-secondary, #94a3b8); font-size: 0.85rem; margin: 0 0 1rem; line-height: 1.5; }
  .notice {
    font-size: 0.85rem;
    line-height: 1.5;
    margin: 0 0 1rem;
    padding: 0.6rem 0.8rem;
    border: 1px solid #facc15;
    border-radius: 7px;
    color: var(--text-primary, #e2e8f0);
  }
  .field-label { display: block; margin: 1rem 0 0.35rem; font-size: 0.82rem; color: var(--text-muted, #94a3b8); }
  .field-row { display: flex; gap: 0.5rem; }
  .field-row input {
    flex: 1;
    min-width: 0;
    padding: 0.5rem 0.7rem;
    border-radius: 7px;
    border: 1px solid var(--border, #1e1e3f);
    background: var(--bg-input, #0f0f23);
    color: var(--text-primary, #e2e8f0);
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.85rem;
  }
  .field-row input[aria-invalid="true"] { border-color: #f87171; }
  .field-error { color: #f87171; font-size: 0.85rem; margin: 0.5rem 0 0; }
  .wallet { padding: 1.5rem; max-width: 640px; }
  h1 { font-size: 1.4rem; margin: 0 0 1.5rem; color: var(--text-primary, #e2e8f0); }
  .section {
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
