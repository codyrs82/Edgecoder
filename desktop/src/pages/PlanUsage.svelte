<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { open as openUrl } from "@tauri-apps/plugin-shell";
  import { computeOverview, computeBuy, computeIntent, portalWebUrl, type ComputeOverview } from "../lib/api";

  let data = $state<ComputeOverview | null>(null);
  let error = $state("");
  let loading = $state(true);
  let copied = $state(false);

  let buyAmount = $state(5000);
  let buying = $state(false);
  let purchase = $state<{ intentId: string; invoice: string; amountSats: number; cSats: number; feeSats: number; network: string } | null>(null);
  let purchaseStatus = $state("");
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  async function load() {
    try {
      data = await computeOverview();
      error = "";
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }
  onMount(load);
  onDestroy(() => clearInterval(pollTimer));

  async function buy() {
    buying = true;
    error = "";
    try {
      purchase = await computeBuy(buyAmount);
      purchaseStatus = "waiting";
      clearInterval(pollTimer);
      pollTimer = setInterval(checkPurchase, 3000);
    } catch (e) {
      error = `Couldn't create the invoice: ${(e as Error).message}`;
    } finally {
      buying = false;
    }
  }

  async function checkPurchase() {
    if (!purchase) return;
    try {
      const s = await computeIntent(purchase.intentId);
      purchaseStatus = s.status;
      if (s.status !== "created") {
        clearInterval(pollTimer);
        await load();
      }
    } catch {
      // keep polling
    }
  }

  async function copyInvoice() {
    if (!purchase) return;
    await navigator.clipboard.writeText(purchase.invoice).catch(() => undefined);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  const fmt = (n: number, digits = 2) => n.toLocaleString(undefined, { maximumFractionDigits: digits });
  const reasonText = (r: string) => {
    const base = r.replace(/:.*/, "");
    const map: Record<string, string> = {
      credit_purchase: "Bought cSats",
      inference_reserve: "Network model (set aside)",
      task_submit_refund: "Unused set-aside returned",
      compute_reservation: "Reserved a machine",
      reservation_refund: "Reservation time returned",
      compute_contribution: "Earned running jobs",
    };
    return map[base] ?? base.replace(/_/g, " ");
  };
</script>

<div class="sp">
  <h1>Plan &amp; usage</h1>
  <p class="sp-lead">cSats pay for compute on the EdgeCoder network: 1 cSat = 1 sat. Models on this computer and on your own machines are free.</p>

  {#if error}<p class="sp-err">{error}</p>{/if}

  {#if loading}
    <p class="sp-muted">Loading…</p>
  {:else if !data?.connected}
    <div class="sp-card"><div class="sp-row"><div class="sp-text"><span class="sp-title">Not connected to the network</span><span class="sp-desc">Sign in and let this computer's agent connect; then you can buy and use compute.</span></div><button onclick={load}>Retry</button></div></div>
  {:else}
    <div class="sp-group">
      <div class="sp-card">
        <div class="sp-row">
          <div class="sp-text">
            <span class="sp-desc">Balance</span>
            <span class="sp-big">{fmt(data.account?.cSats ?? 0)} <span class="sp-unit">cSats</span></span>
          </div>
          <div class="sp-text" style="flex:0 0 auto; text-align:right">
            <span class="sp-desc">Earned by your machines</span>
            <span class="sp-title">{fmt(data.account?.earnedSats ?? 0, 0)} sats</span>
          </div>
        </div>
      </div>
    </div>

    <div class="sp-group">
      <div class="sp-group-title">Buy cSats</div>
      <div class="sp-card">
        {#if !purchase || purchaseStatus === "settled" || purchaseStatus === "expired"}
          <div class="sp-row">
            <div class="sp-text">
              <span class="sp-title">Pay with Lightning</span>
              <span class="sp-desc">A 1.5% network fee comes out of the amount. {#if purchaseStatus === "settled"}<span class="sp-ok">Paid: {fmt(purchase?.cSats ?? 0)} cSats added.</span>{:else if purchaseStatus === "expired"}<span class="sp-warn">That invoice expired.</span>{/if}</span>
            </div>
            <div class="sp-controls">
              <div class="sp-seg">
                {#each [1000, 5000, 20000, 100000] as amt}
                  <button class:active={buyAmount === amt} onclick={() => (buyAmount = amt)}>{amt.toLocaleString()}</button>
                {/each}
              </div>
              <input type="number" min="100" max="1000000" step="100" bind:value={buyAmount} aria-label="Amount in sats" style="width:100px" />
              <button class="primary" disabled={buying || buyAmount < 100} onclick={buy}>{buying ? "Creating…" : "Get invoice"}</button>
            </div>
          </div>
        {:else}
          <div class="sp-row stack">
            <span class="sp-desc">Pay {fmt(purchase.amountSats, 0)} sats; you get {fmt(purchase.cSats)} cSats after the {fmt(purchase.feeSats, 0)} sat fee{purchase.network !== "bitcoin" ? ` (${purchase.network} test network)` : ""}.</span>
            <code class="sp-code" style="white-space:normal; word-break:break-all; max-height:80px">{purchase.invoice}</code>
            <div class="sp-controls" style="justify-content:flex-start">
              <a class="sp-button primary" href={`lightning:${purchase.invoice}`}>Open in wallet</a>
              <button onclick={copyInvoice}>{copied ? "Copied" : "Copy invoice"}</button>
              <span class="sp-muted">Waiting for payment…</span>
            </div>
          </div>
        {/if}
        <div class="sp-row">
          <div class="sp-text"><span class="sp-title">Withdraw earnings</span><span class="sp-desc">Sats your machines earned can be sent to a Lightning wallet from the Wallet page or the web portal.</span></div>
          <button onclick={() => openUrl(portalWebUrl("/portal/wallet"))}>Open wallet ↗</button>
        </div>
      </div>
    </div>

    <div class="sp-group">
      <div class="sp-group-title">Recent activity</div>
      <div class="sp-card">
        {#if (data.account?.recent ?? []).length === 0}
          <div class="sp-row"><span class="sp-muted">Nothing yet.</span></div>
        {:else}
          <table>
            <tbody>
              {#each data.account?.recent ?? [] as r (r.atMs + r.reason)}
                <tr>
                  <td>{reasonText(r.reason)}</td>
                  <td class="sp-muted">{new Date(r.atMs).toLocaleString()}</td>
                  <td class="num" style="color:{r.type === 'earn' ? 'var(--success, #3fb950)' : 'inherit'}">{r.type === "earn" ? "+" : "−"}{fmt(Math.abs(r.cSats), 3)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    </div>
  {/if}
</div>
