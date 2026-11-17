<script lang="ts">
  import "../styles/settings-page.css";
  import Dialog from "./ui/Dialog.svelte";
  import Select from "./ui/Select.svelte";
  import { createBot, updateBot, getBot, botErrorText, computeOverview, type ComputeOverview } from "../lib/api";
  import { availabilityLine, classAvailability, modelsInClass, unavailableTitle, unavailableWarning, type ClassAvailability } from "../lib/compute-availability";
  import { RESTARTING_TEXT, localServiceRestarting } from "../lib/local-service";
  import ComputePicker from "./ComputePicker.svelte";
  import BotAvatar from "./BotAvatar.svelte";
  import { AVATAR_COLORS, AVATAR_SHAPES, AVATAR_SHAPE_LABELS, colorFromName, shapeFor, type AvatarShape } from "../lib/bot-avatar";
  import {
    BOT_TOOL_GROUPS, CI_SCOPE_OPTIONS, COMPUTE_POLICY_OPTIONS, DEFAULT_COMPUTE, DEFAULT_HEARTBEAT_MINUTES, DEFAULT_MAX_RUNS_PER_DAY, HEARTBEAT_OPTIONS, SCHEDULE_PRESETS, TRIGGER_KIND_OPTIONS, botCompute, computeChoiceOf, computeFromChoice, groupsOf, networkModelId, toolsFor,
    type Bot, type BotTriggerConfig, type ComputeChoice, type TriggerKind,
  } from "../lib/bots";

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
  let repository = $state(initial?.repository ?? "");
  /** Where its code commands (npm, git, tests) run: the repository's checkout, else nothing set (it works in the home folder). */
  const projectFolderText = $derived(
    repository.trim()
      ? initial?.repoPath && repository.trim() === (initial.repository ?? "")
        ? `Project folder: ${initial.repoPath}`
        : "Project folder: cloned when you save"
      : "Project folder: not set. Code commands (npm, git, tests) run in the home folder, which needs to be a code project for them to work.",
  );
  let triggers = $state<BotTriggerConfig[]>(initial?.triggers?.map((t) => ({ ...t })) ?? []);
  let maxRunsText = $state(String(initial?.maxTriggerRunsPerHour ?? 6));
  function addTrigger(kind: TriggerKind) {
    triggers = [...triggers, kind === "pr" ? { kind, enabled: true, onlyOthers: true } : kind === "ci_failed" ? { kind, enabled: true, scope: "any" } : { kind, enabled: true, label: "" }];
  }
  function setTrigger(i: number, patch: Partial<BotTriggerConfig>) {
    triggers = triggers.map((t, j) => (j === i ? { ...t, ...patch } : t));
  }
  function removeTrigger(i: number) {
    triggers = triggers.filter((_, j) => j !== i);
  }
  let schedule = $state(initial?.schedule ?? "");
  // Without a schedule it checks in on its own this often ("" = never).
  let heartbeat = $state(initial ? (initial.heartbeatMinutes === null ? "" : String(initial.heartbeatMinutes ?? DEFAULT_HEARTBEAT_MINUTES)) : String(DEFAULT_HEARTBEAT_MINUTES));
  const heartbeatOptions = $derived(HEARTBEAT_OPTIONS.some((o) => o.value === heartbeat) ? HEARTBEAT_OPTIONS : [{ value: heartbeat, label: `Every ${heartbeat} minutes` }, ...HEARTBEAT_OPTIONS]);
  let runsPerDayText = $state(String(initial?.maxRunsPerDay ?? DEFAULT_MAX_RUNS_PER_DAY));
  let customSchedule = $state(!!initial?.schedule && !SCHEDULE_PRESETS.some((p) => p.value === initial.schedule));
  let budgetText = $state(initial ? (initial.budgetCSatsPerDay == null ? "" : String(initial.budgetCSatsPerDay)) : "100");
  let groups = $state<Record<string, boolean>>(initial ? groupsOf(initial.allowedTools) : { edit: true, shell: true, git: true, web: true });
  let autoApproveEdits = $state(initial?.autoApproveEdits ?? true);
  const initialCompute = initial ? botCompute(initial) : DEFAULT_COMPUTE;
  let policy = $state<ComputeChoice>(computeChoiceOf(initialCompute));
  let computeModel = $state<string | undefined>(initialCompute.model);
  // Network only (any class or one): the Model selector is optional; empty means the network's best fit.
  let networkModel = $state<string | undefined>(initialCompute.policy === "network_only" ? initialCompute.model : undefined);
  const networkOnly = $derived(policy.startsWith("network_only"));

  // What the network has now, per class: each network card says it, an empty class can't be
  // picked, and the Model list under a per-class card lists only what that class serves.
  let overview = $state<ComputeOverview | null>(null);
  $effect(() => {
    computeOverview().then((ov) => (overview = ov)).catch(() => (overview = null));
  });
  const classOf = (choice: string): string | undefined => (choice.startsWith("network_only:") ? choice.split(":")[1] : undefined);
  /** A network card's availability (with the chosen model, when one is chosen); null for the other cards. */
  function availabilityOf(choice: string): ClassAvailability | null {
    if (!choice.startsWith("network_only")) return null;
    return classAvailability(overview, classOf(choice), networkModel);
  }
  const selectedAvailability = $derived(availabilityOf(policy));
  const pickerClasses = $derived(modelsInClass(overview, classOf(policy)));

  // The picker's own Auto rows map onto the matching policies.
  function pickModel(id: string | undefined) {
    if (id === "auto") policy = "auto";
    else if (id === undefined) policy = "local_only";
    else computeModel = id;
  }
  // Under Network only every pick is a network model; its Auto row means best fit.
  function pickNetworkModel(id: string | undefined) {
    networkModel = id === undefined ? undefined : networkModelId(id);
  }
  // The avatar: follows the name until you pick a color or shape.
  let pickedColor = $state<string | null>(initial?.color ?? null);
  let pickedShape = $state<AvatarShape | null>((initial?.avatarShape as AvatarShape | undefined) ?? null);
  const avatarColor = $derived(pickedColor ?? colorFromName(name || "bot"));
  const avatarShape = $derived<AvatarShape>(pickedShape ?? shapeFor({ name: name || "bot" }));
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
    const maxRuns = Number(maxRunsText);
    if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 60) {
      error = "Trigger runs an hour must be a whole number from 1 to 60.";
      return;
    }
    const runsPerDay = Number(runsPerDayText);
    if (!Number.isInteger(runsPerDay) || runsPerDay < 1 || runsPerDay > 500) {
      error = "Runs a day must be a whole number from 1 to 500.";
      return;
    }
    if (triggers.some((t) => t.kind === "issue_labeled" && !t.label?.trim())) {
      error = "Type the label the issue trigger watches for.";
      return;
    }
    if (triggers.length > 0 && !repository.trim()) {
      error = "GitHub triggers need a repository (owner/repo).";
      return;
    }
    const input = {
      name: name.trim(),
      role: role.trim(),
      instructions,
      projectRoot: projectRoot.trim(),
      repository: repository.trim(),
      triggers: triggers.map((t) => ({ ...t, label: t.label?.trim() || undefined })),
      maxTriggerRunsPerHour: maxRuns,
      schedule: schedule.trim(),
      heartbeatMinutes: heartbeat ? Number(heartbeat) : null,
      maxRunsPerDay: runsPerDay,
      budgetCSatsPerDay: budget,
      allowedTools: toolsFor(groups),
      autoApproveEdits,
      compute: computeFromChoice(policy, policy === "model" ? computeModel : networkOnly ? networkModel : undefined),
      color: avatarColor,
      avatarShape,
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

<Dialog labelledby="bf-title" width="680px" {onClose}>
  <form class="sp bf-form" onsubmit={save}>
    <h1 id="bf-title">{initial ? `Edit ${initial.name}` : "New bot"}</h1>
    <p class="sp-lead">A bot owns a job and keeps its own home folder. It works on its own: it starts when you save it, checks in on its project (or runs on its schedule), follows up on unfinished work, and answers your messages, on the compute you choose below. Pause it any time.</p>

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
        <div class="sp-row bf-look">
          <BotAvatar name={name || "Bot"} color={avatarColor} shape={avatarShape} size={56} />
          <div class="bf-look-controls">
            <div class="bf-swatches" role="radiogroup" aria-label="Color">
              {#each AVATAR_COLORS as c (c)}
                <button type="button" class="bf-swatch" role="radio" aria-checked={avatarColor === c} aria-label="Color {c}" style="background: {c}" onclick={() => (pickedColor = c)}></button>
              {/each}
            </div>
            <div class="bf-shapes" role="radiogroup" aria-label="Shape">
              {#each AVATAR_SHAPES as s (s)}
                <button type="button" class="bf-shape" role="radio" aria-checked={avatarShape === s} aria-label={AVATAR_SHAPE_LABELS[s]} title={AVATAR_SHAPE_LABELS[s]} onclick={() => (pickedShape = s)}>
                  <BotAvatar name={name || "Bot"} color={avatarColor} shape={s} size={30} decorative />
                </button>
              {/each}
            </div>
          </div>
        </div>
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
          <span class="sp-text"><span class="sp-title">Home folder</span><span class="sp-desc">Where it keeps its own notes and memory. Without a repository, it also works here.</span></span>
          <div class="sp-controls">
            <input type="text" class="bf-path" bind:value={projectRoot} placeholder="/Users/you/Agents/Harry" required aria-label="Home folder" />
            <button type="button" onclick={chooseFolder}>Choose…</button>
          </div>
        </div>
        <label class="sp-row" data-testid="bot-repository-slot">
          <span class="sp-text"><span class="sp-title">Repository</span><span class="sp-desc">A GitHub repository (owner/repo) it works in. Cloned into your projects folder when you save, and updated before each run.</span><span class="sp-desc bf-project" data-testid="bot-project-folder">{projectFolderText}</span></span>
          <input type="text" class="bf-path" bind:value={repository} placeholder="owner/repo" maxlength="500" spellcheck="false" autocomplete="off" aria-label="Repository" />
        </label>
        <div class="sp-row">
          <span class="sp-text"><span class="sp-title">Schedule</span><span class="sp-desc">"every 2 hours", "daily at 18:30" or cron ("0 9 * * 1-5").</span></span>
          <div class="sp-controls">
            {#if customSchedule}
              <input type="text" bind:value={schedule} placeholder="every 2 hours" aria-label="Schedule" />
            {:else}
              <Select bind:value={schedule} ariaLabel="Schedule" options={SCHEDULE_PRESETS} />
            {/if}
            <button type="button" class="ghost small" onclick={() => (customSchedule = !customSchedule)}>{customSchedule ? "Presets" : "Custom"}</button>
          </div>
        </div>
        {#if !schedule.trim()}
          <div class="sp-row">
            <span class="sp-text"><span class="sp-title">Check in</span><span class="sp-desc">How often it looks for work without a schedule. While nothing in the project changes it waits longer (up to 8 hours).</span></span>
            <Select bind:value={heartbeat} ariaLabel="Check in" options={heartbeatOptions} />
          </div>
        {/if}
        <label class="sp-row">
          <span class="sp-text"><span class="sp-title">Runs a day</span><span class="sp-desc">At most this many runs it starts on its own each day (your messages don't count).</span></span>
          <input type="number" min="1" max="500" step="1" bind:value={runsPerDayText} class="bf-num" />
        </label>
      </div>
    </div>

    <div class="sp-group" data-testid="bot-triggers">
      <div class="sp-group-title">Triggers</div>
      <div class="sp-card">
        <div class="sp-row stack">
          <span class="sp-text"><span class="sp-title">GitHub events</span><span class="sp-desc">Each one starts a run. Checked every 2 minutes while EdgeCoder is open, through your GitHub CLI login. Pausing the bot pauses them.</span></span>
        </div>
        {#each triggers as t, i (i)}
          <div class="sp-row bf-trigger">
            <div class="bf-trigger-fields">
              <Select value={t.kind} ariaLabel="Trigger {i + 1}" options={TRIGGER_KIND_OPTIONS} onChange={(kind) => {
                setTrigger(i, kind === "pr" ? { kind, onlyOthers: t.onlyOthers ?? true, scope: undefined } : kind === "ci_failed" ? { kind, scope: t.scope ?? "any", onlyOthers: undefined } : { kind, onlyOthers: undefined, scope: undefined });
              }} />
              {#if t.kind === "pr"}
                <label class="bf-check"><input type="checkbox" checked={t.onlyOthers !== false} onchange={(e) => setTrigger(i, { onlyOthers: (e.currentTarget as HTMLInputElement).checked })} /> Only PRs by others</label>
                <input type="text" class="bf-label" value={t.label ?? ""} placeholder="Any label" maxlength="100" aria-label="Only PRs with this label" oninput={(e) => setTrigger(i, { label: (e.currentTarget as HTMLInputElement).value })} />
              {:else if t.kind === "ci_failed"}
                <Select value={t.scope ?? "any"} ariaLabel="Where CI failed" options={CI_SCOPE_OPTIONS} onChange={(scope) => setTrigger(i, { scope })} />
              {:else}
                <input type="text" class="bf-label" value={t.label ?? ""} placeholder="Label, e.g. bug" maxlength="100" required aria-label="Issue label" oninput={(e) => setTrigger(i, { label: (e.currentTarget as HTMLInputElement).value })} />
              {/if}
            </div>
            <button type="button" class="sp-switch" role="switch" aria-checked={t.enabled} aria-label="Trigger {i + 1} on" onclick={() => setTrigger(i, { enabled: !t.enabled })}></button>
            <button type="button" class="ghost small" onclick={() => removeTrigger(i)} aria-label="Remove trigger {i + 1}">Remove</button>
          </div>
        {/each}
        <div class="sp-row">
          <span class="sp-text"><span class="sp-desc">{repository.trim() ? "Add a trigger:" : "Set a repository above to add triggers."}</span></span>
          <div class="sp-controls">
            {#each TRIGGER_KIND_OPTIONS as o (o.value)}
              <button type="button" class="small" disabled={!repository.trim() || triggers.length >= 10} onclick={() => addTrigger(o.value)}>+ {o.label}</button>
            {/each}
          </div>
        </div>
        <label class="sp-row">
          <span class="sp-text"><span class="sp-title">Trigger runs an hour</span><span class="sp-desc">At most this many runs from triggers each hour; more events are skipped and noted in the conversation.</span></span>
          <input type="number" min="1" max="60" step="1" bind:value={maxRunsText} class="bf-num" />
        </label>
      </div>
    </div>

    <div class="sp-group">
      <div class="sp-group-title">Model and compute</div>
      <div class="sp-card">
        <div class="sp-row stack">
          <span class="sp-text"><span class="sp-title">Where it runs</span><span class="sp-desc">{networkOnly ? "Network only never falls back to this computer or your machines: with no cSats left today it stops and says so." : "When the network can't be paid for, it uses the best model on this computer or your machines instead."}</span></span>
          <div class="bf-policies" role="radiogroup" aria-label="Where it runs">
            {#each COMPUTE_POLICY_OPTIONS as o (o.value)}
              {@const avail = availabilityOf(o.value)}
              {@const cls = classOf(o.value)}
              <!-- An empty class can't be picked; a saved choice stays selected (with a warning below). -->
              {@const off = avail?.state === "none" && policy !== o.value}
              <label class="bf-policy" class:active={policy === o.value} class:off aria-disabled={off ? "true" : undefined} title={off ? unavailableTitle(cls ?? "network", networkModel) : undefined}>
                <input type="radio" name="bot-compute" value={o.value} bind:group={policy} disabled={off} />
                <span class="bf-policy-title">{o.title}</span>
                <span class="bf-policy-desc">{o.desc}</span>
                {#if avail}
                  <span class="bf-policy-live" class:none={avail.state === "none"} data-testid="compute-availability">{availabilityLine(avail)}</span>
                {/if}
              </label>
            {/each}
          </div>
          {#if selectedAvailability?.state === "none"}
            <p class="bf-warn" role="alert" data-testid="compute-unavailable-warning">{classOf(policy) ? unavailableWarning(classOf(policy)!, networkModel) : `No machines online on the network${networkModel ? " with that model" : ""}: runs will fail until one is back. Choose another option.`}</p>
          {/if}
        </div>
        {#if policy === "model"}
          <div class="sp-row">
            <span class="sp-text"><span class="sp-title">Model</span><span class="sp-desc">Every step runs on this model, wherever it is.</span></span>
            <div class="bf-picker">
              <ComputePicker selected={computeModel} onSelect={pickModel} up={false} />
            </div>
          </div>
        {:else if networkOnly}
          <div class="sp-row">
            <span class="sp-text"><span class="sp-title">Model</span><span class="sp-desc">{networkModel ? "Every step runs on this model, on the network." : "Best fit: the network picks the model for each step."}</span></span>
            <div class="bf-picker">
              <ComputePicker selected={networkModel ?? "auto"} onSelect={pickNetworkModel} up={false} networkModels={pickerClasses} networkClass={classOf(policy)} />
              {#if networkModel}<button type="button" class="small" onclick={() => (networkModel = undefined)}>Use best fit</button>{/if}
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
            <button type="button" class="sp-switch" role="switch" aria-checked={groups[g.id] === true} aria-label={g.title} onclick={() => (groups = { ...groups, [g.id]: !groups[g.id] })}></button>
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

    {#if saving && $localServiceRestarting}<div class="sp-desc" role="status">{RESTARTING_TEXT}</div>{/if}
    {#if error}<div class="sp-err" role="alert">{error}</div>{/if}
    <div class="bf-actions">
      <button type="button" class="ghost" onclick={onClose}>Cancel</button>
      <button type="submit" class="primary" disabled={saving || !name.trim() || !projectRoot.trim()}>{saving ? "Saving…" : initial ? "Save" : "Create bot"}</button>
    </div>
  </form>
</Dialog>

<style>
  /* The dialog shell clips; the form is what scrolls. */
  .bf-form {
    padding: 24px 24px 20px;
    max-width: none;
    overflow-y: auto;
    background: var(--bg-deep);
  }
  textarea {
    width: 100%;
    padding: 8px 10px;
    background: var(--bg-base);
    color: var(--text-primary);
    border: 0.5px solid var(--border-strong);
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
  .bf-look {
    gap: 16px;
  }
  .bf-look-controls {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .bf-swatches,
  .bf-shapes {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .bf-swatches .bf-swatch {
    width: 22px;
    height: 22px;
    padding: 0;
    border-radius: 50%;
    border: 2px solid transparent;
    box-shadow: inset 0 0 0 1px var(--border-strong);
  }
  .bf-swatches .bf-swatch[aria-checked="true"] {
    border-color: var(--text-primary);
  }
  .bf-shapes .bf-shape {
    display: inline-flex;
    padding: 4px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--bg-base);
  }
  .bf-shapes .bf-shape[aria-checked="true"] {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, var(--bg-base));
  }
  .bf-swatch:focus-visible,
  .bf-shape:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .bf-trigger {
    gap: 10px;
  }
  .bf-trigger-fields {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .bf-label {
    width: 150px;
  }
  .bf-check {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12.5px;
    color: var(--text-secondary);
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
    border: 0.5px solid var(--border-strong);
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
  .bf-policy.off {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .bf-policy.off:hover {
    border-color: var(--border-strong);
  }
  .bf-policy-live {
    font-size: 11.5px;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .bf-policy-live.none {
    color: var(--yellow);
  }
  .bf-warn {
    margin: 8px 0 0;
    font-size: 12px;
    color: var(--yellow);
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
    border: 0.5px solid var(--border-strong);
    border-radius: 8px;
    background: var(--bg-base);
  }
  .bf-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
