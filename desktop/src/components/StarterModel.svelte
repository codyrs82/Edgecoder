<script lang="ts">
  // First run: download one small model automatically (see lib/starter-model.ts). A small card in
  // the corner shows progress; Skip stops it and doesn't ask again.
  import { onDestroy } from "svelte";
  import { STARTER_MODEL, installedChatModels, pullWithProgress, skipStarter, starterSkipped, type PullProgress } from "../lib/starter-model";

  interface Props {
    ollamaBase: string;
    /** Open the Models page. */
    onOpenModels?: () => void;
  }
  let { ollamaBase, onOpenModels }: Props = $props();

  let phase = $state<"idle" | "pulling" | "done" | "error">("idle");
  let progress = $state<PullProgress>({ status: "", percent: null });
  let error = $state("");
  let abort: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  async function check(): Promise<void> {
    if (stopped || starterSkipped()) return;
    const models = await installedChatModels(ollamaBase);
    if (models === null) {
      // Ollama is still being set up: look again shortly.
      timer = setTimeout(check, 5_000);
      return;
    }
    if (models.length > 0) return;
    phase = "pulling";
    abort = new AbortController();
    try {
      await pullWithProgress(ollamaBase, STARTER_MODEL, (p) => (progress = p), abort.signal);
      phase = "done";
      timer = setTimeout(() => (phase = "idle"), 8_000);
    } catch (e) {
      if (abort.signal.aborted) return;
      phase = "error";
      error = (e as Error).message;
    }
  }

  $effect(() => {
    void ollamaBase;
    timer = setTimeout(check, 1_500);
    return () => clearTimeout(timer);
  });
  onDestroy(() => {
    stopped = true;
    abort?.abort();
  });

  function skip() {
    skipStarter();
    abort?.abort();
    phase = "idle";
  }
</script>

{#if phase !== "idle"}
  <div class="starter" role="status" aria-live="polite">
    {#if phase === "pulling"}
      <div class="title">Downloading a starter model</div>
      <div class="desc">{STARTER_MODEL} (about 1 GB) so this computer can chat and take jobs right away.</div>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress.percent ?? 0} aria-label="Starter model download">
        <div class="fill" class:indeterminate={progress.percent === null} style="width: {progress.percent ?? 35}%"></div>
      </div>
      <div class="row">
        <span class="status">{progress.percent !== null ? `${progress.percent}%` : progress.status || "Starting…"}</span>
        <button class="link" onclick={skip}>Skip</button>
      </div>
    {:else if phase === "done"}
      <div class="title">Ready: {STARTER_MODEL} is installed</div>
      <div class="desc">For bigger jobs, add a larger model on the Models page.</div>
      {#if onOpenModels}<button class="link" onclick={() => { phase = "idle"; onOpenModels?.(); }}>Open Models</button>{/if}
    {:else}
      <div class="title">The starter model didn't download</div>
      <div class="desc">{error}</div>
      <div class="row">
        <button class="link" onclick={() => { phase = "idle"; void check(); }}>Try again</button>
        <button class="link" onclick={skip}>Skip</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .starter {
    position: fixed; right: 16px; bottom: 16px; z-index: 90; width: 320px; padding: 14px 16px;
    background: var(--bg-elevated, var(--bg-surface)); border: 0.5px solid var(--border); border-radius: 12px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
  }
  .title { font-size: 13px; font-weight: 600; color: var(--text-primary); }
  .desc { font-size: 12px; color: var(--text-secondary); margin-top: 3px; line-height: 1.45; }
  .bar { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; margin-top: 10px; }
  .fill { height: 100%; background: var(--accent); transition: width 0.3s; }
  .fill.indeterminate { animation: slide 1.4s ease-in-out infinite; }
  @keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }
  @media (prefers-reduced-motion: reduce) { .fill.indeterminate { animation: none; } }
  .row { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; }
  .status { font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
  .link { border: none; background: none; color: var(--text-secondary); font-size: 12px; cursor: pointer; padding: 2px 4px; }
  .link:hover { color: var(--text-primary); }
</style>
