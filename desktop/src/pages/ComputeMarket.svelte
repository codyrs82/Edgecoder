<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { open as openUrl } from "@tauri-apps/plugin-shell";
  import {
    computeOverview,
    listReservations,
    createReservation,
    cancelReservation,
    computeErrorText,
    portalWebUrl,
    type ComputeOverview,
    type ReservationOptions,
  } from "../lib/api";
  import { CLASS_LABELS, choiceId, computeChoice, shortModel } from "../lib/compute-choice";

  interface Props {
    /** Jump to another settings section (e.g. connect, plan). */
    onNavigate?: (section: string) => void;
  }
  let { onNavigate }: Props = $props();

  let overview = $state<ComputeOverview | null>(null);
  let res = $state<ReservationOptions | null>(null);
  let error = $state("");
  let notice = $state("");
  let loading = $state(true);
  let now = $state(Date.now());

  // Reserve form
  let cls = $state("gpu");
  let minutes = $state(60);
  let model = $state("");
  let reserving = $state(false);
  let classPicked = false;

  const CLASSES = ["cpu", "apple", "gpu", "gpu.dc"];
  const DURATIONS = [15, 30, 60, 120, 240, 480];

  async function load() {
    try {
      [overview, res] = await Promise.all([computeOverview(), listReservations().catch(() => null)]);
      // Open on a class that has a machine free.
      if (res && !classPicked && !res.options[cls]?.available) {
        const free = CLASSES.find((c) => res!.options[c]?.available);
        if (free) cls = free;
      }
      error = "";
    } catch (e) {
      error = computeErrorText(e);
    } finally {
      loading = false;
    }
  }
  let tick: ReturnType<typeof setInterval> | undefined;
  let refresher: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    void load();
    tick = setInterval(() => (now = Date.now()), 1000);
    refresher = setInterval(load, 30_000);
  });
  onDestroy(() => {
    clearInterval(tick);
    clearInterval(refresher);
  });

  let option = $derived(res?.options?.[cls]);
  let rate = $derived(option?.cSatsPerSecond ?? overview?.classes?.[cls]?.cSatsPerSecondBaseTier ?? 0);
  let estimate = $derived(rate * minutes * 60);
  let active = $derived((res?.reservations ?? []).filter((r) => r.status === "active" && r.endMs > now));
  let ended = $derived((res?.reservations ?? []).filter((r) => r.status === "ended" || r.endMs <= now).slice(0, 5));
  let balance = $derived(overview?.account?.cSats ?? 0);

  async function reserve() {
    reserving = true;
    error = "";
    notice = "";
    try {
      const r = await createReservation({ computeClass: cls, minutes, ...(model ? { model } : {}) });
      notice = `Reserved a ${CLASS_LABELS[r.computeClass]} machine until ${new Date(r.endMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
      const first = r.model ?? r.models[0];
      if (first) computeChoice.set(choiceId({ where: "reserved", reservationId: r.id, model: first }));
      await load();
    } catch (e) {
      error = computeErrorText(e);
    } finally {
      reserving = false;
    }
  }

  async function cancel(id: string) {
    try {
      const r = await cancelReservation(id);
      notice = `Ended. ${fmt(r.refundCSats ?? 0)} cSats came back.`;
      await load();
    } catch (e) {
      error = computeErrorText(e);
    }
  }

  const fmt = (n: number, d = 2) => n.toLocaleString(undefined, { maximumFractionDigits: d });
  function left(endMs: number) {
    const s = Math.max(0, Math.round((endMs - now) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m left` : `${m}m ${s % 60}s left`;
  }
</script>

<div class="sp">
  <h1>Compute</h1>
  <p class="sp-lead">Run on this computer and your own machines for free, on any machine on the network by the second, or reserve a machine so it works only for you. Pick what a chat uses from the menu in the chat box.</p>

  {#if error}<p class="sp-err">{error}</p>{/if}
  {#if notice}<p class="sp-ok">{notice}</p>{/if}

  {#if loading}
    <p class="sp-muted">Loading…</p>
  {:else if !overview?.connected}
    <div class="sp-card"><div class="sp-row"><div class="sp-text"><span class="sp-title">Not connected to the network</span><span class="sp-desc">Sign in and let this computer's agent connect.</span></div><button onclick={load}>Retry</button></div></div>
  {:else}
    <div class="sp-group">
      <div class="sp-group-title">Reserve a machine <button class="ghost small sp-link" onclick={() => openUrl(portalWebUrl("/portal/market"))}>Market prices ↗</button></div>
      <div class="sp-card">
        <div class="sp-row">
          <div class="sp-text"><span class="sp-title">Class</span><span class="sp-desc">{option ? `${option.available} free now${option.tiers.length ? ` · ${option.tiers.join(", ")}` : ""}` : "Checking…"}</span></div>
          <div class="sp-seg">
            {#each CLASSES as c}
              <button class:active={cls === c} onclick={() => { cls = c; model = ""; classPicked = true; }}>{CLASS_LABELS[c]}{#if res?.options?.[c]}<span class="sp-muted">&nbsp;{res.options[c].available}</span>{/if}</button>
            {/each}
          </div>
        </div>
        <div class="sp-row">
          <div class="sp-text"><span class="sp-title">How long</span><span class="sp-desc">Paid now; if you end early or the machine drops off, the unused time comes back.</span></div>
          <div class="sp-seg">
            {#each DURATIONS as d}
              <button class:active={minutes === d} onclick={() => (minutes = d)}>{d < 60 ? `${d}m` : `${d / 60}h`}</button>
            {/each}
          </div>
        </div>
        <div class="sp-row">
          <div class="sp-text"><span class="sp-title">Needs model</span><span class="sp-desc">Only machines that already have it.</span></div>
          <select bind:value={model} aria-label="Model the machine must have">
            <option value="">Any</option>
            {#each option?.models ?? [] as m}<option value={m}>{shortModel(m)}</option>{/each}
          </select>
        </div>
        <div class="sp-row">
          <div class="sp-text">
            {#if option && !option.available}
              <span class="sp-title">No {CLASS_LABELS[cls]} machine is free right now</span>
              <span class="sp-desc">Try another class, or run on the network by the second from the chat box.</span>
            {:else}
              <span class="sp-title">{fmt(estimate)} cSats</span>
              <span class="sp-desc">{fmt(rate, 4)} cSats/s on the cheapest free tier · you have {fmt(balance)} cSats</span>
            {/if}
          </div>
          {#if estimate > balance}
            <button onclick={() => onNavigate?.("plan")}>Buy cSats</button>
          {/if}
          <button class="primary" disabled={reserving || !option?.available || estimate > balance} onclick={reserve}>{reserving ? "Reserving…" : "Reserve"}</button>
        </div>
      </div>
    </div>

    {#if active.length}
      <div class="sp-group">
        <div class="sp-group-title">Your reservations</div>
        <div class="sp-card">
          {#each active as r (r.id)}
            <div class="sp-row">
              <span class="sp-dot on"></span>
              <div class="sp-text">
                <span class="sp-title">{CLASS_LABELS[r.computeClass]}{r.tier ? ` · ${r.tier}` : ""} · {left(r.endMs)}</span>
                <span class="sp-desc">{r.models.map(shortModel).join(", ") || "no models listed"} · {fmt(r.cSatsPerSecond, 4)} cSats/s · paid {fmt(r.prepaidCSats)}</span>
              </div>
              <div class="sp-controls">
                {#if r.models[0]}
                  <button onclick={() => { computeChoice.set(choiceId({ where: "reserved", reservationId: r.id, model: r.model ?? r.models[0] })); notice = "Chats now run on your reserved machine."; }}>Use in chat</button>
                {/if}
                <button onclick={() => onNavigate?.("connect")}>Use in a tool</button>
                <button class="danger" onclick={() => cancel(r.id)}>End</button>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <div class="sp-group">
      <div class="sp-group-title">Your machines</div>
      <div class="sp-card">
        {#if (overview.account?.machines ?? []).length === 0}
          <div class="sp-row"><span class="sp-muted">No machines linked to your account yet. Install EdgeCoder on another computer and sign in with the same account.</span></div>
        {:else}
          {#each overview.account?.machines ?? [] as m (m.agentId)}
            <div class="sp-row">
              <span class="sp-dot" class:on={m.online}></span>
              <div class="sp-text">
                <span class="sp-title">{m.agentId}</span>
                <span class="sp-desc">{CLASS_LABELS[m.computeClass] ?? m.computeClass}{m.tier ? ` · ${m.tier}` : ""} · {m.online ? "online" : `last seen ${new Date(m.lastSeenMs).toLocaleString()}`}{m.reservedUntilMs ? " · reserved by someone" : ""}</span>
              </div>
              <span class="sp-muted">{m.models.map(shortModel).join(", ")}</span>
            </div>
          {/each}
        {/if}
      </div>
    </div>

    <div class="sp-group">
      <div class="sp-group-title">Model calls: per token</div>
      <div class="sp-card">
        {#if (overview.models ?? []).length === 0}
          <div class="sp-row"><span class="sp-muted">No machines are offering models right now.</span></div>
        {:else}
          <table>
            <thead><tr><th>Model</th><th class="num">Machines</th><th class="num">cSats / M tokens in</th><th class="num">cSats / M tokens out</th></tr></thead>
            <tbody>
              {#each overview.models ?? [] as m (m.model)}
                <tr><td>{m.model}</td><td class="num">{m.agents}</td><td class="num">{m.cSatsPerMTokens?.input ?? "–"}</td><td class="num">{m.cSatsPerMTokens?.output ?? "–"}</td></tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
      <p class="sp-muted">Model calls are priced per token, below typical hosted prices for models that size, and never below the electricity the machine used. The same price on every class; faster hardware just finishes sooner.</p>
    </div>

    <div class="sp-group">
      <div class="sp-group-title">Reservations and code jobs: per second</div>
      <div class="sp-card">
        <table>
          <thead><tr><th>Class</th><th class="num">cSats / second</th><th class="num">cSats / hour</th><th class="num">Machines free</th></tr></thead>
          <tbody>
            {#each Object.entries(overview.classes ?? {}) as [id, c] (id)}
              <tr><td>{c.label}</td><td class="num">{fmt(c.cSatsPerSecondBaseTier, 4)}</td><td class="num">{fmt(c.cSatsPerSecondBaseTier * 3600, 0)}</td><td class="num">{res?.options?.[id]?.available ?? "–"}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="sp-muted">Prices are for each class's base tier; faster tiers cost more per second and finish sooner. {overview.account?.networkAgents ?? 0} machines are online.</p>
    </div>

    {#if ended.length}
      <div class="sp-group">
        <div class="sp-group-title">Ended reservations</div>
        <div class="sp-card">
          {#each ended as r (r.id)}
            <div class="sp-row">
              <div class="sp-text"><span class="sp-title">{CLASS_LABELS[r.computeClass]} · {new Date(r.startMs).toLocaleString()}</span><span class="sp-desc">{r.endReason === "agent_offline" ? "Machine went offline" : r.endReason === "cancelled" ? "Ended early" : "Finished"} · used {fmt(r.usedCSats ?? 0)} · returned {fmt(r.refundCSats ?? 0)} cSats</span></div>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>
