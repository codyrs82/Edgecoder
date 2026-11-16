<script lang="ts">
  // Settings → Getting started: where the guide stands for this account, and a way back into it.
  import { Check } from "@lucide/svelte";
  import * as O from "../lib/onboarding";
  import type { OnboardingState, OnboardingSignals } from "../lib/onboarding";
  import { getOnboarding, saveOnboarding } from "../lib/api";

  interface Props {
    /** Opens the guide (Settings closes). */
    onOpenGuide: () => void;
  }
  let { onOpenGuide }: Props = $props();

  let ob = $state<OnboardingState | null>(null);
  let signals = $state<OnboardingSignals | null>(null);
  let error = $state("");

  $effect(() => {
    getOnboarding()
      .then((r) => {
        ob = r.state ? O.normalizeOnboardingState(r.state, Date.now()) : O.emptyOnboardingState(Date.now());
        signals = r.signals;
      })
      .catch((err) => (error = (err as Error).message));
  });

  const progress = $derived(ob && signals ? O.progressFor(ob, { ...signals, localModels: null, cliInstalled: null }, "desktop") : null);

  async function startOver() {
    await saveOnboarding({ reset: true }).catch(() => undefined);
    onOpenGuide();
  }
</script>

<div class="sp">
  <h1>Getting started</h1>
  <p class="sp-lead">Set up your machines, models, funds and tools. Your progress is saved to your account, here and on the web.</p>
  {#if error}<p class="sp-err" role="alert">{error}</p>{/if}
  <section class="sp-group" aria-labelledby="gs-guide">
    <h2 class="sp-group-title" id="gs-guide">Guide</h2>
    <div class="sp-card">
      <div class="sp-row">
        <div class="sp-text">
          <span class="sp-title">{progress ? `${progress.completed} of ${progress.total} steps done` : "Loading…"}</span>
          <span class="sp-desc">{ob?.completedAtMs ? "Finished. Open it again any time." : ob?.dismissed ? "Closed. Open it to carry on where you left off." : "Carry on where you left off."}</span>
        </div>
        <div class="sp-controls">
          <button class="ghost" onclick={startOver}>Start over</button>
          <button class="primary" onclick={onOpenGuide}>Open the guide</button>
        </div>
      </div>
    </div>
  </section>
  {#if progress}
    <section class="sp-group" aria-labelledby="gs-steps">
      <h2 class="sp-group-title" id="gs-steps">Steps</h2>
      <div class="sp-card">
        {#each progress.steps as p (p.id)}
          <div class="sp-row">
            <span class="sp-dot" class:on={p.complete} aria-hidden="true"></span>
            <div class="sp-text"><span class="sp-title">{O.stepById(p.id).title}</span></div>
            <span class="sp-muted">{#if p.complete}<Check size={13} aria-hidden="true" /> Done{:else if p.skipped}Skipped{:else}Not yet{/if}</span>
          </div>
        {/each}
      </div>
    </section>
  {/if}
</div>
