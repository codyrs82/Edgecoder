<script lang="ts">
  // First-run "Setting up local compute": the shell installs/starts Ollama and the Colima
  // Docker sandbox (src-tauri/src/local_compute.rs); this shows its progress, errors and Retry.
  import { open } from "@tauri-apps/plugin-shell";
  import {
    blockingErrors,
    componentLine,
    getLocalComputeStatus,
    needsManualOllama,
    progressPercent,
    startLocalComputeSetup,
    type ComponentStatus,
    type ComputeStatus,
  } from "../lib/local-compute";

  interface Props {
    status: ComputeStatus;
    onStatus: (s: ComputeStatus) => void;
    onDismiss: () => void;
  }
  let { status, onStatus, onDismiss }: Props = $props();

  let retrying = $state(false);

  const rows = $derived([
    { key: "ollama", name: "Ollama", purpose: "Runs AI models on this computer", c: status.ollama },
    { key: "docker", name: "Docker sandbox", purpose: "Keeps code from the network isolated", c: status.docker },
  ]);
  const errors = $derived(blockingErrors(status));
  const failed = $derived(status.state === "error");

  async function retry() {
    retrying = true;
    const s = (await startLocalComputeSetup()) ?? (await getLocalComputeStatus());
    if (s) onStatus(s);
    retrying = false;
  }

  function icon(c: ComponentStatus): string {
    if (c.state === "ready") return "✓";
    if (c.state === "error") return c.required ? "!" : "–";
    if (c.state === "skipped" || c.state === "pending") return "·";
    return "";
  }
</script>

<div class="setup-overlay" role="dialog" aria-modal="true" aria-labelledby="lc-title">
  <div class="setup-card">
    <h2 id="lc-title">Setting up local compute</h2>
    <p class="lead">
      {#if status.managed}
        EdgeCoder is installing what it needs to run models and sandboxed tasks on this Mac. This happens once; nothing to do in a terminal.
      {:else}
        EdgeCoder is checking for the local tools it uses to run models and sandboxed tasks.
      {/if}
    </p>

    <ul class="rows">
      {#each rows as row (row.key)}
        {@const pct = progressPercent(row.c)}
        {@const busy = !["ready", "error", "skipped", "pending"].includes(row.c.state)}
        <li class="row" data-state={row.c.state}>
          <span class="mark" aria-hidden="true">
            {#if busy}<span class="spinner"></span>{:else}{icon(row.c)}{/if}
          </span>
          <div class="body">
            <div class="name">{row.name} <span class="purpose">{row.purpose}</span></div>
            <div class="line" class:err={row.c.state === "error" && row.c.required}>{componentLine(row.c)}</div>
            {#if pct !== null}
              <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct} aria-label="{row.name} download">
                <div class="fill" style="width: {pct}%"></div>
              </div>
            {:else if busy && row.c.state !== "checking"}
              <div class="bar indeterminate" aria-hidden="true"><div class="fill"></div></div>
            {/if}
            {#if row.c.activity && row.c.state === "starting"}
              <div class="activity">{row.c.activity}</div>
            {/if}
          </div>
        </li>
      {/each}
    </ul>

    {#if failed && errors.length}
      <p class="hint">Setup stopped. Fix the problem above if there is one, then press Retry. Logs are in ~/.edgecoder.</p>
    {/if}

    <div class="setup-actions">
      {#if failed}
        <button class="btn-primary" onclick={retry} disabled={retrying}>{retrying ? "Retrying..." : "Retry"}</button>
        {#if needsManualOllama(status)}
          <button class="btn-secondary" onclick={() => open("https://ollama.com/download")}>Download Ollama</button>
        {/if}
      {/if}
      <button class="btn-link" onclick={onDismiss}>{failed ? "Continue without it" : "Hide (keeps going in the background)"}</button>
    </div>
  </div>
</div>

<style>
  .setup-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 200; padding: 16px; }
  .setup-card { background: var(--bg-surface, #1a1a2e); border: 1px solid var(--border-strong, #2d2d5f); border-radius: 10px; padding: 28px; width: 100%; max-width: 480px; }
  .setup-card h2 { margin: 0 0 8px; font-size: 1.2rem; color: var(--text-primary, #e2e8f0); }
  .lead { color: var(--text-secondary, #94a3b8); font-size: 0.9rem; margin: 0 0 20px; line-height: 1.5; }
  .rows { list-style: none; margin: 0 0 16px; padding: 0; display: flex; flex-direction: column; gap: 14px; }
  .row { display: flex; gap: 12px; align-items: flex-start; }
  .mark { width: 20px; height: 20px; flex: none; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; color: var(--text-muted, #64748b); }
  .row[data-state="ready"] .mark { color: var(--success, #22c55e); }
  .row[data-state="error"] .mark { color: var(--danger, #ef4444); }
  .body { flex: 1; min-width: 0; }
  .name { color: var(--text-primary, #e2e8f0); font-weight: 600; font-size: 0.92rem; }
  .purpose { color: var(--text-muted, #64748b); font-weight: 400; font-size: 0.8rem; margin-left: 6px; }
  .line { color: var(--text-secondary, #94a3b8); font-size: 0.85rem; margin-top: 2px; line-height: 1.4; overflow-wrap: anywhere; }
  .line.err { color: var(--danger, #ef4444); }
  .activity { color: var(--text-muted, #64748b); font-size: 0.75rem; margin-top: 4px; font-family: var(--font-mono, ui-monospace, monospace); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar { height: 6px; background: var(--border-strong, #2d2d5f); border-radius: 3px; overflow: hidden; margin-top: 6px; }
  .fill { height: 100%; background: var(--accent, #3b82f6); transition: width 0.3s; }
  .bar.indeterminate .fill { width: 35%; animation: slide 1.4s ease-in-out infinite; }
  @keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }
  .spinner { width: 14px; height: 14px; border: 2px solid var(--border-strong, #2d2d5f); border-top-color: var(--accent, #3b82f6); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner, .bar.indeterminate .fill { animation: none; } }
  .hint { color: var(--text-secondary, #94a3b8); font-size: 0.82rem; margin: 0 0 14px; line-height: 1.4; }
  .setup-actions { display: flex; flex-direction: column; gap: 10px; }
  .btn-primary { padding: 12px; background: var(--accent, #3b82f6); color: var(--on-accent, #fff); border: none; border-radius: 6px; font-weight: 600; font-size: 0.95rem; cursor: pointer; transition: opacity 0.15s; }
  .btn-primary:hover { opacity: 0.9; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-secondary { padding: 10px; background: var(--bg-surface, #1a1a2e); color: var(--text-primary, #e2e8f0); border: 1px solid var(--border-strong, #2d2d5f); border-radius: 6px; cursor: pointer; font-size: 0.9rem; }
  .btn-link { background: none; border: none; color: var(--text-muted, #64748b); font-size: 0.85rem; cursor: pointer; padding: 4px; }
  .btn-link:hover { color: var(--text-secondary, #94a3b8); }
</style>
