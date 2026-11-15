<script lang="ts">
  // Sign in to GitHub from the app: the GitHub CLI's device flow run by the IDE provider. The code
  // shows here; the user enters it at github.com/login/device; the status is polled until gh is
  // signed in. The token stays in gh's keychain entry and never reaches the app.
  import { onDestroy } from "svelte";
  import { Github, ExternalLink, Copy } from "@lucide/svelte";
  import { githubLoginCancel, githubLoginStart, githubLoginStatus, type GitHubDeviceLogin } from "../lib/api";
  import { githubCliStatus } from "../lib/github-cli";

  interface Props {
    /** Called once gh is signed in. */
    onSignedIn?: (login: string | null) => void;
    compact?: boolean;
  }
  let { onSignedIn, compact = false }: Props = $props();

  let login = $state<GitHubDeviceLogin | null>(null);
  let error = $state<string | null>(null);
  let starting = $state(false);
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function openDevicePage(url: string) {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
    } catch {
      window.open(url, "_blank", "noopener");
    }
  }

  async function poll(id: string) {
    try {
      login = await githubLoginStatus(id);
    } catch (err) {
      error = (err as Error).message;
      return;
    }
    if (login.state === "waiting" || login.state === "starting") {
      timer = setTimeout(() => void poll(id), 2000);
      return;
    }
    if (login.state === "done") {
      await githubCliStatus(true);
      onSignedIn?.(login.login);
    } else if (login.state === "error") error = login.message ?? "GitHub sign-in didn't complete.";
  }

  async function start() {
    starting = true;
    error = null;
    try {
      login = await githubLoginStart();
      if (login.state === "error") error = login.message ?? "Couldn't start GitHub sign-in.";
      else {
        if (login.code) void navigator.clipboard?.writeText(login.code).then(() => (copied = true)).catch(() => undefined);
        void openDevicePage(login.url);
        timer = setTimeout(() => void poll(login!.id), 2000);
      }
    } catch (err) {
      error = (err as Error).message;
    } finally {
      starting = false;
    }
  }

  function cancel() {
    clearTimeout(timer);
    if (login) void githubLoginCancel(login.id).catch(() => undefined);
    login = null;
  }

  onDestroy(() => clearTimeout(timer));
</script>

<div class="gh-signin" class:compact>
  {#if login && login.state === "waiting" && login.code}
    <p class="hint">Enter this code at github.com/login/device{copied ? " (copied)" : ""}:</p>
    <div class="code-row">
      <code class="device-code" aria-label="One-time code">{login.code}</code>
      <button class="btn btn--sm" type="button" title="Copy the code" aria-label="Copy the code" onclick={() => void navigator.clipboard?.writeText(login?.code ?? "").then(() => (copied = true))}><Copy size={13} /></button>
    </div>
    <div class="actions">
      <button class="btn btn--sm btn--primary" type="button" onclick={() => void openDevicePage(login?.url ?? "https://github.com/login/device")}><ExternalLink size={13} /> Open github.com/login/device</button>
      <button class="btn btn--sm" type="button" onclick={cancel}>Cancel</button>
    </div>
    <p class="hint waiting" role="status">Waiting for GitHub…</p>
  {:else if login && login.state === "done"}
    <p class="hint" role="status">Signed in to GitHub{login.login ? ` as @${login.login}` : ""}.</p>
  {:else}
    <button class="btn btn--sm btn--primary" type="button" onclick={() => void start()} disabled={starting}><Github size={13} /> {starting ? "Starting…" : "Sign in with GitHub"}</button>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .gh-signin {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-start;
  }
  .hint {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--text-secondary);
  }
  .code-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .device-code {
    font-family: var(--font-mono);
    font-size: var(--fs-lg, 18px);
    letter-spacing: 0.08em;
    padding: 4px 10px;
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    user-select: all;
  }
  .actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .error {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--red);
  }
</style>
