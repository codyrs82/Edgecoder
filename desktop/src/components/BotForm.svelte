<script lang="ts">
  import "../styles/settings-page.css";
  import { focusTrap } from "../lib/focus-trap";
  import { createBot, updateBot, getBot, botErrorText } from "../lib/api";
  import ComputePicker from "./ComputePicker.svelte";
  import { BOT_TOOL_GROUPS, COMPUTE_POLICY_OPTIONS, DEFAULT_COMPUTE, SCHEDULE_PRESETS, botCompute, groupsOf, toolsFor, type Bot, type ComputePolicy } from "../lib/bots";

  interface Props {
    /** Edit this bot; omitted: create a new one. */
    bot?: Bot | null;
    /** Folder to start with for a new bot (the open project). */
    defaultProject?: string | null;
    onClose: () => void;
    onSaved: (bot: Bot) => void;
  }
  let { bot = null, defaultProject = null, onClose, onSaved }: Props = $props();

  // svelte-ignore state_referenced_locally
  const initial = bot;
  let name = $state(initial?.name ?? "");
  let role = $state(initial?.role ?? "");
  let instructions = $state(initial?.instructions ?? "");
  // svelte-ignore state_referenced_locally
  let projectRoot = $state(initial?.projectRoot ?? defaultProject ?? "");
  let schedule = $state(initial?.schedule ?? "");
  let customSchedule = $state(!!initial?.schedule && !SCHEDULE_PRESETS.some((p) => p.value === initial.schedule));
  let budgetText = $state(initial ? (initial.budgetCSatsPerDay == null ? "" : String(initial.budgetCSatsPerDay)) : "100");
  let groups = $state<Record<string, boolean>>(initial ? groupsOf(initial.allowedTools) : { edit: true, shell: true, git: true });
  let autoApproveEdits = $state(initial?.autoApproveEdits ?? true);
  const initialCompute = initial ? botCompute(initial) : DEFAULT_COMPUTE;
  let policy = $state<ComputePolicy>(initialCompute.policy);
  let computeModel = $state<string | undefined>(initialCompute.model);

  // The picker's own Auto rows map onto the matching policies.
  function pickModel(id: string | undefined) {
    if (id === "auto") policy = "auto";
    else if (id === undefined) policy = "local_only";
    else computeModel = id;
  }
  let memory = $state("");
  let saving = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    if (initial) getBot(initial.id).then((r) => (memory = r.memory)).catch(() => undefined);
  });

  async function chooseFolder() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, title: "Bot's project folder" });
      if (selected && typeof selected === "string") projectRoot = selected;
    } catch {
      // outside the desktop shell: type the path
    }
  }

  async function save(e: Event) {
    e.preventDefault();
    error = null;
    const budget = budgetText.trim() === "" ? null : Number(budgetText);
    if (budget !== null && !(budget > 0)) {
      error = "The budget must be a number above 0, or empty for no limit.";
      return;
    }
    if (policy === "model" && !computeModel) {
      error = "Pick the model this bot runs on, or choose another compute option.";
      return;
    }
    const input = {
      name: name.trim(),
      role: role.trim(),
      instructions,
      projectRoot: projectRoot.trim(),
      schedule: schedule.trim(),
      budgetCSatsPerDay: budget,
      allowedTools: toolsFor(groups),
      autoApproveEdits,
      compute: policy === "model" ? { policy, model: computeModel } : { policy },
    };
    saving = true;
    try {
      const saved = initial ? await updateBot(initial.id, { ...input, memory }) : await createBot(input);
      onSaved(saved);
    } catch (err) {
      error = botErrorText(err);
    } finally {
      saving = false;
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="bf-backdrop" onclick={onClose}></div>
<div class="bf-dialog" role="dialog" aria-modal="true" aria-label={initial ? `Edit ${initial.name}` : "New bot"} use:focusTrap={{ onEscape: onClose }}>
  <form class="sp" onsubmit={save}>
    <h1>{initial ? `Edit ${initial.name}` : "New bot"}</h1>
    <p class="sp-lead">A bot owns a job and keeps its own home folder. It runs on its schedule, when you press Run now, or when you message it, on the compute you choose below.</p>

    <div class="sp-group">
      <div class="sp-group-title">Who it is</div>
      <div class="sp-card">
        <label class="sp-row">
          <span class="sp-text"><span class="sp-title">Name</span></span>
          <input type="text" bind:value={name} placeholder="Harry" maxlength="60" required />
        </label>
        <label class="sp-row">
          <span class="sp-text"><span class="sp-title">Role</span><span class="sp-desc">Shown next to its name.</span></span>
          <input type="text" bind:value={role} placeholder="Engineer" maxlength="80" />
        </label>
        <label class="sp-row stack">
          <span class="sp-text"><span class="sp-title">Instructions</span><span class="sp-desc">Its job, added to the agent's instructions on every run.</span></span>
          <textarea bind:value={instructions} rows="5" maxlength="8000" placeholder="Keep the test suite green. Each run: run the tests, fix what fails, and tell me what you changed."></textarea>
        </label>
        {#if initial}
          <label class="sp-row stack">
            <span class="sp-text"><span class="sp-title">Memory</span><span class="sp-desc">Notes the bot saved for itself. Edit or clear them here.</span></span>
            <textarea bind:value={memory} rows="4" maxlength="8000"></textarea>
          </label>
        {/if}
      </div>
    </div>

    <div class="sp-group">
      <div class="sp-group-title">Where and when</div>
      <div class="sp-card">
        <div class="sp-row">
          <span class="sp-text"><span class="sp-title">Home folder</span><span class="sp-desc">Where it keeps its own files and notes. It reads and edits files only here.</span></span>
          <div class="sp-controls">
            <input type="text" class="bf-path" bind:value={projectRoot} placeholder="/Users/you/Agents/Harry" required aria-label="Home folder" />
            <button type="button" onclick={chooseFolder}>Choose…</button>
          </div>
        </div>
        <!-- Slot for the bot's repository (owner/repo, cloned into ~/EdgeCoder/<repo>): coming in a later change. -->
        <div class="sp-row bf-soon" aria-disabled="true" data-testid="bot-repository-slot">
          <span class="sp-text"><span class="sp-title">Repository <span class="sp-pill">Coming soon</span></span><span class="sp-desc">A GitHub repository (owner/repo) it works in, cloned for it automatically.</span></span>
          <input type="text" class="bf-path" placeholder="owner/repo" disabled aria-label="Repository (coming soon)" />
        </div>
        <div class="sp-row">
          <span class="sp-text"><span class="sp-title">Schedule</span><span class="sp-desc">"every 2 hours", "daily at 18:30" or cron ("0 9 * * 1-5").</span></span>
          <div class="sp-controls">
            {#if customSchedule}
              <input type="text" bind:value={schedule} placeholder="every 2 hours" aria-label="Schedule" />
            {:else}
              <select bind:value={schedule} aria-label="Schedule">
                {#each SCHEDULE_PRESETS as p (p.value)}<option value={p.value}>{p.label}</option>{/each}
              </select>
            {/if}
            <button type="button" class="ghost small" onclick={() => (customSchedule = !customSchedule)}>{customSchedule ? "Presets" : "Custom"}</button>
          </div>
        </div>
      </div>
    </div>

    <div class="sp-group">
      <div class="sp-group-title">Model and compute</div>
      <div class="sp-card">
        <div class="sp-row stack">
          <span class="sp-text"><span class="sp-title">Where it runs</span><span class="sp-desc">When the network can't be paid for, it uses the best model on this computer or your machines instead.</span></span>
          <div class="bf-policies" role="radiogroup" aria-label="Where it runs">
            {#each COMPUTE_POLICY_OPTIONS as o (o.value)}
              <label class="bf-policy" class:active={policy === o.value}>
                <input type="radio" name="bot-compute" value={o.value} bind:group={policy} />
                <span class="bf-policy-title">{o.title}</span>
                <span class="bf-policy-desc">{o.desc}</span>
              </label>
            {/each}
          </div>
        </div>
        {#if policy === "model"}
          <div class="sp-row">
            <span class="sp-text"><span class="sp-title">Model</span><span class="sp-desc">Every step runs on this model, wherever it is.</span></span>
            <div class="bf-picker">
              <ComputePicker selected={computeModel} onSelect={pickModel} up={false} />
            </div>
          </div>
        {/if}
        <label class="sp-row">
          <span class="sp-text"><span class="sp-title">Daily budget</span><span class="sp-desc">cSats a day for the network. A run stops when it's spent, and the network is never asked for more than what's left. Empty: no limit (your balance still caps it). This computer and your machines are free.</span></span>
          <input type="number" min="0" step="any" bind:value={budgetText} placeholder="No limit" class="bf-num" />
        </label>
      </div>
    </div>

    <div class="sp-group">
      <div class="sp-group-title">What it may do</div>
      <div class="sp-card">
        <div class="sp-row"><span class="sp-text"><span class="sp-title">Read the project</span><span class="sp-desc">Always on.</span></span></div>
        {#each BOT_TOOL_GROUPS as g (g.id)}
          <div class="sp-row">
            <span class="sp-text"><span class="sp-title">{g.title}</span><span class="sp-desc">{g.desc}</span></span>
            <button type="button" class="sp-switch" role="switch" aria-checked={groups[g.id]} aria-label={g.title} onclick={() => (groups = { ...groups, [g.id]: !groups[g.id] })}></button>
          </div>
        {/each}
        {#if groups.edit}
          <div class="sp-row">
            <span class="sp-text"><span class="sp-title">Apply edits without asking</span><span class="sp-desc">Each run keeps the originals, so you can review and undo.</span></span>
            <button type="button" class="sp-switch" role="switch" aria-checked={autoApproveEdits} aria-label="Apply edits without asking" onclick={() => (autoApproveEdits = !autoApproveEdits)}></button>
          </div>
        {/if}
      </div>
    </div>

    {#if error}<div class="sp-err" role="alert">{error}</div>{/if}
    <div class="bf-actions">
      <button type="button" class="ghost" onclick={onClose}>Cancel</button>
      <button type="submit" class="primary" disabled={saving || !name.trim() || !projectRoot.trim()}>{saving ? "Saving…" : initial ? "Save" : "Create bot"}</button>
    </div>
  </form>
</div>

<style>
  .bf-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 200;
  }
  .bf-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 201;
    width: min(680px, calc(100vw - 32px));
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    background: var(--bg-deep);
    border: 0.5px solid var(--border);
    border-radius: 14px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
  }
  .bf-dialog :global(.sp) {
    padding: 24px 24px 20px;
    max-width: none;
  }
  textarea {
    width: 100%;
    padding: 8px 10px;
    background: var(--bg-base);
    color: var(--text-primary);
    border: 0.5px solid var(--border-strong, var(--border));
    border-radius: 8px;
    font: inherit;
    font-size: 13px;
    resize: vertical;
  }
  textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  .bf-path {
    width: 260px;
  }
  .bf-num {
    width: 120px;
  }
  .bf-soon {
    opacity: 0.55;
  }
  .bf-policies {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 8px;
  }
  .bf-policy {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 10px 12px;
    border: 0.5px solid var(--border-strong, var(--border));
    border-radius: 10px;
    background: var(--bg-base);
    cursor: pointer;
  }
  .bf-policy:hover {
    border-color: var(--text-secondary);
  }
  .bf-policy.active {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, var(--bg-base));
  }
  .bf-policy:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .bf-policy input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .bf-policy-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .bf-policy-desc {
    font-size: 12px;
    line-height: 1.4;
    color: var(--text-secondary);
  }
  .bf-picker {
    border: 0.5px solid var(--border-strong, var(--border));
    border-radius: 8px;
    background: var(--bg-base);
  }
  .bf-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
