<script lang="ts">
  import { onUpdateStatus, downloadAndInstall, type UpdateStatus } from "../lib/updater";

  let status: UpdateStatus = $state({ state: "idle" });
  let dismissed = $state(false);

  $effect(() => {
    return onUpdateStatus((s) => {
      status = s;
      // Un-dismiss when a new update becomes available
      if (s.state === "available") dismissed = false;
    });
  });

  function handleUpdate() {
    downloadAndInstall();
  }

  function handleDismiss() {
    dismissed = true;
  }

  let visible = $derived(
    !dismissed && (status.state === "available" || status.state === "downloading" || status.state === "installing")
  );

  let version = $derived(status.state === "available" ? status.update.version : "");
  let progressPct = $derived(status.state === "downloading" ? status.progress : 0);
</script>

{#if visible}
  <div class="update-banner">
    {#if status.state === "available"}
      <span class="update-text">EdgeCoder v{version} is available.</span>
      <button class="update-btn" onclick={handleUpdate}>Update Now</button>
      <button class="dismiss-btn" onclick={handleDismiss} title="Dismiss">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
      </button>
    {:else if status.state === "downloading"}
      <span class="update-text">Downloading update... {progressPct}%</span>
      <div class="progress-bar">
        <div class="progress-fill" style="width: {progressPct}%"></div>
      </div>
    {:else if status.state === "installing"}
      <span class="update-text">Installing update... Restarting shortly.</span>
    {/if}
  </div>
{/if}

<style>
  .update-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 16px;
    background: rgba(74, 144, 217, 0.12);
    border-bottom: 1px solid rgba(74, 144, 217, 0.25);
    font-size: 0.82rem;
    flex-shrink: 0;
  }

  .update-text {
    color: var(--text-primary);
    flex: 1;
  }

  .update-btn {
    padding: 3px 12px;
    background: var(--accent-secondary, #4a90d9);
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .update-btn:hover {
    opacity: 0.9;
  }

  .dismiss-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 2px;
    display: flex;
    align-items: center;
  }

  .dismiss-btn:hover {
    color: var(--text-primary);
  }

  .progress-bar {
    width: 120px;
    height: 4px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--accent-secondary, #4a90d9);
    transition: width 0.3s ease;
  }
</style>
