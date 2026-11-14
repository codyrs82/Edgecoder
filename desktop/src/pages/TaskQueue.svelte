<script lang="ts">
  import { getStatus, submitTask, backendReady, isRemoteMode } from "../lib/api";
  import type { TaskSubmission } from "../lib/types";
  import StatCard from "../components/StatCard.svelte";
  import ErrorBanner from "../components/ErrorBanner.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import Select from "../components/ui/Select.svelte";

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

  let noLocalAgent = $state(false);

  // ── polling ─────────────────────────────────────────────────────────
  async function refresh() {
    await backendReady;
    if (isRemoteMode()) {
      noLocalAgent = true;
      loading = false;
      return;
    }
    noLocalAgent = false;
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

  {#if noLocalAgent}
    <div class="info-banner" role="status">No local agent running. Install and start the EdgeCoder agent to view the task queue.</div>
  {:else if error}
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
      <StatCard label="Queued"        value={queued}  color="var(--yellow)" />
      <StatCard label="Active Agents" value={agents}  color="var(--green)" />
      <StatCard label="Completed"     value={results} color="var(--accent-secondary)" />
      <StatCard label="Results / min" value={resultsPerMin().toFixed(1)} color="var(--accent)" />
    </div>
  {/if}

  <!-- submit toggle -->
  <button type="button" class="toggle-btn" aria-expanded={showSubmitForm} aria-controls="task-submit-form" onclick={() => (showSubmitForm = !showSubmitForm)}>
    {showSubmitForm ? "Hide Submit Form" : "Submit New Task"}
  </button>

  <!-- submit form -->
  {#if showSubmitForm}
    <form id="task-submit-form" class="submit-form" aria-label="Submit a task" aria-busy={submitting} onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>

      {#if submitSuccess}
        <div class="msg success" role="status">{submitSuccess}</div>
      {/if}
      {#if submitError}
        <div class="msg error" role="alert">{submitError}</div>
      {/if}

      <label class="field">
        <span class="field-label">Prompt <span class="req" aria-hidden="true">*</span></span>
        <textarea rows="4" bind:value={prompt} placeholder="Describe the code-completion task..." required></textarea>
      </label>

      <div class="row-2col">
        <div class="field">
          <span class="field-label" id="tq-language">Language</span>
          <Select bind:value={language} labelledby="tq-language" options={[{ value: "python", label: "Python" }, { value: "javascript", label: "JavaScript" }]} />
        </div>

        <label class="field">
          <span class="field-label">Snapshot Ref</span>
          <input type="text" bind:value={snapshotRef} placeholder="local" />
        </label>
      </div>

      <div class="row-2col">
        <div class="field">
          <span class="field-label" id="tq-resource">Resource Class</span>
          <Select bind:value={resourceClass} labelledby="tq-resource" options={[{ value: "cpu", label: "CPU" }, { value: "gpu", label: "GPU" }]} />
        </div>

        <label class="field">
          <span class="field-label">Priority: {priority}</span>
          <input type="range" min="0" max="100" bind:value={priority} aria-valuetext="Priority {priority} of 100" />
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
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  /* ── toggle button ────────────────────────────────────────── */
  .toggle-btn {
    background: var(--bg-surface);
    color: var(--accent);
    border: 1px solid var(--accent);
    padding: 0.5rem 1.2rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 0.9rem;
    margin-bottom: 1rem;
    transition: background 0.15s;
  }
  .toggle-btn:hover {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
  }

  /* ── submit form ──────────────────────────────────────────── */
  .submit-form {
    background: var(--bg-surface);
    padding: 1.25rem;
    border-radius: var(--radius-md);
    margin-bottom: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .row-2col {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .field-label {
    font-size: 0.85rem;
    color: var(--text-secondary);
  }

  .req {
    color: var(--red);
  }

  textarea,
  input[type="text"] {
    background: var(--bg-input);
    color: var(--text-primary);
    border: 1px solid var(--border-control);
    border-radius: var(--radius-sm);
    padding: 0.55rem 0.7rem;
    font-size: 0.9rem;
    font-family: inherit;
    resize: vertical;
    transition: border-color 0.15s;
  }
  textarea:focus,
  input[type="text"]:focus {
    outline: none;
    border-color: var(--accent);
  }

  input[type="range"] {
    accent-color: var(--accent);
    width: 100%;
    margin-top: 0.25rem;
  }

  .submit-btn {
    align-self: flex-start;
    background: var(--accent);
    color: var(--on-accent);
    border: none;
    padding: 0.55rem 1.5rem;
    border-radius: var(--radius-sm);
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
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
  }
  .msg.success {
    background: color-mix(in srgb, var(--green) 12%, transparent);
    color: var(--green);
    border: 1px solid color-mix(in srgb, var(--green) 25%, transparent);
  }
  .msg.error {
    background: color-mix(in srgb, var(--red) 12%, transparent);
    color: var(--red-strong);
    border: 1px solid color-mix(in srgb, var(--red) 25%, transparent);
  }

  /* ── empty state ──────────────────────────────────────────── */
  .empty {
    background: var(--bg-surface);
    padding: 1.2rem;
    border-radius: var(--radius-md);
    margin-top: 1rem;
    color: var(--text-secondary);
  }
  .empty p {
    margin: 0;
  }
  .info-banner { display: flex; align-items: center; background: color-mix(in srgb, var(--accent-secondary) 10%, transparent); color: var(--accent-secondary); padding: 0.75rem 1rem; border-radius: var(--radius-md); margin-bottom: 1rem; font-size: 0.9rem; }

  button:focus-visible, input:focus-visible, textarea:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
