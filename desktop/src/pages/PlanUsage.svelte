<script lang="ts">
  import AgentPausedNotice from "../components/AgentPausedNotice.svelte";
  // Settings > Wallet: balance and Add funds (Lightning top-up with a live invoice, or Fund with
  // Bitcoin on-chain to a deposit address when the coordinator has ONCHAIN_ENABLED), where your sats
  // go, Earnings & withdrawals, where we pay you, and activity. docs/design/wallet-and-market.md.
  // Balance and buying go through this computer's agent (/v1/ide/compute*); the network, the BTC/USD
  // rate, both fees and the payout figures come from the portal (/portal/api/wallet/overview).
  import { onMount, onDestroy } from "svelte";
  import { open as openUrl } from "@tauri-apps/plugin-shell";
  import { Zap, Copy, Check, Clock, ExternalLink, Bitcoin, Coins, TriangleAlert, Wallet } from "@lucide/svelte";
  import {
    computeOverview, computeBuy, computeIntent, portalWebUrl, getWalletOverview, withdrawToInvoice,
    getPayoutDestination, savePayoutDestination, getWalletSendRequests, getOnchainAddress, getOnchainDeposits,
    type ComputeOverview, type WalletOverview, type PayoutDestinationView, type WalletSendRequest, type OnchainFunding, type OnchainPolicyView,
  } from "../lib/api";
  import { scrollRegion } from "../lib/scroll-region";
  import { addressQr, invoiceQr, QR_DARK, QR_LIGHT, QR_QUIET } from "../lib/qr";
  import { countdown, fmtMsat, fmtNum, fmtSats, fmtUsd, networkInfo, pct, purchasePreview, reasonText } from "../lib/wallet-format";

  type Invoice = { intentId: string; invoice: string; amountSats: number; cSats: number; feeSats: number; network: string; expiresInSeconds: number };

  let local = $state<ComputeOverview | null>(null);
  let wallet = $state<WalletOverview | null>(null);
  let walletError = $state("");
  let loading = $state(true);
  let now = $state(Date.now());

  // Add funds
  const PRESETS = [5_000, 20_000, 100_000];
  let preset = $state<number | "custom">(20_000);
  let custom = $state(20_000);
  let amount = $derived(preset === "custom" ? Math.round(Number(custom)) : preset);
  let step = $state<"amount" | "onchain" | "invoice" | "paid" | "expired">("amount");
  // Fund with Bitcoin (on-chain)
  let onchain = $state<OnchainFunding | null>(null);
  let onchainError = $state("");
  let onchainLoading = $state(false);
  let addrCopied = $state(false);
  let onchainTimer: ReturnType<typeof setInterval> | undefined;
  let invoice = $state<Invoice | null>(null);
  let expiresAt = $state(0);
  let paidCSats = $state(0);
  let creating = $state(false);
  let topupError = $state("");
  let copied = $state(false);
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;

  // Withdraw
  let bolt11 = $state("");
  let wCode = $state("");
  let wChallenge = $state<{ id: string; bolt11: string; amountMsat: number; detail: string } | null>(null);
  let wBusy = $state(false);
  let wMsg = $state<{ ok: boolean; text: string } | null>(null);

  // Where we pay you
  let payout = $state<PayoutDestinationView | null>(null);
  let destInput = $state("");
  let destCode = $state("");
  let destChallenge = $state<string | null>(null);
  let destError = $state("");
  let destInfo = $state("");
  let destSaving = $state(false);
  let sendRequests = $state<WalletSendRequest[]>([]);

  let qr = $derived(invoice ? invoiceQr(invoice.invoice) : null);
  let net = $derived(networkInfo(wallet?.network ?? invoice?.network));
  let btcUsd = $derived(wallet?.btcUsd ?? null);
  // Buying is free (0) unless the coordinator states a purchase fee.
  let feeBps = $derived(wallet?.fees.purchaseFeeBps ?? 0);
  let charged = $derived(feeBps > 0);
  let feeKnown = $derived(wallet?.fees.purchaseFeeBps != null);
  let netFeeBps = $derived(wallet?.fees.networkFeeBps ?? 500);
  let valid = $derived(Number.isInteger(amount) && amount >= 100 && amount <= 1_000_000);
  let previewed = $derived(purchasePreview(valid ? amount : 0, feeBps));
  let balance = $derived(local?.connected && local.account ? local.account.cSats : wallet?.cSats ?? null);
  let earned = $derived(local?.account?.earnedSats ?? wallet?.earnedSats ?? null);
  let pb = $derived(wallet?.payouts?.balance ?? null);
  let policy = $derived(wallet?.payouts?.policy ?? null);
  let paused = $derived(policy?.paused === true);
  let oc = $derived<OnchainPolicyView | null>(policy?.onchain?.enabled ? policy.onchain : null);
  let addrQr = $derived(onchain?.address ? addressQr(onchain.address) : null);
  const DEPOSIT_STATUS: Record<string, string> = { pending: "Confirming", credited: "Added", below_minimum: "Below minimum", held: "Held for review", dropped: "Dropped", reversed: "Reversed" };
  function every(ms: number) {
    const h = ms / 3_600_000;
    return h >= 1 ? `every ${Number.isInteger(h) ? h : h.toFixed(1)} h` : `every ${Math.round(ms / 60_000)} min`;
  }
  function onchainPayoutText(o: OnchainPolicyView) {
    const fee = o.payoutFeePayer === "edgecoder"
      ? "EdgeCoder pays the network fee."
      : `The network fee comes out of your payout (at most ${fmtSats(o.payoutMaxFeeSats)} sats; the unused part is returned).`;
    return `BTC to your own bc1 address. Paid in a batch ${every(o.payoutIntervalMs)} once at least ${fmtSats(o.payoutMinSats)} sats are available. ${fee}`;
  }
  let recent = $derived(local?.account?.recent ?? []);
  let policyLine = $derived.by(() => {
    if (!policy) return "Payout details are unavailable right now.";
    if (policy.lightningEnabled === false) return "Lightning payouts are not enabled on this coordinator yet.";
    const parts = [`Minimum ${fmtSats(policy.minPayoutSats ?? 0)} sats.`, `Routing fee up to ${pct(policy.maxFeeBps ?? 0)} is set aside and the unused part returned.`];
    const lim = policy.limits ?? {};
    if (lim.maxSingleSats) parts.push(`Up to ${fmtSats(lim.maxSingleSats)} sats per payout${lim.maxAccountDailySats ? ` and ${fmtSats(lim.maxAccountDailySats)} per 24 h` : ""}.`);
    if (policy.autoMinPayoutSats) parts.push(`Automatic payouts start at ${fmtSats(policy.autoMinPayoutSats)} sats.`);
    return parts.join(" ");
  });
  const reduceMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  async function load() {
    const [l, w] = await Promise.allSettled([computeOverview(), getWalletOverview()]);
    if (l.status === "fulfilled") local = l.value;
    if (w.status === "fulfilled") { wallet = w.value; walletError = ""; } else walletError = (w.reason as Error).message;
    loading = false;
  }
  async function loadPayoutDestination() {
    try {
      const [view, reqs] = await Promise.all([getPayoutDestination(), getWalletSendRequests()]);
      payout = view;
      if (view.destination && !destInput) destInput = view.destination.destination;
      sendRequests = reqs;
    } catch (e) {
      destError = (e as Error).message;
    }
  }
  onMount(() => {
    void load();
    void loadPayoutDestination();
    tick = setInterval(() => (now = Date.now()), 1000);
  });
  onDestroy(() => { clearInterval(pollTimer); clearInterval(tick); clearInterval(onchainTimer); });

  async function openOnchain() {
    clearInterval(pollTimer);
    step = "onchain";
    onchainError = "";
    onchainLoading = true;
    try {
      onchain = await getOnchainAddress();
      clearInterval(onchainTimer);
      onchainTimer = setInterval(async () => {
        try { onchain = await getOnchainDeposits(); } catch { /* keep the last view */ }
      }, 15_000);
    } catch (e) {
      onchainError = (e as Error).message;
    } finally {
      onchainLoading = false;
    }
  }
  function openLightning() { clearInterval(onchainTimer); step = "amount"; }
  async function copyAddress() {
    if (!onchain?.address) return;
    await navigator.clipboard.writeText(onchain.address).catch(() => undefined);
    addrCopied = true;
    setTimeout(() => (addrCopied = false), 1600);
  }

  async function createInvoice() {
    if (!valid) return;
    creating = true;
    topupError = "";
    try {
      invoice = await computeBuy(amount);
      expiresAt = Date.now() + invoice.expiresInSeconds * 1000;
      step = "invoice";
      clearInterval(pollTimer);
      pollTimer = setInterval(checkInvoice, 3000);
    } catch (e) {
      const m = (e as Error).message;
      topupError = /payments_disabled/.test(m) ? "Buying cSats is turned off on this coordinator." : `Couldn't start the payment: ${m}`;
    } finally {
      creating = false;
    }
  }
  async function checkInvoice() {
    if (!invoice) return;
    try {
      const s = await computeIntent(invoice.intentId);
      if (s.status === "settled") {
        clearInterval(pollTimer);
        paidCSats = s.cSats ?? invoice.cSats;
        step = "paid";
        await load();
      } else if (s.status === "expired" || Date.now() > expiresAt + 15_000) {
        clearInterval(pollTimer);
        step = "expired";
      }
    } catch {
      // keep polling
    }
  }
  function backToAmount() { clearInterval(pollTimer); invoice = null; step = "amount"; }
  async function copyInvoice() {
    if (!invoice) return;
    await navigator.clipboard.writeText(invoice.invoice).catch(() => undefined);
    copied = true;
    setTimeout(() => (copied = false), 1600);
  }
  function scrollToFunds() {
    document.getElementById("wallet-add-funds")?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
  }

  async function withdraw(withCode: boolean) {
    wMsg = null;
    const inv = bolt11.trim();
    if (!inv) { wMsg = { ok: false, text: "Paste your wallet's payment code first." }; return; }
    if (withCode && (!wChallenge || wChallenge.bolt11 !== inv || !wCode.trim())) { wMsg = { ok: false, text: "Enter the code from the email, or request a new one." }; return; }
    wBusy = true;
    try {
      const r = await withdrawToInvoice(withCode ? { bolt11: inv, challengeId: wChallenge!.id, emailCode: wCode.trim() } : { bolt11: inv });
      if (r.status === "verification_required") { wChallenge = { id: r.challengeId, bolt11: inv, amountMsat: r.amountMsat, detail: r.detail }; wCode = ""; return; }
      wChallenge = null;
      if (r.status === "paid") { wMsg = { ok: true, text: `Paid ${fmtMsat(r.amountMsat)} sats to your wallet.` }; bolt11 = ""; }
      else wMsg = { ok: false, text: r.detail };
      await load();
    } finally {
      wBusy = false;
    }
  }

  async function saveDestination(withCode: boolean) {
    destError = "";
    destInfo = "";
    const destination = destInput.trim();
    if (!destination) { destError = payout?.onchainSupported ? "Enter a Lightning address or a Bitcoin address from your wallet." : "Enter a Lightning address from your wallet."; return; }
    if (withCode && (!destChallenge || !destCode.trim())) { destError = "Enter the code from the email."; return; }
    destSaving = true;
    try {
      const r = await savePayoutDestination(withCode ? { destination, challengeId: destChallenge!, emailCode: destCode.trim() } : { destination });
      if (r.status === "saved") {
        payout = r.view;
        destChallenge = null;
        destCode = "";
        const reg = r.view.registration;
        destInfo = reg && (reg.controlPlane === "ok" || reg.coordinator === "ok")
          ? `Saved. Payouts will go to ${r.view.destination?.destination}.`
          : "Saved here, but the payout service could not be reached. Save again later so payouts can reach you.";
      } else if (r.status === "verification_required") {
        destChallenge = r.challengeId;
        destInfo = r.detail;
      } else {
        if (withCode) destChallenge = null;
        destError = r.detail;
      }
    } finally {
      destSaving = false;
    }
  }
  const originHost = (o: string) => { try { return new URL(o).host; } catch { return o; } };
  const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const KINDS: Record<string, string> = { withdraw: "Withdrawal", auto: "Automatic", onchain: "On-chain batch" };

  function presetKey(e: KeyboardEvent, i: number) {
    const all: Array<number | "custom"> = [...PRESETS, "custom"];
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = (i + d + all.length) % all.length;
    preset = all[next];
    (document.getElementById(`wallet-preset-${next}`) as HTMLElement | null)?.focus();
  }
</script>

<div class="sp wl">
  <div class="wl-head">
    <h1>Wallet</h1>
    <span class="net-badge {net.tone}" title="Which Bitcoin network this coordinator settles on"><span class="dot"></span>{wallet || invoice ? net.label : "Checking network…"}</span>
  </div>
  <p class="sp-lead">cSats pay for compute on the network. 1 cSat = 1 sat. Models on this computer and on your own machines are free.</p>

  {#if loading}
    <div class="wl-grid" aria-busy="true"><div class="wl-card wl-skel-card"></div><div class="wl-card wl-skel-card"></div></div>
  {:else}
    {#if local?.paused}
      <AgentPausedNotice reason={local.paused.reason} agentId={local.selfAgentId} onRetry={load} />
    {:else if !local?.connected && !wallet?.connected}
      <div class="sp-card"><div class="sp-row"><div class="sp-text"><span class="sp-title">Not connected to the network</span><span class="sp-desc">Sign in and let this computer's agent connect; then you can add funds and use compute. Your balance is safe.</span></div><button onclick={load}>Retry</button></div></div>
    {/if}

    <div class="wl-grid">
      <section class="wl-card wl-balance" aria-labelledby="wl-balance-label">
        <div class="wl-eyebrow" id="wl-balance-label"><Wallet size={14} /> Balance</div>
        <div class="wl-amount"><span class="big">{balance === null ? "–" : fmtNum(balance)}</span><span class="unit">cSats</span></div>
        <div class="wl-sub">{balance !== null && btcUsd ? `${fmtUsd(balance, btcUsd)} · BTC $${fmtSats(btcUsd)}${wallet?.rateStale ? " (rate is stale)" : ""}` : " "}</div>
        <div class="wl-mini">
          <div><div class="k">Earned by your machines</div><div class="v">{pb ? `${fmtMsat(pb.earnedMsat)} sats` : earned === null ? "–" : `${fmtSats(earned)} sats`}</div></div>
          <div><div class="k">Available to withdraw</div><div class="v">{pb ? `${fmtMsat(pb.payableMsat)} sats` : "–"}</div></div>
        </div>
        <p class="wl-faint">Spend it on model calls, code jobs and reserved machines. Earnings from your machines can be withdrawn below; purchased cSats are for spending.</p>
        <div class="wl-actions">
          <button class="primary" onclick={scrollToFunds}><Zap size={14} /> Buy cSats</button>
          <button onclick={() => document.getElementById("wallet-earnings")?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" })}>Withdraw</button>
        </div>
      </section>

      <section class="wl-card" id="wallet-add-funds" aria-labelledby="wl-funds-title">
        {#if step === "amount" || step === "onchain"}
          <h2 class="wl-h" id="wl-funds-title">{step === "onchain" ? "Fund with Bitcoin" : "Buy cSats"}</h2>
          <div class="wl-fund-methods" role="group" aria-label="How to fund">
            <button type="button" class="wl-fund" class:active={step === "amount"} aria-pressed={step === "amount"} onclick={openLightning}><Zap size={14} /> Fund with Lightning</button>
            {#if oc}
              <button type="button" class="wl-fund" class:active={step === "onchain"} aria-pressed={step === "onchain"} onclick={openOnchain}><Bitcoin size={14} /> Fund with Bitcoin</button>
            {:else}
              <button type="button" class="wl-fund soon" disabled title="Coming soon">Fund with Bitcoin <small>Coming soon</small></button>
            {/if}
          </div>
        {/if}
        {#if step === "onchain"}
          <p class="wl-faint">Send bitcoin from any wallet to your deposit address. Your cSats arrive once the payment is confirmed on the blockchain.</p>
          {#if onchainLoading && !onchain}
            <p class="wl-faint" role="status">Getting your address…</p>
          {/if}
          {#if onchainError}<p class="sp-err" role="alert">{onchainError}</p>{/if}
          {#if onchain?.address}
            <div class="wl-inv">
              {#if addrQr}
                <svg class="wl-qr" viewBox="0 0 {addrQr.size + QR_QUIET * 2} {addrQr.size + QR_QUIET * 2}" shape-rendering="crispEdges" role="img" aria-label="Bitcoin deposit address QR code. Scan it with your wallet.">
                  <rect width={addrQr.size + QR_QUIET * 2} height={addrQr.size + QR_QUIET * 2} fill={QR_LIGHT} />
                  <path transform="translate({QR_QUIET} {QR_QUIET})" d={addrQr.d} fill={QR_DARK} />
                </svg>
              {/if}
              <div>
                <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                <div class="wl-inv-text" tabindex="0" aria-label="Your Bitcoin deposit address">{onchain.address}</div>
                <div class="wl-inv-actions">
                  <button class="primary" onclick={copyAddress}>{#if addrCopied}<Check size={14} /> Copied{:else}<Copy size={14} /> Copy address{/if}</button>
                  <a class="sp-button" href={`bitcoin:${onchain.address}`}><ExternalLink size={14} /> Open in wallet</a>
                </div>
                <p class="wl-faint">Credited after {onchain.confirmationsRequired ?? oc?.depositConfirmations ?? 1} confirmation{(onchain.confirmationsRequired ?? 1) === 1 ? "" : "s"}. Minimum {fmtSats(onchain.minSats ?? oc?.depositMinSats ?? 0)} sats; smaller amounts are not credited.{onchain.maxSats ? ` Deposits above ${fmtSats(onchain.maxSats)} sats wait for a manual review.` : ""} You get a new address after each deposit; old ones still work.</p>
              </div>
            </div>
          {/if}
          {#if net.test && wallet}<p class="wl-test"><TriangleAlert size={14} /> This coordinator runs on {net.short}. Send {net.short} coins only; these sats have no value.</p>{/if}
          <div class="wl-sub">Deposits</div>
          {#if (onchain?.deposits ?? []).length === 0}
            <p class="sp-muted">No deposits yet. They show up here as soon as the network sees them.</p>
          {:else}
            <table aria-label="Bitcoin deposits">
              <thead><tr><th>Seen</th><th class="num">Amount (sats)</th><th class="num">Confirmations</th><th>Status</th></tr></thead>
              <tbody>
                {#each onchain?.deposits ?? [] as d (d.txid + ":" + d.vout)}
                  <tr><td>{when(d.seenAtMs)}</td><td class="num">{fmtSats(d.amountSats)}</td>
                    <td class="num">{d.status === "pending" ? `${Math.min(d.confirmations, d.requiredConfirmations)} of ${d.requiredConfirmations}` : d.confirmations}</td>
                    <td><span class="wl-status {d.status === 'credited' ? 'paid' : d.status === 'pending' || d.status === 'held' ? '' : 'failed'}">{DEPOSIT_STATUS[d.status] ?? d.status}</span></td></tr>
                {/each}
              </tbody>
            </table>
          {/if}
        {:else if step === "amount"}
          <p class="wl-faint">Pay from any Lightning wallet. Your cSats arrive the moment the payment lands.</p>
          <div class="wl-presets" role="radiogroup" aria-label="Amount in sats">
            {#each [...PRESETS, "custom" as const] as p, i}
              <button id="wallet-preset-{i}" type="button" role="radio" aria-checked={preset === p} tabindex={preset === p ? 0 : -1}
                onclick={() => (preset = p)} onkeydown={(e) => presetKey(e, i)}>
                {p === "custom" ? "Custom" : fmtSats(p)}<small>{p === "custom" ? "100 to 1M" : "sats"}</small>
              </button>
            {/each}
          </div>
          {#if preset === "custom"}
            <label class="wl-label" for="wallet-custom">Amount in sats</label>
            <input id="wallet-custom" class="wl-input" type="number" inputmode="numeric" min="100" max="1000000" step="1" bind:value={custom} />
          {/if}
          <dl class="wl-break">
            <div><dt>You pay</dt><dd>{valid ? `${fmtSats(amount)} sats` : "100 to 1,000,000 sats"}<small>{valid ? fmtUsd(amount, btcUsd) : ""}</small></dd></div>
            {#if charged}<div class="fee"><dt>Purchase fee ({pct(feeBps)})</dt><dd>{valid ? `− ${feeKnown ? "" : "≈ "}${fmtSats(previewed.fee)} sats` : "–"}</dd></div>{/if}
            <div class="get"><dt>You get</dt><dd>{valid ? `${charged && !feeKnown ? "≈ " : ""}${fmtSats(previewed.get)} cSats` : "–"}</dd></div>
          </dl>
          {#if !charged}<p class="wl-faint">No purchase fee: 1 sat buys 1 cSat.</p>{/if}
          <button class="primary wl-wide" disabled={!valid || creating || !local?.connected} onclick={createInvoice}>
            {creating ? "Preparing payment…" : valid ? `Buy ${fmtSats(amount)} cSats with Lightning` : "Enter 100 to 1,000,000 sats"}
          </button>
          {#if topupError}<p class="sp-err" role="alert">{topupError}</p>{/if}
          {#if net.test && wallet}<p class="wl-test"><TriangleAlert size={14} /> This coordinator runs on {net.short}. Pay with a {net.short} wallet; these sats have no value.</p>{/if}
        {:else if step === "invoice" && invoice}
          <h2 class="wl-h" id="wl-funds-title">Scan to pay <span class="wl-pill">{networkInfo(invoice.network).test ? `${networkInfo(invoice.network).short} · test sats` : "Lightning · mainnet"}</span></h2>
          <p class="wl-faint">Pay {fmtSats(invoice.amountSats)} sats{fmtUsd(invoice.amountSats, btcUsd) ? ` (${fmtUsd(invoice.amountSats, btcUsd)})` : ""}. You get {fmtNum(invoice.cSats, 3)} cSats{invoice.feeSats > 0 ? ` after the ${fmtSats(invoice.feeSats)} sat purchase fee.` : "; there is no purchase fee."}</p>
          <div class="wl-inv">
            {#if qr}
              <svg class="wl-qr" viewBox="0 0 {qr.size + QR_QUIET * 2} {qr.size + QR_QUIET * 2}" shape-rendering="crispEdges" role="img" aria-label="Lightning payment QR code. Scan it with your wallet.">
                <rect width={qr.size + QR_QUIET * 2} height={qr.size + QR_QUIET * 2} fill={QR_LIGHT} />
                <path transform="translate({QR_QUIET} {QR_QUIET})" d={qr.d} fill={QR_DARK} />
              </svg>
            {/if}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <div class="wl-inv-text" tabindex="0" aria-label="Lightning payment code">{invoice.invoice}</div>
          </div>
          <div class="wl-inv-actions">
            <button class="primary" onclick={copyInvoice}>{#if copied}<Check size={14} /> Copied{:else}<Copy size={14} /> Copy payment code{/if}</button>
            <a class="sp-button" href={`lightning:${invoice.invoice}`}><ExternalLink size={14} /> Open in wallet</a>
          </div>
          <div class="wl-wait" role="status">
            <span class="wl-pulse" aria-hidden="true"></span>
            <span class="grow">Waiting for payment…</span>
            <span class="wl-count">{countdown(expiresAt - now)}</span>
          </div>
          <button class="ghost small" onclick={backToAmount}>Choose another amount</button>
        {:else if step === "paid" && invoice}
          <div class="wl-done" role="status">
            <div class="wl-check"><Check size={26} /></div>
            <div class="wl-eyebrow center">Payment received</div>
            <div class="wl-done-big" id="wl-funds-title">+{fmtNum(paidCSats, 3)} cSats</div>
            <dl class="wl-break">
              <div><dt>You paid</dt><dd>{fmtSats(invoice.amountSats)} sats</dd></div>
              {#if invoice.feeSats > 0}<div class="fee"><dt>Purchase fee</dt><dd>− {fmtSats(invoice.feeSats)} sats</dd></div>{/if}
              <div class="get"><dt>Added to your balance</dt><dd>{fmtNum(paidCSats, 3)} cSats</dd></div>
              <div><dt>New balance</dt><dd>{balance === null ? "–" : `${fmtNum(balance)} cSats`}</dd></div>
            </dl>
            <button class="primary wl-wide" onclick={backToAmount}>Done</button>
          </div>
        {:else}
          <div class="wl-done" role="status">
            <div class="wl-check warn"><Clock size={26} /></div>
            <div class="wl-done-big" id="wl-funds-title">This payment code expired</div>
            <p class="wl-faint">Nothing was charged. Get a new code to try again.</p>
            <button class="primary wl-wide" onclick={() => { step = "amount"; void createInvoice(); }}>New payment code</button>
            <button class="ghost wl-wide" onclick={backToAmount}>Change amount</button>
          </div>
        {/if}
      </section>
    </div>

    <section class="wl-card" aria-labelledby="wl-where">
      <h2 class="wl-h" id="wl-where">Where your sats go</h2>
      <p class="wl-faint">Adding funds is {charged ? `${pct(feeBps)} on this coordinator` : "free"}. When you use compute on someone else's machine, {pct(10000 - netFeeBps)} goes to that machine's owner and EdgeCoder keeps {pct(netFeeBps)}. Nothing else is taken.</p>
      <div class="wl-flow">
        <div><div class="k">You pay</div><div class="v">{valid ? fmtSats(amount) : "–"} sats</div><div class="d">From any Lightning wallet</div></div>
        <div><div class="k">Purchase fee · {charged ? pct(feeBps) : "free"}</div><div class="v">{valid ? fmtSats(previewed.fee) : "–"} sats</div><div class="d">{charged ? "Set by this coordinator and kept by it" : "Buying cSats costs nothing"}</div></div>
        <div><div class="k">Your balance</div><div class="v">{valid ? fmtSats(previewed.get) : "–"} cSats</div><div class="d">Spent per token on model calls, per second on jobs</div></div>
      </div>
      <div class="wl-sub">When you spend cSats on someone else's machine</div>
      <div class="wl-split" role="img" aria-label="{pct(10000 - netFeeBps)} to the machine's owner, {pct(netFeeBps)} kept by EdgeCoder">
        <span class="owner" style:flex-grow={10000 - netFeeBps}></span><span class="net" style:flex-grow={netFeeBps}></span>
      </div>
      <div class="wl-legend">
        <span><i class="owner"></i>{pct(10000 - netFeeBps)} to the machine's owner (the compute host)</span>
        <span><i class="net"></i>{pct(netFeeBps)} kept by EdgeCoder (the network fee)</span>
      </div>
    </section>

    <h2 class="wl-section" id="wallet-earnings">Earnings &amp; withdrawals</h2>
    <p class="wl-faint wl-lead">What your machines earned: {pct(10000 - netFeeBps)} of what their work was paid (EdgeCoder keeps {pct(netFeeBps)}). Purchased cSats can be spent but not withdrawn.</p>
    {#if walletError}<p class="sp-err">{walletError}</p>{/if}
    {#if paused}
      <p class="wl-banner" role="alert"><TriangleAlert size={15} /> Withdrawals are paused on this coordinator while it is checked. Your earnings are safe and keep counting; buying cSats still works.</p>
    {/if}
    <div class="wl-kpis">
      <div><div class="k">Earned</div><div class="v">{pb ? fmtMsat(pb.earnedMsat) : "–"} sats</div><div class="d">All time</div></div>
      <div class="held"><div class="k"><Clock size={12} /> Held</div><div class="v">{pb ? fmtMsat(pb.heldMsat) : "–"} sats</div>
        <div class="d">{pb && pb.heldMsat > 0 && pb.maturesAtMs ? `Available ${when(pb.maturesAtMs)}` : policy?.network === "bitcoin" ? "Earnings wait 24 h" : "No hold on this network"}</div></div>
      <div class="avail"><div class="k">Available</div><div class="v">{pb ? fmtMsat(pb.payableMsat) : "–"} sats</div><div class="d">Ready to withdraw</div></div>
      <div><div class="k">Paid out</div><div class="v">{pb ? fmtMsat(pb.paidMsat) : "–"} sats</div><div class="d">{pb && pb.pendingMsat > 0 ? `${fmtMsat(pb.pendingMsat)} sats on the way` : " "}</div></div>
    </div>

    <div class="wl-sub">Payout method</div>
    <div class="wl-methods" role="list">
      <div class="wl-method active" role="listitem"><div class="t"><span><Zap size={15} /> Lightning</span><span class="wl-pill ok">Active</span></div><div class="d">BTC. Withdraw now from any Lightning wallet, or get paid automatically to a Lightning address.</div></div>
      {#if oc}
        <div class="wl-method active" role="listitem"><div class="t"><span><Bitcoin size={15} /> Bitcoin on-chain</span><span class="wl-pill ok">Available</span></div><div class="d">{onchainPayoutText(oc)}</div></div>
      {:else}
        <div class="wl-method soon" role="listitem"><div class="t"><span><Bitcoin size={15} /> Bitcoin on-chain</span><span class="wl-pill">Coming soon</span></div><div class="d">BTC. Batched payouts above a minimum. Not available yet.</div></div>
      {/if}
      <div class="wl-method soon" role="listitem"><div class="t"><span><Coins size={15} /> Zcash on-chain</span><span class="wl-pill">Coming soon</span></div><div class="d">ZEC. Batched payouts. Not available yet.</div></div>
    </div>

    <div class="sp-group">
      <div class="sp-group-title">Withdraw now</div>
      <div class="sp-card">
        <div class="sp-row stack">
          <label class="wl-label" for="wallet-bolt11">Your wallet's payment code (lnbc…) for the exact amount, from its Receive screen</label>
          <textarea id="wallet-bolt11" class="wl-textarea" rows="3" placeholder="lnbc…" spellcheck="false" bind:value={bolt11}></textarea>
          {#if wChallenge}
            <p class="wl-faint">{wChallenge.detail} Amount: {fmtMsat(wChallenge.amountMsat)} sats.</p>
            <div class="wl-inline">
              <label class="sr-only" for="wallet-wcode">Email code</label>
              <input id="wallet-wcode" class="wl-input" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" bind:value={wCode} />
              <button class="primary" disabled={wBusy} onclick={() => withdraw(true)}>{wBusy ? "Paying…" : "Confirm withdrawal"}</button>
            </div>
          {:else}
            <div><button class="primary" disabled={wBusy || paused || policy?.lightningEnabled === false} onclick={() => withdraw(false)}>{wBusy ? "Sending code…" : "Email me a code"}</button></div>
          {/if}
          {#if wMsg}<p class={wMsg.ok ? "sp-ok" : "sp-err"} role={wMsg.ok ? "status" : "alert"}>{wMsg.text}</p>{/if}
          <p class="wl-faint">{policyLine}</p>
        </div>
      </div>
    </div>

    <div class="sp-group">
      <div class="sp-group-title">Where should we pay you?</div>
      <div class="sp-card">
        <div class="sp-row stack">
          {#if payout?.onchainSupported}
            <p class="wl-faint">Automatic payouts go to a Lightning address (name@wallet-domain.com) or a Bitcoin address (bc1…) from a wallet you control. EdgeCoder never creates or stores your wallet keys.</p>
          {:else}
            <p class="wl-faint">Automatic payouts go to a Lightning address from a wallet you control (name@wallet-domain.com). EdgeCoder never creates or stores your wallet keys.</p>
          {/if}
          {#if payout?.callbackChange}
            <p class="wl-banner" role="alert">
              Your wallet's payment server changed from {originHost(payout.callbackChange.previousOrigin)} to {originHost(payout.callbackChange.newOrigin)}. Payouts are paused until you confirm; your earnings are kept.
              <button class="small" onclick={() => openUrl(portalWebUrl("/portal/settings/plan"))}>Confirm in the portal <ExternalLink size={12} /></button>
            </p>
          {/if}
          {#if payout?.legacyAddressRetired && !payout?.destination}
            <p class="wl-banner">The address EdgeCoder generated for this account earlier has been retired because no one holds its keys. Nothing was ever paid to it.</p>
          {/if}
          <p class="wl-faint">Current: <strong class="mono">{payout?.destination ? payout.destination.destination : "Not set. Automatic payouts wait until you add one."}</strong></p>
          <label class="wl-label" for="payout-dest">{payout?.onchainSupported ? "Lightning address or Bitcoin address" : "Lightning address"}</label>
          <div class="wl-inline">
            <input id="payout-dest" class="wl-input" type="text" autocomplete="off" spellcheck="false" placeholder={payout?.onchainSupported ? "you@wallet.example or bc1…" : "you@wallet.example"} bind:value={destInput} aria-invalid={destError ? "true" : undefined} />
            <button class="primary" onclick={() => saveDestination(false)} disabled={destSaving}>{destSaving && !destChallenge ? "Saving…" : "Save"}</button>
          </div>
          {#if destChallenge}
            <label class="wl-label" for="payout-code">Email code</label>
            <div class="wl-inline">
              <input id="payout-code" class="wl-input" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" bind:value={destCode} />
              <button class="primary" onclick={() => saveDestination(true)} disabled={destSaving}>{destSaving ? "Confirming…" : "Confirm change"}</button>
            </div>
          {/if}
          {#if payout?.destination?.kind === "onchain" && oc}<p class="wl-faint">{onchainPayoutText(oc)}</p>{/if}
          {#if destError}<p class="sp-err" role="alert">{destError}</p>{/if}
          {#if destInfo}<p class="sp-muted">{destInfo}</p>{/if}
        </div>
      </div>
    </div>

    <div class="sp-group">
      <div class="sp-group-title">Payout history</div>
      <div class="sp-card sp-table-scroll" role="group" aria-label="Payout history" use:scrollRegion>
        {#if (wallet?.payouts?.payouts ?? []).length === 0}
          <div class="sp-row"><span class="sp-muted">No payouts yet. Earnings you withdraw show up here.</span></div>
        {:else}
          <table>
            <thead><tr><th>Time</th><th>Asset</th><th>Kind</th><th class="num">Amount (sats)</th><th class="num">Fee</th><th>Status</th></tr></thead>
            <tbody>
              {#each wallet?.payouts?.payouts ?? [] as p (p.createdAtMs + p.kind)}
                <tr><td>{when(p.createdAtMs)}</td><td><strong>BTC</strong> <span class="sp-muted">{p.kind === "onchain" ? `On-chain${p.txid ? ` · ${p.txid.slice(0, 10)}…` : ""}` : "Lightning"}</span></td><td>{KINDS[p.kind] ?? p.kind}</td><td class="num">{fmtMsat(p.amountMsat)}</td><td class="num">{fmtMsat(p.feeMsat)}</td>
                  <td><span class="wl-status {p.status}">{p.status}</span>{#if p.error} <span class="sp-muted">{p.error}</span>{/if}</td></tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    </div>

    <div class="sp-group">
      <div class="sp-group-title">Activity</div>
      <div class="sp-card sp-table-scroll" role="group" aria-label="Activity" use:scrollRegion>
        {#if recent.length === 0}
          <div class="sp-row"><span class="sp-muted">Nothing yet. Buy cSats or connect a machine to get started.</span></div>
        {:else}
          <table>
            <tbody>
              {#each recent as r (r.atMs + r.reason)}
                <tr>
                  <td>{reasonText(r.reason)}</td>
                  <td class="sp-muted">{when(r.atMs)}</td>
                  <td class="num" class:wl-pos={r.type === "earn"}>{r.type === "earn" ? "+" : "−"}{fmtNum(Math.abs(r.cSats), 3)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    </div>

    {#if sendRequests.length}
      <div class="sp-group">
        <div class="sp-group-title">Earlier send requests</div>
        <div class="sp-card sp-table-scroll" role="group" aria-label="Earlier send requests" use:scrollRegion>
          <table>
            <tbody>
              {#each sendRequests as req (req.requestId)}
                <tr><td class="mono">{req.destination.slice(0, 18)}…</td><td class="num">{fmtSats(req.amountSats)} sats</td><td>{req.status}</td><td class="sp-muted">{when(req.createdAtMs)}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .wl-fund-methods { display: flex; gap: 8px; flex-wrap: wrap; margin: 6px 0 10px; }
  .wl-fund { display: inline-flex; align-items: center; gap: 6px; height: var(--control-md, 28px); padding: 0 10px; border-radius: 999px; border: 1px solid var(--card-border, var(--border)); font-size: 12.5px; font-weight: 600; }
  .wl-fund.active { border-color: var(--brand, var(--accent)); }
  .wl-fund.soon { border-style: dashed; }
  button.wl-fund { background: transparent; color: inherit; cursor: pointer; }
  button.wl-fund:disabled { cursor: default; }
  .wl-fund small { font-weight: 500; }
  .wl { gap: 18px; }
  .wl-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .net-badge { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
    border: 0.5px solid var(--border-strong); color: var(--text-secondary); background: var(--bg-elevated); }
  .net-badge .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); }
  .net-badge.test { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 45%, transparent); }
  .net-badge.test .dot { background: var(--yellow); }
  .net-badge.main { color: var(--text-primary); border-color: var(--accent); }
  .net-badge.main .dot { background: var(--accent); }
  .wl-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); gap: 14px; }
  @media (max-width: 900px) { .wl-grid { grid-template-columns: minmax(0, 1fr); } }
  .wl-card { border: 0.5px solid var(--border); border-radius: 14px; background: var(--bg-surface); padding: 20px; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .wl-skel-card { min-height: 260px; animation: wl-shimmer 1.4s ease-in-out infinite; }
  @keyframes wl-shimmer { 50% { opacity: 0.55; } }
  .wl-balance { background: radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 60%), var(--bg-surface); }
  .wl-eyebrow { font-size: 12px; font-weight: 600; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; }
  .wl-eyebrow.center { justify-content: center; }
  .wl-amount { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
  .wl-amount .big { font-size: 40px; font-weight: 650; letter-spacing: -0.03em; line-height: 1.05; color: var(--text-primary); }
  .wl-amount .unit { font-size: 15px; font-weight: 600; color: var(--text-secondary); }
  .wl-sub { color: var(--text-secondary); font-size: 12.5px; }
  .wl-faint { color: var(--text-secondary); font-size: 12.5px; line-height: 1.5; margin: 0; }
  .wl-lead { margin-top: -12px; }
  .wl-mini { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 10px 0 12px; }
  .wl-mini > div { border: 0.5px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--bg-base); }
  .wl-mini .k { font-size: 12px; color: var(--text-secondary); }
  .wl-mini .v { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 2px; color: var(--text-primary); }
  .wl-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: auto; }
  .wl-h { font-size: 15px; font-weight: 600; margin: 0 0 2px; display: flex; align-items: center; gap: 8px; color: var(--text-primary); }
  .wl-section { font-size: 17px; font-weight: 650; margin: 10px 0 0; color: var(--text-primary); }
  .wl-pill { white-space: nowrap; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; border: 0.5px solid var(--border-strong); color: var(--text-secondary); }
  .wl-pill.ok { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, transparent); }
  .wl-presets { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 10px 0 6px; }
  .sp .wl-presets button { flex-direction: column; gap: 2px; min-height: 44px; justify-content: center; font-size: 13px; font-variant-numeric: tabular-nums; }
  .wl-presets button small { font-size: 11px; color: var(--text-secondary); }
  .sp .wl-presets button[aria-checked="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
  .wl-label { font-size: 12px; color: var(--text-secondary); }
  .sp .wl-input { min-width: 0; flex: 1; font-variant-numeric: tabular-nums; }
  .wl-textarea { width: 100%; box-sizing: border-box; font-family: var(--font-mono); font-size: 12px; padding: 8px 10px; border-radius: 8px; border: 0.5px solid var(--border-control); background: var(--bg-base); color: var(--text-primary); resize: vertical; }
  .wl-inline { display: flex; gap: 8px; align-items: center; }
  .wl-break { margin: 6px 0 10px; border-top: 0.5px solid var(--border); }
  .wl-break div { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 8px 0; border-bottom: 0.5px solid var(--border); font-size: 13px; }
  .wl-break dt { color: var(--text-secondary); margin: 0; }
  .wl-break dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; color: var(--text-primary); }
  .wl-break dd small { display: block; color: var(--text-secondary); font-size: 11.5px; }
  .wl-break .get dt, .wl-break .get dd { color: var(--text-primary); font-weight: 650; font-size: 14px; }
  .sp .wl-wide { width: 100%; justify-content: center; min-height: 40px; font-size: 13.5px; }
  .wl-test { color: var(--yellow); font-size: 12px; display: flex; gap: 6px; align-items: flex-start; margin: 4px 0 0; }
  .wl-inv-text { font-family: var(--font-mono); font-size: 12px; line-height: 1.5; word-break: break-all; padding: 10px 12px; border-radius: 10px;
    background: var(--bg-base); border: 0.5px solid var(--border); max-height: 96px; overflow: auto; color: var(--text-secondary); margin-top: 8px; }
  .wl-inv { display: grid; grid-template-columns: 168px minmax(0, 1fr); gap: 14px; align-items: start; }
  @media (max-width: 760px) { .wl-inv { grid-template-columns: minmax(0, 1fr); } }
  .wl-qr { width: 168px; height: 168px; border-radius: 12px; border: 0.5px solid var(--border); margin-top: 8px; }
  @media (max-width: 760px) { .wl-qr { width: min(220px, 100%); height: auto; aspect-ratio: 1; margin: 8px auto 0; } }
  .wl-inv-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
  .wl-wait { display: flex; align-items: center; gap: 10px; margin: 10px 0 4px; padding: 10px 12px; border-radius: 10px; background: var(--bg-base); border: 0.5px solid var(--border); font-size: 13px; color: var(--text-primary); }
  .wl-wait .grow { flex: 1; }
  .wl-pulse { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); flex: none; animation: wl-pulse 1.6s ease-out infinite; }
  @keyframes wl-pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent); } 70% { box-shadow: 0 0 0 10px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
  .wl-count { font-variant-numeric: tabular-nums; color: var(--text-secondary); font-size: 12px; }
  .wl-done { text-align: center; display: flex; flex-direction: column; gap: 8px; }
  .wl-done .wl-break { text-align: left; }
  .wl-check { width: 52px; height: 52px; border-radius: 50%; margin: 4px auto 6px; display: flex; align-items: center; justify-content: center;
    background: color-mix(in srgb, var(--green) 10%, transparent); color: var(--green); animation: wl-pop 360ms cubic-bezier(.2,.9,.3,1.3) both; }
  .wl-check.warn { background: color-mix(in srgb, var(--yellow) 10%, transparent); color: var(--yellow); }
  @keyframes wl-pop { from { transform: scale(0.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  .wl-done-big { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; color: var(--text-primary); }
  .wl-flow { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 8px 0 12px; }
  @media (max-width: 760px) { .wl-flow { grid-template-columns: minmax(0, 1fr); } }
  .wl-flow > div { padding: 10px 12px; border: 0.5px solid var(--border); background: var(--bg-base); }
  .wl-flow .k { font-size: 12px; color: var(--text-secondary); }
  .wl-flow .v { font-size: 17px; font-weight: 650; font-variant-numeric: tabular-nums; color: var(--text-primary); }
  .wl-flow .d { font-size: 12px; color: var(--text-secondary); }
  .wl-split { display: flex; height: 10px; border-radius: 999px; overflow: hidden; background: var(--bg-elevated); margin: 6px 0; }
  .wl-split .owner { background: var(--green); }
  .wl-split .net { background: var(--accent); }
  .wl-legend { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--text-secondary); }
  .wl-legend i { width: 9px; height: 9px; border-radius: 3px; display: inline-block; margin-right: 6px; }
  .wl-legend i.owner { background: var(--green); } .wl-legend i.net { background: var(--accent); }
  .wl-banner { display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap; padding: 10px 12px; border-radius: 10px; margin: 0; font-size: 12.5px; color: var(--text-primary);
    border: 0.5px solid var(--yellow); }
  .wl-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
  @media (max-width: 860px) { .wl-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .wl-kpis > div { border: 0.5px solid var(--border); border-radius: 12px; padding: 12px 14px; background: var(--bg-surface); }
  .wl-kpis .k { font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 5px; }
  .wl-kpis .v { font-size: 19px; font-weight: 650; font-variant-numeric: tabular-nums; color: var(--text-primary); }
  .wl-kpis .d { font-size: 12px; color: var(--text-secondary); }
  .wl-kpis .avail { border-color: var(--green); }
  .wl-kpis .avail .v { color: var(--green); }
  .wl-kpis .held .v { color: var(--yellow); }
  .wl-methods { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  @media (max-width: 860px) { .wl-methods { grid-template-columns: minmax(0, 1fr); } }
  .wl-method { border: 0.5px solid var(--border); border-radius: 12px; padding: 12px 14px; background: var(--bg-surface); display: flex; flex-direction: column; gap: 4px; }
  .wl-method.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
  .wl-method.soon { opacity: 0.7; }
  .wl-method .t { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 600; font-size: 13.5px; color: var(--text-primary); }
  .wl-method .t > span:first-child { display: inline-flex; align-items: center; gap: 6px; }
  .wl-method .d { font-size: 12px; color: var(--text-secondary); line-height: 1.45; }
  .wl-status { font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--yellow); }
  .wl-status.paid { color: var(--green); }
  .wl-status.failed { color: var(--danger); }
  .wl-pos { color: var(--green); }
  .mono { font-family: var(--font-mono); font-size: 12px; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  @media (prefers-reduced-motion: reduce) {
    .wl-pulse, .wl-check, .wl-skel-card { animation: none; }
  }
</style>
