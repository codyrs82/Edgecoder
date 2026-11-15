<script lang="ts">
  import GitHubSignIn from "../components/GitHubSignIn.svelte";
  import { getGitHubStatus, getOAuthStartUrl, disconnectGitHub } from "../lib/api";
  import { open } from "@tauri-apps/plugin-shell";
  import { githubCli, githubCliStatus } from "../lib/github-cli";

  // The GitHub CLI: what pushing, publishing and cloning private repositories use.
  let checkingCli = $state(false);
  async function checkCli(fresh = false) {
    checkingCli = true;
    try {
      await githubCliStatus(fresh);
    } finally {
      checkingCli = false;
    }
  }
  $effect(() => {
    void checkCli();
  });

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
    try {
      const url = await getOAuthStartUrl("github");
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

  <div class="section" data-testid="github-cli">
    <h2>GitHub for your projects</h2>
    {#if !$githubCli || (checkingCli && !$githubCli)}
      <p class="loading-text" role="status">Checking the GitHub CLI...</p>
    {:else if $githubCli.loggedIn}
      <div class="github-connected">
        <div class="github-profile">
          <span class="github-login">@{$githubCli.login ?? "unknown"}</span>
          <span class="badge connected">Signed in</span>
        </div>
        <button type="button" class="btn-secondary" onclick={() => void checkCli(true)} disabled={checkingCli}>{checkingCli ? "Checking..." : "Check again"}</button>
      </div>
      <p class="description cli-note">Projects clone, pull, push and publish to GitHub with this sign-in (the GitHub CLI, <code>gh</code>).</p>
    {:else}
      <p class="description">
        {#if $githubCli.ghInstalled}
          Cloning private repositories, pushing and publishing projects use the GitHub CLI. Sign in once in a terminal:
        {:else}
          Cloning private repositories, pushing and publishing projects use the GitHub CLI, which isn't installed. Install it, then sign in:
        {/if}
      </p>
      {#if $githubCli.ghInstalled}
        <GitHubSignIn onSignedIn={() => void checkCli(true)} />
        <p class="description cli-note">Or sign in in a terminal with <code>gh auth login</code>, then check again.</p>
      {:else}
        <pre class="cmd">brew install gh{"\n"}gh auth login</pre>
      {/if}
      <button type="button" class="btn-secondary" onclick={() => void checkCli(true)} disabled={checkingCli}>{checkingCli ? "Checking..." : "Check again"}</button>
    {/if}
  </div>

  <div class="section">
    <h2>GitHub for the agent</h2>
    {#if loading}
      <p class="loading-text" role="status">Checking connection...</p>
    {:else if connected}
      <div class="github-connected">
        <div class="github-profile">
          {#if avatarUrl}
            <img class="avatar" src={avatarUrl} alt="" referrerpolicy="no-referrer" />
          {/if}
          <span class="github-login">@{login ?? "unknown"}</span>
          <span class="badge connected">Connected</span>
        </div>
        <button type="button" class="btn-danger" onclick={handleDisconnect} disabled={disconnecting}>
          {disconnecting ? "Disconnecting..." : "Disconnect"}
        </button>
      </div>
    {:else}
      <p class="description">
        Connect your GitHub account to push, pull, create pull requests, and manage issues directly from the IDE agent.
      </p>
      <button type="button" class="btn-primary" onclick={handleConnect}>
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
  .cmd {
    margin: 0 0 1rem;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-primary);
    white-space: pre;
  }
  .cli-note { margin: 0.8rem 0 0; }
  .btn-secondary {
    height: var(--control-md);
    padding: 0 12px;
    border: 0.5px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--fs-sm);
    cursor: pointer;
  }
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
    border-radius: var(--radius-sm);
  }
  .badge.connected {
    color: var(--green);
    background: color-mix(in srgb, var(--green) 12%, transparent);
  }
  .btn-primary {
    padding: 8px 20px;
    background: var(--accent);
    color: var(--on-accent);
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
    background: color-mix(in srgb, var(--red) 10%, transparent);
    color: var(--red-strong);
    border: 1px solid color-mix(in srgb, var(--red) 20%, transparent);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    transition: all 0.15s;
  }
  .btn-danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--red) 15%, transparent);
  }
  .btn-danger:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
