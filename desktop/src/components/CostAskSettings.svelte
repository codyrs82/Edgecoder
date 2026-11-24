<script lang="ts">
  // Settings → General → Reply cost (cost-check.ts): a reply on a paid model pauses and asks once it
  // has spent this much (Keep going · Switch to a cheaper model · Stop). Models on this computer and
  // your own machines are free and never ask.
  import { replyAskCSatsSetting, replyAskUsdSetting, setReplyAskCSats, setReplyAskUsd } from "../lib/cost-check";
  import { REPLY_ASK_CSATS_MAX, REPLY_ASK_CSATS_MIN, REPLY_ASK_USD_MAX, REPLY_ASK_USD_MIN } from "../lib/reply-cost";

  let cSats = $state(replyAskCSatsSetting());
  let usd = $state(replyAskUsdSetting());

  function saveCSats(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const n = Number(input.value);
    cSats = Number.isFinite(n) && n > 0 ? setReplyAskCSats(n) : replyAskCSatsSetting();
    input.value = String(cSats);
  }
  function saveUsd(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const n = Number(input.value);
    usd = Number.isFinite(n) && n > 0 ? setReplyAskUsd(n) : replyAskUsdSetting();
    input.value = usd.toFixed(2);
  }
</script>

<section class="sp-group" aria-labelledby="gen-reply-cost">
  <h2 class="sp-group-title" id="gen-reply-cost">Reply cost</h2>
  <div class="sp-card">
    <div class="sp-row">
      <div class="sp-text">
        <span class="sp-title">Ask before a reply spends more than … cSats</span>
        <span class="sp-desc">
          On a network or cloud model, a reply that has spent this much pauses and asks: keep going, switch to a cheaper model (the reply carries on there), or stop. It asks again after each further amount. Default 150.
        </span>
      </div>
      <div class="sp-controls">
        <input type="number" class="num" aria-label="Ask before a reply spends more than this many cSats" min={REPLY_ASK_CSATS_MIN} max={REPLY_ASK_CSATS_MAX} step="10" value={cSats} onchange={saveCSats} />
      </div>
    </div>
    <div class="sp-row">
      <div class="sp-text">
        <span class="sp-title">Ask before a reply spends more than … on your key</span>
        <span class="sp-desc">The same question for Claude or another model on your own key, in US dollars. Default $0.50.</span>
      </div>
      <div class="sp-controls">
        <input type="number" class="num" aria-label="Ask before a reply spends more than this many US dollars on your key" min={REPLY_ASK_USD_MIN} max={REPLY_ASK_USD_MAX} step="0.05" value={usd.toFixed(2)} onchange={saveUsd} />
      </div>
    </div>
  </div>
</section>

<style>
  .num { width: 96px; }
</style>
