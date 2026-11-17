<script lang="ts">
  // "Set up Harry's folder": a bot made on the web arrives here without a folder and doesn't run
  // until someone at this machine picks one (#409). The web's folder is only a suggestion, and an
  // Auto mode asked for on the web is only turned on when it's confirmed here. The provider enforces
  // both (BotManager.setupFolder is reached only from this app).
  import { untrack } from "svelte";
  import { FolderOpen, FolderPlus, Folder } from "@lucide/svelte";
  import { setupBotFolder, botErrorText } from "../lib/api";
  import { defaultBotFolder, type Bot } from "../lib/bots";

  interface Props {
    bot: Bot;
    onDone?: (bot: Bot) => void;
  }
  let { bot, onDone }: Props = $props();

  let busy = $state(false);
  let error = $state<string | null>(null);
  let existing = $state(false);
  // Pre-filled with the web's suggestion, which is used only if you press "Use this folder".
  let path = $state(untrack(() => bot.setup?.suggestedFolder ?? ""));
  let allowAuto = $state(false);
  const autoRequested = $derived(bot.setup?.requestedMode === "auto");
  const defaultPath = $derived(defaultBotFolder(bot.name));

  async function submit(body: { choice: "default" } | { choice: "path"; path: string }) {
    busy = true;
    error = null;
    try {
      const updated = await setupBotFolder(bot.id, { ...body, ...(autoRequested && allowAuto ? { allowAuto: true } : {}) });
      onDone?.(updated);
    } catch (e) {
      error = botErrorText(e);
    } finally {
      busy = false;
    }
  }

  async function pick(title: string): Promise<string | null> {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, title });
      return selected && typeof selected === "string" ? selected : null;
    } catch {
      // outside the desktop shell: type the path under "Use an existing folder"
      existing = true;
      return null;
    }
  }

  async function chooseFolder() {
    const p = await pick(`${bot.name}'s folder`);
    if (p) await submit({ choice: "path", path: p });
  }
  async function browse() {
    const p = await pick(`An existing folder for ${bot.name}`);
    if (p) path = p;
  }
  function useExisting(e: Event) {
    e.preventDefault();
    if (!path.trim()) {
      error = "Type or browse to a folder.";
      return;
    }
    void submit({ choice: "path", path: path.trim() });
  }
</script>

<section class="folder-setup" aria-labelledby="folder-setup-title" data-testid="bot-folder-setup">
  <div class="fs-head">
    <Folder size={16} />
    <h3 id="folder-setup-title">Set up {bot.name}'s folder</h3>
  </div>
  <p class="fs-lead">
    {bot.name} was made on the web. It keeps its notes and files in a folder on this machine, and doesn't run until you choose one.
    {#if bot.repository}Then {bot.repository} is cloned into your projects folder.{/if}
  </p>
  {#if bot.setup?.suggestedFolder}
    <p class="fs-note" data-testid="folder-suggestion">Suggested on the web: <code>{bot.setup.suggestedFolder}</code>. It's only used if you pick it below.</p>
  {/if}
  {#if autoRequested}
    <label class="fs-auto">
      <input type="checkbox" bind:checked={allowAuto} data-testid="confirm-auto" />
      <span>Use Auto, as asked on the web: {bot.name} runs commands without asking. Unchecked, it asks first (Accept edits).</span>
    </label>
  {/if}
  <div class="fs-actions">
    <button type="button" class="primary" onclick={chooseFolder} disabled={busy}><FolderOpen size={14} /> Choose folder…</button>
    <button type="button" onclick={() => submit({ choice: "default" })} disabled={busy} title={`Makes ${defaultPath}`}><FolderPlus size={14} /> Use default <span class="fs-path">{defaultPath}</span></button>
    <button type="button" class="ghost" onclick={() => (existing = !existing)} aria-expanded={existing} disabled={busy}>Use an existing folder</button>
  </div>
  {#if existing}
    <form class="fs-existing" onsubmit={useExisting}>
      <label for="fs-path" class="visually-hidden">Existing folder</label>
      <input id="fs-path" type="text" bind:value={path} placeholder="/Users/you/Projects/site" autocomplete="off" />
      <button type="button" class="ghost" onclick={browse} disabled={busy}>Browse…</button>
      <button type="submit" disabled={busy}>Use this folder</button>
    </form>
  {/if}
  {#if error}<div class="fs-error" role="alert">{error}</div>{/if}
</section>

<style>
  .folder-setup {
    margin: 12px 16px 0;
    padding: 14px 16px;
    border: 1px solid var(--yellow);
    border-radius: 10px;
    background: var(--bg-elevated);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .fs-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .fs-head h3 {
    margin: 0;
    font-size: 14px;
  }
  .fs-lead,
  .fs-note {
    margin: 0;
    font-size: 12.5px;
    color: var(--text-secondary);
    line-height: 1.5;
  }
  .fs-note code {
    font-size: 12px;
    word-break: break-all;
  }
  .fs-auto {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    font-size: 12.5px;
  }
  .fs-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .fs-actions button,
  .fs-existing button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .fs-path {
    opacity: 0.7;
    font-size: 11.5px;
  }
  .fs-existing {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .fs-existing input {
    flex: 1;
    min-width: 200px;
  }
  .fs-error {
    color: var(--danger);
    font-size: 12.5px;
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
