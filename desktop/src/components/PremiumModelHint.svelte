<script lang="ts">
  // One line under the composer when a premium paid model is picked for a chat in a project
  // (cost-check.ts premiumModelHint): "GLM-5.3 costs ~5× Flash for exploring; Flash or Claude (your
  // key) may fit better." Dismissible, and shown once per chat.
  import { X } from "@lucide/svelte";
  import { computeOverview, getFrontierStatus } from "../lib/api";
  import { markPremiumHintSeen, premiumHintSeen, premiumModelHint, type PricedModel } from "../lib/cost-check";

  interface Props {
    /** The compute picker's choice ("network/glm-5.3"). */
    choice: string | undefined;
    /** The chat's id: the hint shows once per chat. */
    chatId: string;
    /** Prices and frontier models (tests); fetched from the provider when not given. */
    load?: () => Promise<{ models: PricedModel[] | null; frontierModels: string[] }>;
  }
  let { choice, chatId, load }: Props = $props();

  let hint = $state<string | null>(null);
  let shownFor = $state<string | null>(null);
  let seq = 0;

  async function fetchPrices(): Promise<{ models: PricedModel[] | null; frontierModels: string[] }> {
    const [ov, fr] = await Promise.all([computeOverview().catch(() => null), getFrontierStatus().catch(() => null)]);
    return { models: ov?.models ?? null, frontierModels: fr?.models ?? [] };
  }

  $effect(() => {
    const c = choice;
    const id = chatId;
    const mine = ++seq;
    if (shownFor !== id) hint = null;
    if (!c?.startsWith("network/") || shownFor === id || premiumHintSeen(id)) return;
    void (load ?? fetchPrices)().then(({ models, frontierModels }) => {
      if (mine !== seq) return;
      const h = premiumModelHint(c, models, frontierModels);
      if (!h) return;
      hint = h;
      shownFor = id;
      // Once per chat: it stays until dismissed or the chat changes, and doesn't come back.
      markPremiumHintSeen(id);
    }).catch(() => {});
  });

  function dismiss() {
    hint = null;
  }
</script>

{#if hint && shownFor === chatId}
  <div class="premium-hint" role="note" data-testid="premium-hint">
    <span class="ph-text">{hint}</span>
    <button type="button" class="icon-btn icon-btn--sm" aria-label="Dismiss" title="Dismiss" onclick={dismiss}><X size={12} /></button>
  </div>
{/if}

<style>
  .premium-hint {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px 0;
    font-size: var(--fs-xs);
    color: var(--text-secondary);
  }
  .ph-text {
    flex: 1;
    min-width: 0;
  }
</style>
