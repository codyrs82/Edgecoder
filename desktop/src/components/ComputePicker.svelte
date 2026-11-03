<script lang="ts">
  import { ChevronDown, Check, Laptop, Server, Globe, Lock, Search, Plus, Zap } from "@lucide/svelte";
  import { computeOverview, getOllamaTags, listReservations, type ComputeOverview, type Reservation } from "../lib/api";
  import { CLASS_LABELS, choiceId, choiceLabel, parseChoice, shortModel } from "../lib/compute-choice";

  interface Props {
    selected: string | undefined;
    onSelect: (id: string | undefined) => void;
    /** Open a settings section (compute, plan, connect). */
    onOpenSettings?: (section: string) => void;
    /** Open upward (the picker sits at the bottom of the window). */
    up?: boolean;
  }
  let { selected, onSelect, onOpenSettings, up = true }: Props = $props();

  let open = $state(false);
  let loading = $state(false);
  let filter = $state("");
  let localModels = $state<string[]>([]);
  let overview = $state<ComputeOverview | null>(null);
  let leases = $state<Reservation[]>([]);
  let searchEl: HTMLInputElement | undefined = $state();

  let label = $derived(choiceLabel(selected));
  let current = $derived(parseChoice(selected));

  const CLASSES = ["any", "cpu", "apple", "gpu", "gpu.dc"];

  async function refresh() {
    loading = true;
    const [tags, ov, res] = await Promise.all([
      getOllamaTags().catch(() => ({ models: [] as Array<{ name: string }> })),
      computeOverview().catch(() => null),
      listReservations().catch(() => null),
    ]);
    localModels = (tags.models ?? []).map((m) => m.name).filter((n) => !/embed/i.test(n));
    overview = ov;
    leases = (res?.reservations ?? []).filter((r) => r.status === "active");
    loading = false;
  }

  function toggle() {
    open = !open;
    if (open) {
      filter = "";
      void refresh();
      queueMicrotask(() => searchEl?.focus());
    }
  }

  function pick(id: string | undefined) {
    onSelect(id);
    open = false;
  }

  const match = (m: string) => !filter.trim() || m.toLowerCase().includes(filter.trim().toLowerCase());

  let myModels = $derived.by(() => {
    const counts = new Map<string, number>();
    // Your other machines: this computer's own models are listed above.
    for (const m of overview?.account?.machines ?? []) if (m.online && m.agentId !== overview?.selfAgentId) for (const model of m.models) counts.set(model, (counts.get(model) ?? 0) + 1);
    return [...counts.entries()].map(([model, machines]) => ({ model, machines })).filter((x) => match(x.model));
  });
  let networkModels = $derived((overview?.models ?? []).filter((m) => match(m.model)));
  let priceOf = (cls: string) => overview?.classes?.[cls]?.cSatsPerSecondBaseTier;

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      open = false;
      e.stopPropagation();
    }
  }
</script>

<div class="compute-picker" onkeydown={onKeydown} role="presentation">
  <button class="trigger" onclick={toggle} aria-haspopup="listbox" aria-expanded={open} title="Choose the model and where it runs">
    <span class="model">{label.model}</span>
    <span class="where">{label.where}</span>
    <ChevronDown size={12} strokeWidth={2.5} />
  </button>

  {#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
    <div class="backdrop" onclick={() => (open = false)}></div>
    <div class="menu" class:up role="listbox" aria-label="Compute">
      <div class="search">
        <Search size={13} />
        <input bind:this={searchEl} bind:value={filter} placeholder="Search models" aria-label="Search models" />
      </div>
      <div class="scroll">
        <button class="row" class:active={current.where === "anywhere"} onclick={() => pick("auto")}>
          <Zap size={14} />
          <span class="name">Auto</span>
          <span class="meta">Cheapest place that fits each request: yours first, GPUs for heavy work</span>
          {#if current.where === "anywhere"}<Check size={14} />{/if}
        </button>
        <button class="row" class:active={current.where === "auto"} onclick={() => pick(undefined)}>
          <Laptop size={14} />
          <span class="name">Auto</span>
          <span class="meta">This computer only · free</span>
          {#if current.where === "auto"}<Check size={14} />{/if}
        </button>

        {#if localModels.some(match)}
          <div class="group"><Laptop size={12} /> This computer <span class="tag">free</span></div>
          {#each localModels.filter(match) as m}
            {@const id = m}
            <button class="row" class:active={selected === id} onclick={() => pick(id)}>
              <span class="name">{shortModel(m)}</span>
              <span class="meta">{shortModel(m) !== m ? m : ""}</span>
              {#if selected === id}<Check size={14} />{/if}
            </button>
          {/each}
        {/if}

        {#if myModels.length}
          <div class="group"><Server size={12} /> My machines <span class="tag">free</span></div>
          {#each myModels as m}
            {@const id = choiceId({ where: "mine", model: m.model })}
            <button class="row" class:active={selected === id} onclick={() => pick(id)}>
              <span class="name">{shortModel(m.model)}</span>
              <span class="meta">{m.machines === 1 ? "on one of your machines" : `on ${m.machines} of your machines`}</span>
              {#if selected === id}<Check size={14} />{/if}
            </button>
          {/each}
        {/if}

        {#if leases.length}
          <div class="group"><Lock size={12} /> Reserved</div>
          {#each leases as r}
            {#each (r.models.length ? r.models : r.model ? [r.model] : []).filter(match) as model}
              {@const id = choiceId({ where: "reserved", reservationId: r.id, model })}
              <button class="row" class:active={selected === id} onclick={() => pick(id)}>
                <span class="name">{shortModel(model)}</span>
                <span class="meta">{CLASS_LABELS[r.computeClass] ?? r.computeClass} · until {new Date(r.endMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                {#if selected === id}<Check size={14} />{/if}
              </button>
            {/each}
          {/each}
        {/if}

        {#if networkModels.length}
          <div class="group"><Globe size={12} /> Network <span class="tag">cSats per second</span></div>
          {#each networkModels as m}
            <div class="net-row">
              <div class="net-head">
                <span class="name">{shortModel(m.model)}</span>
                <span class="meta">{m.agents} machine{m.agents === 1 ? "" : "s"}</span>
              </div>
              <div class="chips">
                {#each CLASSES.filter((c) => c === "any" || m.classes.includes(c)) as cls}
                  {@const id = choiceId({ where: "network", model: m.model, computeClass: cls })}
                  <button class="chip" class:active={selected === id} onclick={() => pick(id)} title={cls === "any" ? "Any machine that has it" : `${CLASS_LABELS[cls]}: ${priceOf(cls) ?? "?"} cSats/s on the base tier`}>
                    {CLASS_LABELS[cls]}{#if cls !== "any" && priceOf(cls) !== undefined}<span class="price">{priceOf(cls)}/s</span>{/if}
                  </button>
                {/each}
              </div>
            </div>
          {/each}
        {:else if !loading && overview && !overview.connected}
          <div class="note">Sign in and let the agent connect to use network compute.</div>
        {/if}

        {#if loading}<div class="note">Loading…</div>{/if}
      </div>
      {#if onOpenSettings}
        <div class="footer">
          <button onclick={() => { open = false; onOpenSettings?.("compute"); }}><Plus size={13} /> Reserve</button>
          <button onclick={() => { open = false; onOpenSettings?.("plan"); }}>Buy cSats</button>
          <button onclick={() => { open = false; onOpenSettings?.("connect"); }}>Use in tools</button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .compute-picker { position: relative; display: inline-flex; }
  .trigger {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border: none; border-radius: var(--radius-sm, 6px);
    background: transparent; color: var(--text-secondary); font-size: 12.5px; cursor: pointer; max-width: 320px;
  }
  .trigger:hover, .trigger[aria-expanded="true"] { background: var(--bg-surface); color: var(--text-primary); }
  .trigger .model { color: var(--text-primary); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .trigger .where { color: var(--text-muted, var(--text-secondary)); white-space: nowrap; }
  .backdrop { position: fixed; inset: 0; z-index: 40; }
  .menu {
    position: absolute; left: 0; top: calc(100% + 6px); z-index: 41; width: 360px; max-height: 460px; display: flex; flex-direction: column;
    background: var(--bg-elevated, var(--bg-surface)); border: 0.5px solid var(--border); border-radius: 12px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35); overflow: hidden;
  }
  .menu.up { top: auto; bottom: calc(100% + 6px); }
  .search { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 0.5px solid var(--border); color: var(--text-secondary); }
  .search input { flex: 1; border: none; background: transparent; color: var(--text-primary); font-size: 13px; outline: none; }
  .scroll { overflow-y: auto; padding: 6px; }
  .group { display: flex; align-items: center; gap: 6px; padding: 10px 8px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); }
  .tag { margin-left: auto; text-transform: none; letter-spacing: 0; color: var(--text-muted, var(--text-secondary)); }
  .row {
    display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border: none; border-radius: 8px; background: none;
    color: var(--text-primary); font-size: 13px; cursor: pointer; text-align: left;
  }
  .row:hover, .row:focus-visible { background: var(--bg-surface); outline: none; }
  .row.active { background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .row .name { font-weight: 500; white-space: nowrap; }
  .row .meta { flex: 1; color: var(--text-secondary); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .net-row { padding: 6px 8px; border-radius: 8px; }
  .net-row:hover { background: var(--bg-surface); }
  .net-head { display: flex; align-items: baseline; gap: 8px; font-size: 13px; color: var(--text-primary); }
  .net-head .name { font-weight: 500; }
  .net-head .meta { color: var(--text-secondary); font-size: 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
  .chip {
    display: inline-flex; gap: 4px; align-items: baseline; padding: 2px 8px; border-radius: 999px; border: 0.5px solid var(--border);
    background: transparent; color: var(--text-secondary); font-size: 11.5px; cursor: pointer;
  }
  .chip:hover { color: var(--text-primary); border-color: var(--text-secondary); }
  .chip.active { background: var(--accent); border-color: var(--accent); color: #111; }
  .chip .price { opacity: 0.75; font-variant-numeric: tabular-nums; }
  .note { padding: 10px 8px; color: var(--text-secondary); font-size: 12px; }
  .footer { display: flex; gap: 4px; padding: 6px; border-top: 0.5px solid var(--border); }
  .footer button {
    flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 4px; padding: 6px; border: none; border-radius: 8px;
    background: none; color: var(--text-secondary); font-size: 12px; cursor: pointer;
  }
  .footer button:hover { background: var(--bg-surface); color: var(--text-primary); }
</style>
