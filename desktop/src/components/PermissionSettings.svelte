<script lang="ts">
  // Settings → General → Permissions: the mode new chats and sessions start in, and the commands
  // answered "Always allow" per project (kept by this computer's IDE server in
  // ~/.edgecoder/permissions.json, never in the project itself, so a cloned repository can't
  // allow anything on its own). Removing one makes that command ask again.
  import { onMount } from "svelte";
  import Select from "./ui/Select.svelte";
  import Dialog from "./ui/Dialog.svelte";
  import { listPermissions, removePermission, type ProjectPermissionsView } from "../lib/api";
  import {
    confirmFullAccess, defaultMode, FULL_ACCESS_DEFAULT_SCOPE, FULL_ACCESS_WARNING, fullAccessConfirmed, MODE_OPTIONS, setDefaultMode, type EngineMode,
  } from "../lib/permission-modes";
  import { projectName, tildePath } from "../lib/projects";

  let mode = $state<EngineMode>(defaultMode());
  /** Full access as the default waits for its one-time confirm. */
  let confirmingFull = $state(false);

  function pickDefault(v: EngineMode) {
    if (v === "full" && !fullAccessConfirmed(FULL_ACCESS_DEFAULT_SCOPE)) {
      // Shown as picked while the confirm is open; Cancel puts the saved default back.
      confirmingFull = true;
      return;
    }
    mode = v;
    setDefaultMode(v);
  }

  function cancelFullDefault() {
    confirmingFull = false;
    mode = defaultMode();
  }

  function confirmFullDefault() {
    confirmFullAccess(FULL_ACCESS_DEFAULT_SCOPE);
    confirmingFull = false;
    mode = "full";
    setDefaultMode("full");
  }
  let projects = $state<Record<string, ProjectPermissionsView> | null>(null);
  let error = $state<string | null>(null);

  async function refresh() {
    try {
      projects = await listPermissions();
      error = null;
    } catch (err) {
      projects = null;
      error = (err as Error).message || "Couldn't read them from the IDE server.";
    }
  }
  onMount(() => void refresh());

  async function remove(root: string, rule: string) {
    try {
      await removePermission(root, rule);
    } catch (err) {
      error = (err as Error).message;
    }
    await refresh();
  }

  /** Each project's entries as rows: rules, older command names (as `name:*`) and the edits answer. */
  const rows = $derived(
    Object.entries(projects ?? {})
      .map(([root, p]) => ({
        root,
        entries: [
          ...(p.rules ?? []).map((r) => ({ key: r, label: r })),
          ...(p.shell ?? []).map((n) => ({ key: n, label: `${n}:*` })),
          ...(p.edits ? [{ key: "edits", label: "File edits (new sessions start in Accept edits)" }] : []),
        ],
      }))
      .filter((r) => r.entries.length > 0)
      .sort((a, b) => a.root.localeCompare(b.root)),
  );
</script>

{#if confirmingFull}
  <Dialog label="Make Full access the default?" width="440px" onClose={cancelFullDefault}>
    <div class="full-confirm">
      <h2>Make Full access the default?</h2>
      <p>New chats and sessions would start in Full access. {FULL_ACCESS_WARNING}</p>
      <p class="muted">Bits keep their own mode, and the phone, the web and other accounts never get Full access.</p>
      <div class="actions">
        <button type="button" class="btn" onclick={cancelFullDefault}>Cancel</button>
        <button type="button" class="btn btn--primary" onclick={confirmFullDefault}>Make it the default</button>
      </div>
    </div>
  </Dialog>
{/if}

<section class="sp-group" aria-labelledby="gen-permissions">
  <h2 class="sp-group-title" id="gen-permissions">Permissions</h2>
  <div class="sp-card">
    <div class="sp-row">
      <div class="sp-text">
        <span class="sp-title">Default mode for new chats</span>
        <span class="sp-desc">{MODE_OPTIONS.find((o) => o.engine === mode)?.desc} Each chat, session and bit keeps its own; change it with the picker under the message box.</span>
      </div>
      <div class="sp-controls">
        <Select
          ariaLabel="Default permission mode"
          bind:value={mode}
          onChange={pickDefault}
          options={MODE_OPTIONS.map((o) => ({ value: o.engine, label: o.title }))}
        />
      </div>
    </div>
    <div class="sp-row stack">
      <div class="sp-text">
        <span class="sp-title">Always-allowed commands</span>
        <span class="sp-desc">
          Commands you answered "Always allow" run without asking in that project. A rule such as <code>npm test:*</code> covers that command with any arguments,
          never with other commands chained on, and never covers what must always ask (network other than <code>git pull</code> / <code>git fetch</code>, pushes, deletes, paths outside the project) or what Auto refuses.
        </span>
      </div>
      {#if error}
        <span class="sp-desc sp-err" role="status">{error}</span>
      {:else if projects === null}
        <span class="sp-desc">Loading…</span>
      {:else if rows.length === 0}
        <span class="sp-desc" data-testid="no-rules">None yet.</span>
      {:else}
        <ul class="rules" aria-label="Always-allowed commands">
          {#each rows as r (r.root)}
            <li class="project">
              <span class="project-name" title={tildePath(r.root)}>{projectName(r.root)} <span class="path">{tildePath(r.root)}</span></span>
              <ul>
                {#each r.entries as e (e.key)}
                  <li class="rule">
                    <code>{e.label}</code>
                    <button type="button" class="link" aria-label="Remove {e.label} from {projectName(r.root)}" onclick={() => void remove(r.root, e.key)}>Remove</button>
                  </li>
                {/each}
              </ul>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
</section>

<style>
  .full-confirm { display: flex; flex-direction: column; gap: 10px; padding: 18px; }
  .full-confirm h2 { margin: 0; font-size: 15px; color: var(--warn); }
  .full-confirm p { margin: 0; font-size: 13px; line-height: 1.45; color: var(--text-primary); }
  .full-confirm .muted { color: var(--text-secondary); font-size: 12px; }
  .full-confirm .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
  .rules, .rules ul { list-style: none; margin: 0; padding: 0; }
  .project { padding: 6px 0; border-top: 0.5px solid var(--border); }
  .project:first-child { border-top: none; }
  .project-name { display: block; font-size: 13px; font-weight: 500; color: var(--text-primary); margin-bottom: 4px; }
  .path { font-weight: 400; color: var(--text-muted); font-size: 12px; margin-left: 6px; }
  .rule { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 0; }
  .rule code { font-size: 12px; overflow-wrap: anywhere; }
  .link { background: none; border: none; padding: 2px 4px; color: var(--accent); font: inherit; font-size: 12px; cursor: pointer; }
  .link:hover { text-decoration: underline; }
</style>
