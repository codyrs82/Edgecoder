// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Wallet page: the direct (non-custodial) payment sections, shown only when the coordinator turns
 * those paths on (GET /portal/api/payments/paths; docs/design/noncustodial-payments.md):
 * "Reservations & commitments (pay directly)" (connect a wallet over NWC, reserve a host over
 * Lightning / Bitcoin on-chain / Zcash) and "Payout addresses" (for hosts). The on-demand cSats
 * balance above them is unchanged. Written with String.raw so the browser script is verbatim.
 */

export const WALLET_DIRECT_CONTENT = String.raw`
    <div id="directPay" hidden>
      <h2 class="wl-section-title" id="reservations-direct">Reservations &amp; commitments (pay directly)</h2>
      <p class="set-lead">For reserved machines, blocks of time and whole-server commitments you pay the host straight from your own wallet, plus EdgeCoder's 5 % to EdgeCoder's address. EdgeCoder never holds this money.</p>
      <div class="wl-two">
        <div class="wl-card" id="nwcCard">
          <h3>Connect your wallet</h3>
          <div class="wl-faint">Paste a Nostr Wallet Connect string from your wallet (Alby Hub, Zeus, …) and set its daily budget there. It is stored encrypted and never shown again.</div>
          <label for="nwcInput" class="u-mt-8">Connection string</label>
          <input id="nwcInput" type="password" autocomplete="off" spellcheck="false" placeholder="nostr+walletconnect://…" />
          <label class="u-mt-6" id="nwcSpotWrap" hidden><input type="checkbox" id="nwcSpot" /> Also pay on-demand calls from this wallet instead of cSats</label>
          <div class="wl-actions u-mt-8"><button class="primary" id="nwcConnectBtn">Connect</button><button class="ghost" id="nwcSettleBtn">Settle now</button><button class="ghost" id="nwcDisconnectBtn">Disconnect</button></div>
          <div class="wl-faint u-mt-6" id="nwcStatus" role="status">No wallet connected.</div>
        </div>
        <div class="wl-card" id="reserveCard">
          <h3>Reserve a host</h3>
          <div class="wl-faint">Pick a class and how long. Lightning suits small to medium blocks; Bitcoin on-chain and Zcash suit large commitments.</div>
          <div class="wl-row u-mt-8">
            <label>Class <select id="resClass"><option value="gpu">GPU</option><option value="apple">Apple silicon</option><option value="gpu.dc">Datacenter GPU</option><option value="cpu">CPU</option></select></label>
            <label>Minutes <input id="resMinutes" type="number" min="5" value="60" /></label>
            <label>Pay with <select id="resRail"><option value="lightning">Lightning</option><option value="onchain">Bitcoin on-chain</option><option value="zcash">Zcash (shielded)</option></select></label>
          </div>
          <div class="wl-actions u-mt-8"><button class="primary" id="resQuoteBtn">Get a quote</button><button class="ghost" id="resPayNwcBtn" hidden>Pay with connected wallet</button></div>
          <pre class="wl-faint u-mt-6" id="resQuote" hidden></pre>
          <div class="wl-row u-mt-6" id="resTxids" hidden><input id="resHostTxid" placeholder="Host payment txid" /><input id="resFeeTxid" placeholder="Fee payment txid" /><button class="ghost" id="resCheckBtn">Check payment</button></div>
          <div class="wl-faint u-mt-6" id="resStatus" role="status"></div>
        </div>
      </div>
      <h2 class="wl-section-title" id="payout-addresses">Payout addresses</h2>
      <p class="set-lead">Hosting? Where buyers pay you directly. The Zcash viewing key lets EdgeCoder see incoming payments to confirm reservations; it cannot spend.</p>
      <div class="wl-card" id="payoutProfileCard">
        <div class="wl-row">
          <label>Lightning address <input id="ppLightning" placeholder="you@wallet.example" /></label>
          <label>Bitcoin address or xpub/zpub <input id="ppBtc" placeholder="bc1… or zpub…" /></label>
        </div>
        <div class="wl-row u-mt-6">
          <label>Zcash shielded address <input id="ppZcash" placeholder="zs1… / u1…" /></label>
          <label>Zcash incoming viewing key <input id="ppZivk" type="password" autocomplete="off" placeholder="zivks1… / uivk1…" /></label>
        </div>
        <div class="wl-actions u-mt-8"><button class="primary" id="ppSaveBtn">Save payout addresses</button></div>
        <div class="wl-faint u-mt-6" id="ppStatus" role="status"></div>
      </div>
    </div>

`;

/** Runs inside WALLET_SCRIPT (uses its $, fmtSats and fmtTime). */
export const WALLET_DIRECT_SCRIPT = String.raw`
    /* ── Direct payments (flag-gated on the coordinator) ── */
    async function directApi(action, body) {
      const res = await fetch("/portal/api/payments/" + action, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
      return { status: res.status, payload: await res.json().catch(() => ({})) };
    }
    let directQuote = null;
    function renderNwc(s) {
      if (!s || !s.connected) { $("nwcStatus").textContent = "No wallet connected."; return; }
      const owed = s.unsettledCSats ? " Owed to hosts now: " + s.unsettledCSats + " of " + s.capCSats + " cSats." : "";
      $("nwcStatus").textContent = (s.paused ? "Paused: " + s.paused.reason + ". Reconnect or top up your wallet." : "Wallet connected" + (s.useForSpot ? ", paying on-demand calls." : ".")) + owed;
    }
    async function loadDirect() {
      const res = await fetch("/portal/api/payments/paths", { credentials: "same-origin" });
      const paths = await res.json().catch(() => ({}));
      if (!paths || (!paths.directReservations && !paths.nwc)) return;
      $("directPay").hidden = false;
      $("nwcSpotWrap").hidden = !paths.nwc;
      $("reserveCard").hidden = !paths.directReservations;
      const [st, pp] = await Promise.all([directApi("nwc-status"), directApi("payout-profile")]);
      if (st.status === 200) renderNwc(st.payload);
      const p = pp.status === 200 && pp.payload.profile;
      if (p) { $("ppLightning").value = p.lightningAddress || ""; $("ppBtc").value = p.btcAddress || (p.btcXpubSet ? "(xpub saved)" : ""); $("ppZcash").value = p.zcashAddress || ""; $("ppZivk").placeholder = p.zcashViewingKeySet ? "(saved)" : $("ppZivk").placeholder; }
    }
    $("nwcConnectBtn").addEventListener("click", async () => {
      const r = await directApi("nwc-connect", { connection: $("nwcInput").value.trim(), useForSpot: $("nwcSpot").checked });
      $("nwcInput").value = "";
      if (r.status !== 200) { $("nwcStatus").textContent = "Could not connect: " + (r.payload.error || r.status); return; }
      const st = await directApi("nwc-status"); renderNwc(st.payload);
    });
    $("nwcSettleBtn").addEventListener("click", async () => { await directApi("nwc-settle"); const st = await directApi("nwc-status"); renderNwc(st.payload); });
    $("nwcDisconnectBtn").addEventListener("click", async () => { await directApi("nwc-disconnect"); renderNwc(null); });
    function showQuote(q) {
      directQuote = q;
      const lines = ["Reservation " + q.reservationId + ": " + fmtSats(q.priceCSats) + " cSats (" + fmtSats(q.hostSats) + " to the host + " + fmtSats(q.feeSats) + " to EdgeCoder). Pay by " + fmtTime(q.expiresAtMs) + "."];
      if (q.lightning) lines.push("Host invoice: " + q.lightning.hostInvoice, "Fee invoice: " + q.lightning.feeInvoice);
      if (q.onchain) lines.push("Send " + fmtSats(q.hostSats) + " sats to " + q.onchain.hostAddress, "Send " + fmtSats(q.feeSats) + " sats to " + q.onchain.feeAddress, "Then paste both txids below (" + q.onchain.minConfirmations + " confirmation needed).");
      if (q.zcash) lines.push("Send " + (q.zcash.zatoshi / 1e8) + " ZEC to " + q.zcash.hostAddress + " with memo " + q.zcash.hostMemo, "Send " + (q.zcash.feeZatoshi / 1e8) + " ZEC to " + q.zcash.feeAddress + " with memo " + q.zcash.feeMemo);
      $("resQuote").textContent = lines.join("\n"); $("resQuote").hidden = false;
      $("resPayNwcBtn").hidden = !q.lightning; $("resTxids").hidden = !q.onchain;
      if (q.zcash) { $("resTxids").hidden = false; $("resHostTxid").hidden = true; $("resFeeTxid").hidden = true; }
    }
    $("resQuoteBtn").addEventListener("click", async () => {
      $("resStatus").textContent = "Finding a host…";
      const r = await directApi("reserve-quote", { computeClass: $("resClass").value, minutes: Math.round(Number($("resMinutes").value)), rail: $("resRail").value });
      if (r.status !== 200) { $("resStatus").textContent = "No quote: " + (r.payload.error || r.status); return; }
      $("resStatus").textContent = ""; showQuote(r.payload.quote);
    });
    async function confirmReservation(extra) {
      if (!directQuote) return;
      const r = await directApi("reserve-confirm", Object.assign({ reservationId: directQuote.reservationId }, extra));
      $("resStatus").textContent = r.status === 200 ? (r.payload.status === "active" ? "Reserved until " + fmtTime(r.payload.reservation.endMs) + ". Receipts: " + r.payload.quote.receipts.length + "." : "Payment " + r.payload.status + ".") : "Error: " + (r.payload.error || r.status);
    }
    $("resPayNwcBtn").addEventListener("click", () => confirmReservation({ payWithNwc: true }));
    $("resCheckBtn").addEventListener("click", () => confirmReservation(directQuote && directQuote.onchain ? { hostTxid: $("resHostTxid").value.trim(), feeTxid: $("resFeeTxid").value.trim() } : {}));
    $("ppSaveBtn").addEventListener("click", async () => {
      const btc = $("ppBtc").value.trim();
      const set = { lightningAddress: $("ppLightning").value.trim() || undefined, zcashAddress: $("ppZcash").value.trim() || undefined, zcashViewingKey: $("ppZivk").value.trim() || undefined };
      if (btc && !/^\(/.test(btc)) { if (/^[xyztuv]pub/i.test(btc)) set.btcXpub = btc; else set.btcAddress = btc; }
      const r = await directApi("payout-profile", { set });
      $("ppZivk").value = "";
      $("ppStatus").textContent = r.status === 200 ? "Saved." : "Could not save: " + (r.payload.error || r.status);
    });

`;
