<script lang="ts">
  // Settings → General → Long chats (compaction.ts): the token budget past which a chat on a model
  // paid per token summarizes its older messages. Models on this computer and your own machines are
  // free and only compact to fit their window.
  import { compactPaidTokensSetting, setCompactPaidTokens, COMPACT_MAX, COMPACT_MIN } from "../lib/compaction";

  let tokens = $state(compactPaidTokensSetting());

  function save(e: Event) {
    const n = Number((e.currentTarget as HTMLInputElement).value);
    tokens = Number.isFinite(n) && n > 0 ? setCompactPaidTokens(n) : compactPaidTokensSetting();
    (e.currentTarget as HTMLInputElement).value = String(tokens);
  }
</script>

<section class="sp-group" aria-labelledby="gen-compact">
  <h2 class="sp-group-title" id="gen-compact">Long chats</h2>
  <div class="sp-card">
    <div class="sp-row">
      <div class="sp-text">
        <span class="sp-title">Compact long chats at … tokens</span>
        <span class="sp-desc">
          With a paid model (your own Claude or other key, a network or cloud model), a chat whose history passes this size has its earlier messages summarized by a cheap model, so each reply stops resending the whole conversation. Default 80,000. Type <code>/compact</code> in a chat to do it now.
        </span>
      </div>
      <div class="sp-controls">
        <input type="number" class="num" aria-label="Compact long chats at this many tokens" min={COMPACT_MIN} max={COMPACT_MAX} step="1000" value={tokens} onchange={save} />
      </div>
    </div>
  </div>
</section>

<style>
  .num { width: 96px; }
</style>
