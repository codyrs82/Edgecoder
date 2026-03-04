<script lang="ts">
  import { getGitHubStatus, getOAuthStartUrl, disconnectGitHub } from "../lib/api";
  import { open } from "@tauri-apps/plugin-shell";

  let loading = $state(true);
  let connected = $state(false);
  let login = $state<string | undefined>(undefined);
  let avatarUrl = $state<string | undefined>(undefined);
  let disconnecting = $state(false);

  async function fetchStatus() {
    loading = true;
    try {
      const status = await getGitHubStatus();
      connected = status.connected;
      login = status.login;
      avatarUrl = status.avatarUrl;
    } catch {
      connected = false;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    fetchStatus();
  });

  // Listen for refresh signals from deep-link handler
  $effect(() => {
    const handler = () => { fetchStatus(); };
    window.addEventListener("edgecoder:github-connected", handler);
    return () => window.removeEventListener("edgecoder:github-connected", handler);
  });

  async function handleConnect() {
    const url = getOAuthStartUrl("github");
    try {
      await open(url);
    } catch {
      // Fallback — browser may not open
    }
  }

  async function handleDisconnect() {
    disconnecting = true;
    try {
      await disconnectGitHub();
      connected = false;
      login = undefined;
      avatarUrl = undefined;
    } finally {
      disconnecting = false;
    }
  }
</script>

<div class="integrations">
  <h1>Integrations</h1>

  <div class="section">
    <h2>GitHub</h2>
    {#if loading}
      <p class="loading-text">Checking connection...</p>
    {:else if connected}
      <div class="github-connected">
        <div class="github-profile">
          {#if avatarUrl}
            <img class="avatar" src={avatarUrl} alt="GitHub avatar" />
          {/if}
          <span class="github-login">@{login ?? "unknown"}</span>
          <span class="badge connected">Connected</span>
        </div>
        <button class="btn-danger" onclick={handleDisconnect} disabled={disconnecting}>
          {disconnecting ? "Disconnecting..." : "Disconnect"}
        </button>
      </div>
    {:else}
      <p class="description">
        Connect your GitHub account to push, pull, create pull requests, and manage issues directly from the IDE agent.
      </p>
      <button class="btn-primary" onclick={handleConnect}>
        Connect GitHub
      </button>
    {/if}
  </div>
</div>

<style>
  .integrations {
    padding: 1.5rem;
    max-width: 640px;
  }
  h1 { margin: 0 0 1.5rem; font-size: 1.4rem; }
  .section {
    background: var(--bg-surface);
    border: 0.5px solid var(--border);
    padding: 1.2rem 1.4rem;
    border-radius: var(--radius-md);
    margin-bottom: 1.2rem;
  }
  .section h2 {
    font-size: 0.92rem;
    margin: 0 0 1rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  .loading-text { color: var(--text-muted); font-size: 0.85rem; }
  .description {
    color: var(--text-secondary);
    font-size: 0.85rem;
    margin: 0 0 1rem;
    line-height: 1.5;
  }
  .github-connected {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .github-profile {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
  }
  .github-login {
    font-size: 0.9rem;
    color: var(--text-primary);
    font-weight: 500;
  }
  .badge {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
  }
  .badge.connected {
    color: var(--green);
    background: rgba(74, 222, 128, 0.12);
  }
  .btn-primary {
    padding: 8px 20px;
    background: var(--accent);
    color: white;
    border: none;
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
  }
  .btn-primary:hover {
    background: var(--accent-hover);
  }
  .btn-danger {
    padding: 8px 20px;
    background: rgba(248, 113, 113, 0.1);
    color: var(--red);
    border: 1px solid rgba(248, 113, 113, 0.2);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    transition: all 0.15s;
  }
  .btn-danger:hover:not(:disabled) {
    background: rgba(248, 113, 113, 0.2);
  }
  .btn-danger:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
