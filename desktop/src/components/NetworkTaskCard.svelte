<script lang="ts">
  import { onDestroy } from "svelte";
  import { networkTasks, type NetworkTask } from "../lib/api";

  interface Props {
    taskId: string;
  }
  let { taskId }: Props = $props();

  let task = $state<NetworkTask | null>(null);
  let gone = $state(false);
  let now = $state(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh() {
    now = Date.now();
    try {
      const t = (await networkTasks()).find((x) => x.id === taskId) ?? null;
      task = t;
      gone = !t;
      if (t && t.state !== "running") clearInterval(timer);
    } catch {
      // IDE server unreachable for a moment: keep the last state
    }
  }

  $effect(() => {
    void taskId;
    void refresh();
    clearInterval(timer);
    timer = setInterval(refresh, 3000);
  });
  onDestroy(() => clearInterval(timer));

  function secs(a: number, b: number) {
    return `${Math.max(0, Math.round((b - a) / 1000))}s`;
  }
</script>

<div class="card" data-state={task?.state ?? (gone ? "gone" : "loading")}>
  {#if gone}
    <div class="head">This network job's result is no longer available (the app restarted since).</div>
  {:else if !task}
    <div class="head">Sending to the network…</div>
  {:else if task.state === "running"}
    <div class="head"><span class="dot"></span> Running on the network · {secs(task.submittedAtMs, now)}</div>
    <div class="note">A machine on the network is writing and running code for this in its sandbox. You can keep working.</div>
  {:else}
    <div class="head">
      {task.state === "done" ? "Finished on the network" : task.state === "failed" ? "Failed on the network" : "No result after 15 minutes"}
      · {secs(task.submittedAtMs, task.finishedAtMs ?? now)}{#if task.creditsSpent} · {task.creditsSpent} credit{task.creditsSpent === 1 ? "" : "s"}{/if}
    </div>
    {#if task.output}<pre>{task.output}</pre>{/if}
    {#if task.error}<pre class="err">{task.error}</pre>{/if}
  {/if}
</div>

<style>
  .card {
    margin: 6px 0;
    border: 0.5px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    font-size: 12px;
    overflow: hidden;
  }
  .head {
    padding: 6px 10px;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .note {
    padding: 0 10px 8px;
    color: var(--text-muted);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    50% { opacity: 0.3; }
  }
  pre {
    margin: 0;
    padding: 8px 10px;
    border-top: 0.5px solid var(--border);
    background: var(--bg-base);
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    white-space: pre-wrap;
    max-height: 300px;
    overflow: auto;
  }
  pre.err {
    color: var(--danger, #f85149);
  }
</style>
