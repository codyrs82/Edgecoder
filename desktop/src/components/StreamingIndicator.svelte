<script lang="ts">
  import type { StreamProgress } from "../lib/api";

  interface Props {
    progress?: StreamProgress;
  }
  let { progress }: Props = $props();

  const verbs = [
    "Thinking",
    "Pondering",
    "Crafting",
    "Computing",
    "Reasoning",
    "Weaving",
    "Assembling",
    "Conjuring",
    "Brewing",
    "Forging",
  ];

  const verb = verbs[Math.floor(Math.random() * verbs.length)];

  function formatElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  function routeIcon(route?: string): string {
    switch (route) {
      case "ollama-local": return "⚡";
      case "bluetooth-local": return "📡";
      case "swarm": return "🌐";
      case "edgecoder-local": return "💤";
      default: return "⚡";
    }
  }
</script>

<div class="progress-line">
  <span class="dot"></span>
  <span class="verb">{verb}…</span>
  {#if progress}
    <span class="meta">
      ({formatElapsed(progress.elapsedMs)}{#if progress.tokenCount > 0}{" · ↑ "}{progress.tokenCount} tokens{/if}{#if progress.routeInfo}{" · "}{routeIcon(progress.routeInfo.route)} {progress.routeInfo.label}{#if progress.routeInfo.model && progress.routeInfo.route === "ollama-local"}{" · "}{progress.routeInfo.model}{/if}{/if})
    </span>
  {/if}
</div>

<style>
  .progress-line {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-muted);
    padding: 4px 0 2px;
    font-family: var(--font-mono, monospace);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.2s ease-in-out infinite;
    flex-shrink: 0;
  }
  .verb {
    color: var(--text-secondary);
    font-weight: 500;
  }
  .meta {
    color: var(--text-muted);
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.3; transform: scale(0.8); }
  }
</style>
