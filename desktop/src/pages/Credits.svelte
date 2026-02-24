<script lang="ts">
  import ErrorBanner from "../components/ErrorBanner.svelte";

  // Wallet state
  let balance = $state<{ sats: number; usdEstimate: number } | null>(null);
  let transactions = $state<Transaction[]>([]);
  let loading = $state(true);
  let error = $state("");
  let activeSection: "overview" | "send" | "receive" | "history" = $state("overview");

  // Send form
  let sendAddress = $state("");
  let sendAmountSats = $state(0);
  let sendMemo = $state("");
  let sending = $state(false);
  let sendError = $state("");
  let sendSuccess = $state("");

  interface Transaction {
    id: string;
    type: "earn" | "spend";
    amountSats: number;
    description: string;
    timestamp: number;
    status: "confirmed" | "pending";
  }

  // Mock data for now — will connect to real endpoints
  $effect(() => {
    setTimeout(() => {
      balance = { sats: 42150, usdEstimate: 42.15 };
      transactions = [
        { id: "1", type: "earn", amountSats: 1200, description: "Completed inference task for peer a3f2...", timestamp: Date.now() - 3600000, status: "confirmed" },
        { id: "2", type: "earn", amountSats: 800, description: "Completed inference task for peer b7c1...", timestamp: Date.now() - 7200000, status: "confirmed" },
        { id: "3", type: "spend", amountSats: 500, description: "Code completion request", timestamp: Date.now() - 14400000, status: "confirmed" },
        { id: "4", type: "earn", amountSats: 2000, description: "GPU compute contribution (batch)", timestamp: Date.now() - 86400000, status: "confirmed" },
        { id: "5", type: "spend", amountSats: 150, description: "Test generation request", timestamp: Date.now() - 172800000, status: "pending" },
      ];
      loading = false;
    }, 500);
  });

  function formatSats(sats: number): string {
    return sats.toLocaleString();
  }

  function formatUsd(usd: number): string {
    return `$${usd.toFixed(2)}`;
  }

  function timeAgo(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  async function handleSend() {
    if (!sendAddress.trim() || sendAmountSats <= 0) return;
    sending = true;
    sendError = "";
    sendSuccess = "";
    try {
      // TODO: Connect to real wallet API
      await new Promise((r) => setTimeout(r, 1000));
      sendSuccess = `Sent ${formatSats(sendAmountSats)} sats`;
      sendAddress = "";
      sendAmountSats = 0;
      sendMemo = "";
    } catch (e) {
      sendError = (e as Error).message;
    } finally {
      sending = false;
    }
  }
</script>

<div class="wallet">
  <h1>Wallet</h1>

  {#if error}
    <ErrorBanner message={error} />
  {/if}

  <!-- Balance Card -->
  <div class="balance-card">
    {#if loading}
      <span class="balance-loading">Loading wallet...</span>
    {:else if balance}
      <div class="balance-main">
        <span class="balance-sats">{formatSats(balance.sats)}</span>
        <span class="balance-unit">sats</span>
      </div>
      <span class="balance-usd">≈ {formatUsd(balance.usdEstimate)} USD</span>
    {/if}
  </div>

  <!-- Action Tabs -->
  <div class="action-tabs">
    <button class="action-tab {activeSection === 'overview' ? 'active' : ''}" onclick={() => activeSection = 'overview'}>Overview</button>
    <button class="action-tab {activeSection === 'send' ? 'active' : ''}" onclick={() => activeSection = 'send'}>Send</button>
    <button class="action-tab {activeSection === 'receive' ? 'active' : ''}" onclick={() => activeSection = 'receive'}>Receive</button>
    <button class="action-tab {activeSection === 'history' ? 'active' : ''}" onclick={() => activeSection = 'history'}>History</button>
  </div>

  <!-- Overview -->
  {#if activeSection === "overview"}
    <div class="section">
      <h2>How It Works</h2>
      <div class="explain-grid">
        <div class="explain-item">
          <span class="explain-icon earn">+</span>
          <div>
            <strong>Earn</strong>
            <p>Complete inference tasks for other nodes on the network</p>
          </div>
        </div>
        <div class="explain-item">
          <span class="explain-icon spend">&minus;</span>
          <div>
            <strong>Spend</strong>
            <p>Submit code completion, test generation, and bug fix requests</p>
          </div>
        </div>
        <div class="explain-item">
          <span class="explain-icon lightning">&#9889;</span>
          <div>
            <strong>Lightning</strong>
            <p>Send and receive instantly via Lightning Network micro-payments</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Recent Activity -->
    <div class="section">
      <h2>Recent Activity</h2>
      {#if loading}
        <p class="muted">Loading...</p>
      {:else if transactions.length > 0}
        {#each transactions.slice(0, 3) as tx}
          <div class="tx-row">
            <div class="tx-main">
              <span class="tx-type {tx.type}">{tx.type === "earn" ? "+" : "−"}{formatSats(tx.amountSats)}</span>
              <span class="tx-desc">{tx.description}</span>
            </div>
            <div class="tx-meta">
              <span class="tx-time">{timeAgo(tx.timestamp)}</span>
              <span class="tx-status {tx.status}">{tx.status}</span>
            </div>
          </div>
        {/each}
        <button class="view-all-btn" onclick={() => activeSection = 'history'}>View all transactions</button>
      {:else}
        <p class="muted">No transactions yet</p>
      {/if}
    </div>

  <!-- Send -->
  {:else if activeSection === "send"}
    <div class="section">
      <h2>Send Sats</h2>

      {#if sendError}
        <div class="inline-error">{sendError}</div>
      {/if}
      {#if sendSuccess}
        <div class="inline-success">{sendSuccess}</div>
      {/if}

      <label>
        <span class="label-text">Lightning Address or Invoice</span>
        <input type="text" bind:value={sendAddress} placeholder="lnbc... or user@wallet.com" disabled={sending} />
      </label>

      <label>
        <span class="label-text">Amount (sats)</span>
        <input type="number" bind:value={sendAmountSats} min="1" placeholder="0" disabled={sending} />
      </label>

      <label>
        <span class="label-text">Memo (optional)</span>
        <input type="text" bind:value={sendMemo} placeholder="What's this for?" disabled={sending} />
      </label>

      <button class="btn-send" onclick={handleSend} disabled={sending || !sendAddress.trim() || sendAmountSats <= 0}>
        {sending ? "Sending..." : "Send"}
      </button>
    </div>

  <!-- Receive -->
  {:else if activeSection === "receive"}
    <div class="section">
      <h2>Receive Sats</h2>
      <div class="receive-info">
        <p>Your node automatically earns sats by completing tasks for the network.</p>
        <div class="receive-address">
          <span class="label-text">Lightning Address</span>
          <div class="address-row">
            <code>edgecoder@ln.edgecoder.io</code>
            <button class="btn-copy" onclick={() => navigator.clipboard.writeText('edgecoder@ln.edgecoder.io')}>Copy</button>
          </div>
        </div>
        <p class="muted">Share this address to receive Lightning payments from anywhere.</p>
      </div>
    </div>

  <!-- History -->
  {:else if activeSection === "history"}
    <div class="section">
      <h2>Transaction History</h2>
      {#if loading}
        <p class="muted">Loading...</p>
      {:else if transactions.length > 0}
        {#each transactions as tx}
          <div class="tx-row">
            <div class="tx-main">
              <span class="tx-type {tx.type}">{tx.type === "earn" ? "+" : "−"}{formatSats(tx.amountSats)}</span>
              <span class="tx-desc">{tx.description}</span>
            </div>
            <div class="tx-meta">
              <span class="tx-time">{timeAgo(tx.timestamp)}</span>
              <span class="tx-status {tx.status}">{tx.status}</span>
            </div>
          </div>
        {/each}
      {:else}
        <p class="muted">No transactions yet</p>
      {/if}
    </div>
  {/if}

  <!-- Key Management -->
  <div class="section key-section">
    <h2>Key Management</h2>
    <div class="key-actions">
      <button class="btn-outline">Backup Seed Phrase</button>
      <button class="btn-outline">Export Keys</button>
      <button class="btn-outline">Import Wallet</button>
    </div>
  </div>
</div>

<style>
  .wallet {
    padding: 1.5rem;
    max-width: 700px;
  }
  h1 { margin: 0 0 1.5rem; font-size: 1.4rem; }

  /* Balance Card */
  .balance-card {
    background: linear-gradient(135deg, var(--accent, #c17850), #d4895f, var(--accent, #c17850));
    border-radius: var(--radius-lg);
    padding: 2rem 1.5rem;
    text-align: center;
    margin-bottom: 1.5rem;
  }
  .balance-main {
    display: flex;
    align-items: baseline;
    justify-content: center;
    gap: 8px;
  }
  .balance-sats {
    font-size: 2.4rem;
    font-weight: 700;
    color: white;
  }
  .balance-unit {
    font-size: 1rem;
    color: rgba(255,255,255,0.8);
    font-weight: 500;
  }
  .balance-usd {
    display: block;
    margin-top: 6px;
    font-size: 0.85rem;
    color: rgba(255,255,255,0.7);
  }
  .balance-loading {
    color: rgba(255,255,255,0.6);
    font-size: 0.9rem;
  }

  /* Action Tabs */
  .action-tabs {
    display: flex;
    gap: 2px;
    background: var(--bg-surface);
    border-radius: var(--radius-md);
    padding: 3px;
    margin-bottom: 1.2rem;
  }
  .action-tab {
    flex: 1;
    padding: 8px;
    border: none;
    background: none;
    color: var(--text-secondary);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border-radius: 6px;
    transition: all 0.15s;
  }
  .action-tab:hover {
    color: var(--text-primary);
  }
  .action-tab.active {
    background: var(--bg-base);
    color: var(--text-primary);
    font-weight: 600;
  }

  /* Sections */
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
  .muted { color: var(--text-muted); font-size: 0.85rem; margin: 0; }

  /* Explain grid */
  .explain-grid {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .explain-item {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }
  .explain-icon {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1rem;
    font-weight: 700;
    flex-shrink: 0;
  }
  .explain-icon.earn { background: rgba(74, 222, 128, 0.12); color: var(--green); }
  .explain-icon.spend { background: rgba(193, 120, 80, 0.12); color: var(--accent); }
  .explain-icon.lightning { background: rgba(251, 191, 36, 0.12); color: var(--yellow); }
  .explain-item strong { font-size: 0.88rem; display: block; margin-bottom: 2px; }
  .explain-item p { font-size: 0.8rem; color: var(--text-muted); margin: 0; line-height: 1.4; }

  /* Transactions */
  .tx-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 0;
    border-bottom: 0.5px solid var(--border);
  }
  .tx-row:last-child { border-bottom: none; }
  .tx-main { display: flex; flex-direction: column; gap: 2px; }
  .tx-type {
    font-family: var(--font-mono);
    font-size: 0.88rem;
    font-weight: 600;
  }
  .tx-type.earn { color: var(--green); }
  .tx-type.spend { color: var(--accent); }
  .tx-desc { font-size: 0.78rem; color: var(--text-muted); }
  .tx-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
  .tx-time { font-size: 0.75rem; color: var(--text-muted); }
  .tx-status {
    font-size: 0.68rem;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 3px;
  }
  .tx-status.confirmed { color: var(--green); background: rgba(74, 222, 128, 0.1); }
  .tx-status.pending { color: var(--yellow); background: rgba(251, 191, 36, 0.1); }

  .view-all-btn {
    display: block;
    width: 100%;
    margin-top: 10px;
    padding: 8px;
    background: none;
    border: 0.5px solid var(--border-strong);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 12px;
    transition: all 0.15s;
  }
  .view-all-btn:hover { color: var(--text-primary); border-color: var(--accent); }

  /* Send form */
  label { display: block; margin-bottom: 12px; }
  .label-text { display: block; font-size: 0.82rem; color: var(--text-muted); margin-bottom: 4px; }
  input[type="text"], input[type="number"] {
    width: 100%;
    padding: 10px 12px;
    background: var(--bg-deep, var(--bg-input));
    border: 0.5px solid var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 14px;
    outline: none;
    box-sizing: border-box;
    transition: border-color 0.15s;
  }
  input:focus { border-color: var(--accent); }
  input::placeholder { color: var(--text-muted); }
  input[type="number"] { width: 180px; }

  .btn-send {
    padding: 10px 24px;
    background: var(--accent);
    color: white;
    border: none;
    border-radius: var(--radius-sm);
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
  }
  .btn-send:hover:not(:disabled) { background: var(--accent-hover); }
  .btn-send:disabled { opacity: 0.5; cursor: not-allowed; }

  .inline-error { color: var(--red); font-size: 0.82rem; margin-bottom: 10px; }
  .inline-success { color: var(--green); font-size: 0.82rem; margin-bottom: 10px; }

  /* Receive */
  .receive-info p { font-size: 0.85rem; color: var(--text-secondary); margin: 0 0 12px; line-height: 1.5; }
  .receive-address { margin: 12px 0; }
  .address-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }
  .address-row code {
    flex: 1;
    padding: 10px 12px;
    background: var(--bg-deep, var(--bg-input));
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-primary);
  }
  .btn-copy {
    padding: 8px 14px;
    background: var(--bg-elevated);
    border: 0.5px solid var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn-copy:hover { color: var(--accent); border-color: var(--accent); }

  /* Key Management */
  .key-section { margin-top: 1.5rem; }
  .key-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .btn-outline {
    padding: 8px 16px;
    background: none;
    border: 0.5px solid var(--border-strong);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 12px;
    transition: all 0.15s;
  }
  .btn-outline:hover { color: var(--text-primary); border-color: var(--accent); }
</style>
