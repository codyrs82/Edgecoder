<script lang="ts">
  import { getStatus, submitTask } from "../lib/api";
  import type { TaskSubmission } from "../lib/types";
  import StatCard from "../components/StatCard.svelte";
  import ErrorBanner from "../components/ErrorBanner.svelte";
  import Skeleton from "../components/Skeleton.svelte";

  interface Props {
    /** unused – page component receives no props today */
  }
  let {}: Props = $props();

  // ── poll state ──────────────────────────────────────────────────────
  let queued   = $state(0);
  let agents   = $state(0);
  let results  = $state(0);
  let loading  = $state(true);
  let error    = $state("");

  // ── results-per-minute tracking ─────────────────────────────────────
  let resultSnapshots: { ts: number; value: number }[] = $state([]);
  let resultsPerMin = $derived(() => {
    const now = Date.now();
    const windowMs = 60_000;
    const recent = resultSnapshots.filter((s) => now - s.ts <= windowMs);
    if (recent.length < 2) return 0;
    const oldest = recent[0];
    const newest = recent[recent.length - 1];
    const elapsed = (newest.ts - oldest.ts) / 1000; // seconds
    if (elapsed === 0) return 0;
    return ((newest.value - oldest.value) / elapsed) * 60;
  });

  // ── polling ─────────────────────────────────────────────────────────
  async function refresh() {
    try {
      const data = await getStatus();
      queued  = data.queued;
      agents  = data.agents;
      results = data.results;
      error   = "";

      // push snapshot for throughput calc, keep last 60 s
      const now = Date.now();
      resultSnapshots = [
        ...resultSnapshots.filter((s) => now - s.ts <= 60_000),
        { ts: now, value: data.results },
      ];
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load queue status";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    refresh();
    const interval = setInterval(refresh, 5_000);
    return () => clearInterval(interval);
  });

  // ── submit form state ───────────────────────────────────────────────
  let showSubmitForm = $state(false);
  let prompt        = $state("");
  let language      = $state<"python" | "javascript">("python");
  let snapshotRef   = $state("local");
  let resourceClass = $state<"cpu" | "gpu">("cpu");
  let priority      = $state(50);

  let submitting     = $state(false);
  let submitError    = $state("");
  let submitSuccess  = $state("");

  async function handleSubmit() {
    submitError   = "";
    submitSuccess = "";

    if (!prompt.trim()) {
      submitError = "Prompt is required.";
      return;
    }

    submitting = true;
    try {
      const taskId = crypto.randomUUID();
      const task: TaskSubmission = {
        taskId,
        prompt: prompt.trim(),
        language,
        snapshotRef,
        resourceClass,
        priority,
      };
      await submitTask(task);
      submitSuccess = `Task submitted: ${taskId}`;

      // reset form
      prompt        = "";
      language      = "python";
      snapshotRef   = "local";
      resourceClass = "cpu";
      priority      = 50;

      // refresh stats immediately
      refresh();
    } catch (e) {
      submitError = e instanceof Error ? e.message : "Submission failed";
    } finally {
      submitting = false;
    }
  }
</script>

<div class="task-queue">
  <h1>Task Queue</h1>

  {#if error}
    <ErrorBanner message={error} onRetry={refresh} />
  {/if}

  <!-- stats row -->
  {#if loading}
    <div class="stats-grid">
      {#each Array(4) as _}
        <Skeleton lines={2} height="1.4rem" />
      {/each}
    </div>
  {:else}
    <div class="stats-grid">
      <StatCard label="Queued"        value={queued}  color="var(--yellow, #facc15)" />
      <StatCard label="Active Agents" value={agents}  color="var(--green, #4ade80)" />
      <StatCard label="Completed"     value={results} color="var(--blue, #60a5fa)" />
      <StatCard label="Results / min" value={resultsPerMin().toFixed(1)} color="var(--accent, #3b82f6)" />
    </div>
  {/if}

  <!-- submit toggle -->
  <button class="toggle-btn" onclick={() => (showSubmitForm = !showSubmitForm)}>
    {showSubmitForm ? "Hide Submit Form" : "Submit New Task"}
  </button>

  <!-- submit form -->
  {#if showSubmitForm}
    <form class="submit-form" onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>

      {#if submitSuccess}
        <div class="msg success">{submitSuccess}</div>
      {/if}
      {#if submitError}
        <div class="msg error">{submitError}</div>
      {/if}

      <label class="field">
        <span class="field-label">Prompt <span class="req">*</span></span>
        <textarea rows="4" bind:value={prompt} placeholder="Describe the code-completion task..." required></textarea>
      </label>

      <div class="row-2col">
        <label class="field">
          <span class="field-label">Language</span>
          <select bind:value={language}>
            <option value="python">Python</option>
            <option value="javascript">JavaScript</option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">Snapshot Ref</span>
          <input type="text" bind:value={snapshotRef} placeholder="local" />
        </label>
      </div>

      <div class="row-2col">
        <label class="field">
          <span class="field-label">Resource Class</span>
          <select bind:value={resourceClass}>
            <option value="cpu">CPU</option>
            <option value="gpu">GPU</option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">Priority: {priority}</span>
          <input type="range" min="0" max="100" bind:value={priority} />
        </label>
      </div>

      <button class="submit-btn" type="submit" disabled={submitting}>
        {submitting ? "Submitting..." : "Submit Task"}
      </button>
    </form>
  {/if}

  <!-- empty state -->
  {#if !loading && queued === 0 && !showSubmitForm}
    <div class="empty">
      <p>No tasks in queue. Use the form above to submit a new task, or tasks will appear here when submitted through the portal or API.</p>
    </div>
  {/if}
</div>

<style>
  .task-queue {
    padding: 1.5rem;
  }

  h1 {
    margin: 0 0 1.25rem;
    font-size: 1.4rem;
    font-weight: 600;
  }

  /* ── stats grid ───────────────────────────────────────────── */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  /* ── toggle button ────────────────────────────────────────── */
  .toggle-btn {
    background: var(--bg-card, #1a1a2e);
    color: var(--accent, #3b82f6);
    border: 1px solid var(--accent, #3b82f6);
    padding: 0.5rem 1.2rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9rem;
    margin-bottom: 1rem;
    transition: background 0.15s;
  }
  .toggle-btn:hover {
    background: rgba(59, 130, 246, 0.15);
  }

  /* ── submit form ──────────────────────────────────────────── */
  .submit-form {
    background: var(--bg-card, #1a1a2e);
    padding: 1.25rem;
    border-radius: 8px;
    margin-bottom: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .row-2col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .field-label {
    font-size: 0.85rem;
    opacity: 0.8;
  }

  .req {
    color: #f87171;
  }

  textarea,
  input[type="text"],
  select {
    background: var(--bg-input, #0f0f23);
    color: var(--fg, #e2e8f0);
    border: 1px solid var(--border, #2d2d5f);
    border-radius: 6px;
    padding: 0.55rem 0.7rem;
    font-size: 0.9rem;
    font-family: inherit;
    resize: vertical;
    transition: border-color 0.15s;
  }
  textarea:focus,
  input[type="text"]:focus,
  select:focus {
    outline: none;
    border-color: var(--accent, #3b82f6);
  }

  input[type="range"] {
    accent-color: var(--accent, #3b82f6);
    width: 100%;
    margin-top: 0.25rem;
  }

  .submit-btn {
    align-self: flex-start;
    background: var(--accent, #3b82f6);
    color: #fff;
    border: none;
    padding: 0.55rem 1.5rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 500;
    transition: opacity 0.15s;
  }
  .submit-btn:hover:not(:disabled) {
    opacity: 0.85;
  }
  .submit-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ── inline messages ──────────────────────────────────────── */
  .msg {
    padding: 0.6rem 0.85rem;
    border-radius: 6px;
    font-size: 0.85rem;
  }
  .msg.success {
    background: rgba(74, 222, 128, 0.12);
    color: #4ade80;
    border: 1px solid rgba(74, 222, 128, 0.25);
  }
  .msg.error {
    background: rgba(248, 113, 113, 0.12);
    color: #f87171;
    border: 1px solid rgba(248, 113, 113, 0.25);
  }

  /* ── empty state ──────────────────────────────────────────── */
  .empty {
    background: var(--bg-card, #1a1a2e);
    padding: 1.2rem;
    border-radius: 8px;
    opacity: 0.7;
    margin-top: 1rem;
  }
  .empty p {
    margin: 0;
  }
</style>
