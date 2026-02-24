<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getCredits, getCreditHistory } from "../lib/api";

  let balance = 0;
  let transactions: any[] = [];
  let error = "";
  let interval: ReturnType<typeof setInterval>;

  async function refresh() {
    try {
      const [creds, hist] = await Promise.all([getCredits(), getCreditHistory()]);
      balance = creds.balance;
      transactions = hist.transactions || [];
      error = "";
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load credits";
    }
  }

  onMount(() => {
    refresh();
    interval = setInterval(refresh, 15000);
  });

  onDestroy(() => clearInterval(interval));
</script>

<div class="credits">
  <h1>Credits & Wallet</h1>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  <div class="balance-card">
    <span class="label">Balance</span>
    <span class="amount">{balance.toLocaleString()} sats</span>
  </div>

  <h2>Transaction History</h2>
  {#if transactions.length === 0}
    <p>No transactions yet.</p>
  {:else}
    <div class="tx-list">
      {#each transactions as tx}
        <div class="tx-row">
          <div class="tx-type {tx.type === 'credit' ? 'credit' : 'debit'}">{tx.type}</div>
          <div class="tx-amount">{tx.amount} sats</div>
          <div class="tx-desc">{tx.description || "—"}</div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .credits { padding: 1.5rem; }
  .balance-card { background: var(--bg-card, #1a1a2e); padding: 2rem; border-radius: 12px; text-align: center; margin-bottom: 2rem; }
  .balance-card .label { display: block; opacity: 0.7; margin-bottom: 0.5rem; }
  .amount { font-size: 2.5rem; font-weight: 700; }
  h2 { margin-bottom: 1rem; }
  .tx-list { display: flex; flex-direction: column; gap: 0.5rem; }
  .tx-row { display: flex; align-items: center; gap: 1rem; padding: 0.75rem; background: var(--bg-card, #1a1a2e); border-radius: 8px; }
  .tx-type { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; width: 60px; }
  .credit { color: #4ade80; }
  .debit { color: #f87171; }
  .tx-amount { font-family: monospace; width: 100px; }
  .tx-desc { opacity: 0.7; flex: 1; }
  .error { background: #7f1d1d; color: #fca5a5; padding: 1rem; border-radius: 8px; margin-bottom: 1rem; }
</style>
