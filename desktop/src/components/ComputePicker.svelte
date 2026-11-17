<script lang="ts">
  // #24/#26: the searchable model combobox, on bits-ui Popover + Command (the pair shadcn-svelte's
  // Combobox is made of). Typing filters; Up/Down move through every choice, Enter picks it,
  // Escape closes and returns focus to the trigger.
  import { Command, Popover } from "bits-ui";
  import { ChevronDown, Check, Laptop, Server, Globe, Lock, Search, Plus, Zap, KeyRound } from "@lucide/svelte";
  import { computeOverview, getFrontierStatus, getOllamaTags, listReservations, type ComputeOverview, type Reservation } from "../lib/api";
  import { classFamily } from "../lib/compute-availability";
  import { CLASS_LABELS, choiceId, choiceLabel, frontierName, parseChoice, shortModel } from "../lib/compute-choice";

  interface Props {
    selected: string | undefined;
    onSelect: (id: string | undefined) => void;
    /** Open a settings section (compute, plan, connect). */
    onOpenSettings?: (section: string) => void;
    /** Open upward (the picker sits at the bottom of the window). */
    up?: boolean;
    /**
     * Network only (a bot's "Network <class> only"): list just these network models (what the
     * class serves now) and no local, own, reserved or frontier rows; null/undefined: everything.
     */
    networkModels?: string[] | null;
    /** With networkModels: the class whose chips to offer ("gpu" means any GPU). */
    networkClass?: string;
  }
  let { selected, onSelect, onOpenSettings, up = true, networkModels: onlyModels = null, networkClass }: Props = $props();

  let open = $state(false);
  let loading = $state(false);
  let filter = $state("");
  let localModels = $state<string[]>([]);
  let overview = $state<ComputeOverview | null>(null);
  let leases = $state<Reservation[]>([]);
  /** Frontier models on your own key (only those your account has a key for here). */
  let frontierModels = $state<string[]>([]);
  const uid = $props.id();
  const listId = `${uid}-list`;
  let searchEl: HTMLInputElement | null = $state(null);
  let triggerEl: HTMLElement | null = $state(null);

  let label = $derived(choiceLabel(selected));
  let current = $derived(parseChoice(selected));

  const CLASSES = ["any", "cpu", "apple", "gpu", "gpu.dc"];
  const family = $derived(networkClass ? classFamily(networkClass) : null);
  /** The class chips a network model offers (only its own classes; under a class card only that family's). */
  const chipsFor = (classes: string[]) => (family ? ["any"] : CLASSES.filter((c) => c === "any" || classes.includes(c)));

  async function refresh() {
    loading = true;
    const [tags, ov, res, frontier] = await Promise.all([
      getOllamaTags().catch(() => ({ models: [] as Array<{ name: string }> })),
      computeOverview().catch(() => null),
      listReservations().catch(() => null),
      getFrontierStatus().catch(() => null),
    ]);
    frontierModels = frontier?.models ?? [];
    localModels = (tags.models ?? []).map((m) => m.name).filter((n) => !/embed/i.test(n));
    overview = ov;
    leases = (res?.reservations ?? []).filter((r) => r.status === "active");
    loading = false;
  }

  function onOpenChange(next: boolean) {
    if (!next) return;
    filter = "";
    void refresh();
  }

  function pick(id: string | undefined) {
    onSelect(id);
    open = false;
  }

  // The footer leaves for Settings. Focus goes back to the trigger first, so that is where
  // Settings returns it when it closes; the popover must not move it again afterwards.
  let leaving = false;
  function leaveFor(section: string) {
    leaving = true;
    open = false;
    triggerEl?.focus();
    onOpenSettings?.(section);
  }

  const match = (m: string) => !filter.trim() || m.toLowerCase().includes(filter.trim().toLowerCase());

  let myModels = $derived.by(() => {
    const counts = new Map<string, number>();
    // Your other machines: this computer's own models are listed above.
    if (onlyModels) return [];
    for (const m of overview?.account?.machines ?? []) if (m.online && m.agentId !== overview?.selfAgentId) for (const model of m.models) counts.set(model, (counts.get(model) ?? 0) + 1);
    return [...counts.entries()].map(([model, machines]) => ({ model, machines })).filter((x) => match(x.model));
  });
  // Restricted (security research) models run only on your own or reserved machines: never offered as network compute.
  let networkModels = $derived((overview?.models ?? []).filter((m) => !m.restricted && match(m.model) && (!onlyModels || onlyModels.includes(m.model))));
  let localMatches = $derived(onlyModels ? [] : localModels.filter(match));
  let leaseModels = $derived(
    (onlyModels ? [] : leases).flatMap((r) => (r.models.length ? r.models : r.model ? [r.model] : []).filter(match).map((model) => ({ r, model, id: choiceId({ where: "reserved", reservationId: r.id, model }) }))),
  );
  // While searching, the two Auto rows show only if they match, so Enter picks the first model found.
  let frontierMatches = $derived((onlyModels ? [] : frontierModels).filter((id) => match(id) || match(frontierName(id))));
  let showAuto = $derived(match("auto"));
  let nothing = $derived(!showAuto && !frontierMatches.length && !localMatches.length && !myModels.length && !leaseModels.length && !networkModels.length);
</script>

<Popover.Root bind:open {onOpenChange}>
  <Popover.Trigger bind:ref={triggerEl}>
    {#snippet child({ props })}
      <button {...props} class="trigger" title="Choose the model and where it runs ({label.model} · {label.where})">
        <span class="model">{label.model}</span>
        <span class="where">{label.where}</span>
        <ChevronDown size={12} />
      </button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content
      class="ui-popup compute-menu"
      role="dialog"
      aria-label="Model and compute"
      side={up ? "top" : "bottom"}
      align="start"
      sideOffset={6}
      collisionPadding={8}
      onOpenAutoFocus={(e) => { e.preventDefault(); searchEl?.focus(); }}
      onCloseAutoFocus={(e) => { if (leaving) e.preventDefault(); leaving = false; }}
    >
      <Command.Root class="compute-command" label="Search models" shouldFilter={false} loop>
        <div class="search">
          <Search size={13} />
          <Command.Input bind:ref={searchEl} bind:value={filter} placeholder="Search models">
            {#snippet child({ props })}
              <!-- bits-ui points aria-controls at its inner viewport; the listbox is what the field controls. -->
              <input {...props} aria-controls={listId} bind:value={filter} />
            {/snippet}
          </Command.Input>
        </div>
        <Command.List id={listId} class="scroll" aria-label="Compute">
          <Command.Viewport>
            {#if showAuto}
              <Command.Item class="ui-command-item row {current.where === 'anywhere' ? 'current' : ''}" value="auto-anywhere" onSelect={() => pick("auto")}>
                <Zap size={14} />
                <span class="name">Auto</span>
                <span class="meta">Your machines first (free), then the network's best fit: the coordinator picks the model and machine</span>
                {#if current.where === "anywhere"}{@render currentMark()}{/if}
              </Command.Item>
              <Command.Item class="ui-command-item row {current.where === 'auto' ? 'current' : ''}" value="auto-local" onSelect={() => pick(undefined)}>
                <Laptop size={14} />
                <span class="name">Auto</span>
                <span class="meta">This computer only · free</span>
                {#if current.where === "auto"}{@render currentMark()}{/if}
              </Command.Item>
            {/if}

            {#if frontierMatches.length}
              <Command.Group value="group-frontier">
                <Command.GroupHeading class="group"><KeyRound size={12} /> Lead on your key <span class="tag">billed by the provider</span></Command.GroupHeading>
                <Command.GroupItems>
                  {#each frontierMatches as id (id)}
                    <Command.Item class="ui-command-item row {selected === id ? 'current' : ''}" value={id} onSelect={() => pick(id)}>
                      <span class="name">Lead: {frontierName(id)} · your key</span>
                      <span class="meta">{id}</span>
                      {#if selected === id}{@render currentMark()}{/if}
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/if}

            {#if localMatches.length}
              <Command.Group value="group-local">
                <Command.GroupHeading class="group"><Laptop size={12} /> This computer <span class="tag">free</span></Command.GroupHeading>
                <Command.GroupItems>
                  {#each localMatches as m (m)}
                    <Command.Item class="ui-command-item row {selected === m ? 'current' : ''}" value={m} onSelect={() => pick(m)}>
                      <span class="name">{shortModel(m)}</span>
                      <span class="meta">{shortModel(m) !== m ? m : ""}</span>
                      {#if selected === m}{@render currentMark()}{/if}
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/if}

            {#if myModels.length}
              <Command.Group value="group-mine">
                <Command.GroupHeading class="group"><Server size={12} /> My machines <span class="tag">free</span></Command.GroupHeading>
                <Command.GroupItems>
                  {#each myModels as m (m.model)}
                    {@const id = choiceId({ where: "mine", model: m.model })}
                    <Command.Item class="ui-command-item row {selected === id ? 'current' : ''}" value={id} onSelect={() => pick(id)}>
                      <span class="name">{shortModel(m.model)}</span>
                      <span class="meta">{m.machines === 1 ? "on one of your machines" : `on ${m.machines} of your machines`}</span>
                      {#if selected === id}{@render currentMark()}{/if}
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/if}

            {#if leaseModels.length}
              <Command.Group value="group-reserved">
                <Command.GroupHeading class="group"><Lock size={12} /> Reserved</Command.GroupHeading>
                <Command.GroupItems>
                  {#each leaseModels as { r, model, id } (id)}
                    <Command.Item class="ui-command-item row {selected === id ? 'current' : ''}" value={id} onSelect={() => pick(id)}>
                      <span class="name">{shortModel(model)}</span>
                      <span class="meta">{CLASS_LABELS[r.computeClass] ?? r.computeClass} · until {new Date(r.endMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                      {#if selected === id}{@render currentMark()}{/if}
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/if}

            {#if networkModels.length}
              <div class="group" role="presentation"><Globe size={12} /> Network <span class="tag">cSats per million tokens</span></div>
              <!-- One group per model: its options are the machine classes it can run on. -->
              {#each networkModels as m (m.model)}
                <Command.Group class="net-row" value="group-network-{m.model}">
                  <Command.GroupHeading class="net-head">
                    <span class="name">{shortModel(m.model)}</span>
                    <span class="meta">{m.agents} machine{m.agents === 1 ? "" : "s"}{#if m.cSatsPerMTokens} · {m.cSatsPerMTokens.input} in / {m.cSatsPerMTokens.output} out{/if}</span>
                  </Command.GroupHeading>
                  <Command.GroupItems class="chips">
                    {#each chipsFor(m.classes) as cls (cls)}
                      {@const id = choiceId({ where: "network", model: m.model, computeClass: cls })}
                      <Command.Item
                        class="chip {selected === id ? 'current' : ''}"
                        value={id}
                        onSelect={() => pick(id)}
                        aria-label="{shortModel(m.model)}, {CLASS_LABELS[cls]}{selected === id ? ', current choice' : ''}"
                        title={cls === "any" ? "Any machine that has it (the fastest free one)" : `Only ${CLASS_LABELS[cls]} machines${m.agentsByClass?.[cls] ? ` (${m.agentsByClass[cls]} online)` : ""}; same price per token, different speed`}
                      >
                        {CLASS_LABELS[cls]}
                      </Command.Item>
                    {/each}
                  </Command.GroupItems>
                </Command.Group>
              {/each}
            {:else if !loading && overview && !overview.connected}
              <div class="note" role="presentation">Sign in and let the agent connect to use network compute.</div>
            {/if}
          </Command.Viewport>
        </Command.List>
        <!-- Outside the listbox, which may only hold options. -->
        {#if loading}<div class="note" role="status">Loading…</div>{:else if nothing}<div class="note" role="status">No models match "{filter}"</div>{/if}
      </Command.Root>
      {#if onOpenSettings}
        <div class="footer">
          <button onclick={() => leaveFor("compute")}><Plus size={13} /> Reserve</button>
          <button onclick={() => leaveFor("plan")}>Buy cSats</button>
          <button onclick={() => leaveFor("connect")}>Use in tools</button>
        </div>
      {/if}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>

{#snippet currentMark()}
  <Check size={14} /><span class="sr-only">, current choice</span>
{/snippet}

<style>
  /* A quiet chip: never louder than the message being typed. */
  .trigger {
    display: inline-flex; align-items: center; gap: 4px; height: var(--control-md); padding: 0 8px; border: none; border-radius: var(--radius-sm);
    background: transparent; color: var(--text-secondary); font: inherit; font-size: var(--fs-xs); line-height: 1; cursor: pointer; max-width: 280px; min-width: 0;
  }
  .trigger:hover, .trigger[aria-expanded="true"] { background: var(--bg-elevated); color: var(--text-primary); }
  .trigger .model { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .trigger .where { color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .trigger .where::before { content: "·"; margin-right: 4px; }

  /* The menu is portalled to <body> by bits-ui, outside this component's scope. */
  :global {
    .compute-menu {
      width: min(360px, calc(100vw - 16px)); max-height: min(460px, var(--bits-popover-content-available-height, 460px));
      display: flex; flex-direction: column; overflow: hidden;
    }
    .compute-menu .compute-command { display: flex; flex-direction: column; min-height: 0; flex: 1; }
    .compute-menu .search { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 0.5px solid var(--border); color: var(--text-secondary); }
    .compute-menu .search input { flex: 1; min-width: 0; border: none; background: transparent; color: var(--text-primary); font-size: 13px; outline: none; }
    .compute-menu .scroll { overflow-y: auto; padding: 6px; min-height: 0; }
    .compute-menu .group { display: flex; align-items: center; gap: 6px; padding: 10px 8px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); }
    .compute-menu .tag { margin-left: auto; text-transform: none; letter-spacing: 0; color: var(--text-muted); }
    .compute-menu .row { padding: 7px 8px; border-radius: var(--radius-md); }
    .compute-menu .row.current { background: color-mix(in srgb, var(--accent) 14%, transparent); }
    .compute-menu .row[data-selected] { background: var(--bg-surface); }
    .compute-menu .row .name { font-weight: 500; white-space: nowrap; }
    .compute-menu .row .meta { flex: 1; min-width: 0; color: var(--text-secondary); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .compute-menu .row svg { flex: none; }
    .compute-menu .net-row { padding: 6px 8px; border-radius: var(--radius-md); }
    .compute-menu .net-row:hover { background: var(--bg-surface); }
    .compute-menu .net-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; font-size: 13px; color: var(--text-primary); }
    .compute-menu .net-head .name { font-weight: 500; }
    .compute-menu .net-head .meta { color: var(--text-secondary); font-size: 12px; }
    .compute-menu .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
    .compute-menu .chip {
      display: inline-flex; gap: 4px; align-items: baseline; padding: 2px 8px; border-radius: 999px; border: 0.5px solid var(--border-control);
      background: transparent; color: var(--text-secondary); font-size: 11.5px; cursor: pointer; user-select: none;
    }
    .compute-menu .chip:hover, .compute-menu .chip[data-selected] { color: var(--text-primary); border-color: var(--text-secondary); }
    /* The keyboard highlight is a ring, so it still shows on the filled current chip. */
    .compute-menu .chip[data-selected] { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .compute-menu .chip.current { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
    .compute-menu .note { padding: 10px 14px; color: var(--text-secondary); font-size: 12px; }
    .compute-menu .footer { display: flex; gap: 4px; padding: 6px; border-top: 0.5px solid var(--border); }
    .compute-menu .footer button {
      flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 4px; padding: 6px; border: none; border-radius: var(--radius-md);
      background: none; color: var(--text-secondary); font-size: 12px; cursor: pointer;
    }
    .compute-menu .footer button:hover { background: var(--bg-surface); color: var(--text-primary); }
  }
</style>
