<script lang="ts">
  // In place of a network-dependent page's data while offline (lib/connectivity.ts): no error.
  import { UNAVAILABLE_OFFLINE_TEXT } from "../lib/connectivity";
  let { detail = "" }: { detail?: string } = $props();
</script>

<div class="sp-card" data-testid="offline-placeholder">
  <div class="sp-row"><div class="sp-text"><span class="sp-title">{UNAVAILABLE_OFFLINE_TEXT}</span>{#if detail}<span class="sp-desc">{detail}</span>{/if}</div></div>
</div>
