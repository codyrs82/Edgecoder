<script lang="ts">
  // Settings → Active work: what this computer is doing on the network right now (the jobs its
  // agent serves, its slots, whether the network paused it) and your own requests in flight, live
  // from the IDE server (/v1/ide/activity). Refreshes every 2 s while the window is visible.
  import { getActivity, backendReady, isRemoteMode, computeErrorText, type ActivitySnapshot } from "../lib/api";
  import { livePoll } from "../lib/live-poll";
  import { agentLine, memoryModelsText, clockText, elapsedText, jobKindText, KIND_TEXT, liveSummary, requesterText, runningWhere, slotsText, tokensText } from "../lib/activity-view";
  import { thisMachineLabel } from "../lib/agent-paused";
  import { shortModel } from "../lib/compute-choice";
  import { scrollRegion } from "../lib/scroll-region";
  import { budgetLine } from "../lib/memory-status";
  import AgentPausedNotice from "../components/AgentPausedNotice.svelte";
  import MemoryNotice from "../components/MemoryNotice.svelte";
  import EmptyNote from "../components/EmptyNote.svelte";
  import StatusPill from "../components/StatusPill.svelte";
  import ServiceNotice from "../components/ServiceNotice.svelte";
  import { inDesktopShell, onServiceReady, serviceStatus } from "../lib/service-status";

  let { pollMs = 2000 }: { pollMs?: number } = $props();

  let snap = $state<ActivitySnapshot | null>(null);
  let error = $state("");
  let loading = $state(true);
  let remote = $state(false);

  const machine = thisMachineLabel();

  async function refresh() {
    await backendReady;
    if (isRemoteMode() && $serviceStatus.phase === "ready") {
      remote = !inDesktopShell();
      loading = false;
      return;
    }
    remote = false;
    // Starting or restarting: ServiceNotice says so; this loads once the service answers.
    if ($serviceStatus.phase !== "ready") {
      loading = false;
      return;
    }
    try {
      const s = await getActivity();
      snap = s;
      error = "";
    } catch (e) {
      error = computeErrorText(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    const poll = livePoll(refresh, pollMs);
    const offReady = onServiceReady(() => void poll.now());
    return () => {
      poll.stop();
      offReady();
    };
  });

  let agent = $derived(snap?.agent ?? null);
  let line = $derived(agentLine(agent));
  let slots = $derived(slotsText(agent));
  let summary = $derived(liveSummary(snap));
  let nowMs = $derived(snap ? snap.atMs : 0);
  const since = (start: number) => elapsedText(nowMs - start);
</script>

<div class="sp sp-wide">
  <h1>Active work</h1>
  <p class="sp-lead">What {machine} is doing on the network right now, and your own requests while they run. Updates every few seconds.</p>
  <p class="sr-only" aria-live="polite">{summary}</p>

  {#if remote}
    <div class="sp-card"><EmptyNote title="Not available in the web app" description="Active work shows the desktop app's own agent and requests. Open it in the EdgeCoder app on the computer you want to watch." /></div>
  {:else}
    {#if $serviceStatus.phase !== "ready"}
      <ServiceNotice />
    {:else if error}<p class="sp-err" role="alert">Couldn't read this computer's activity: {error}</p>{/if}

    {#if agent?.paused}
      <AgentPausedNotice reason={agent.paused.reason} agentId={agent.agentId ?? undefined} onRetry={refresh} />
    {/if}
    <!-- The host memory guard (#357): "Paused: this Mac is low on memory", from the same snapshot. -->
    {#if agent?.memory}<MemoryNotice memory={agent.memory} />{/if}

    <section class="sp-group" aria-labelledby="aw-agent">
      <h2 class="sp-group-title" id="aw-agent">{machine} on the network</h2>
      <div class="sp-card">
        {#if loading && !snap}
          <div class="sp-row"><span class="sp-muted">Loading…</span></div>
        {:else}
          <div class="sp-row">
            <span class="sp-dot" class:on={line.tone === "on"} class:warn={line.tone === "warn"} class:err={line.tone === "err"} aria-hidden="true"></span>
            <div class="sp-text">
              <span class="sp-title">{line.title}</span>
              {#if line.detail}<span class="sp-desc">{line.detail}</span>{/if}
            </div>
          </div>
          {#if agent?.memory}
            <div class="sp-row">
              <div class="sp-text">
                <span class="sp-title">Models</span>
                <span class="sp-desc">{memoryModelsText(agent.memory)}</span>
                <span class="sp-desc">{budgetLine(agent.memory)}</span>
              </div>
            </div>
          {/if}
          {#if slots}
            <div class="sp-row">
              <div class="sp-text">
                <span class="sp-title">Model slots</span>
                <span class="sp-desc">{slots}{agent?.claims ? ` · ${agent.claims} claimed job${agent.claims === 1 ? "" : "s"}` : ""}</span>
              </div>
            </div>
          {/if}
        {/if}
      </div>
    </section>

    <section class="sp-group" aria-labelledby="aw-serving">
      <h2 class="sp-group-title" id="aw-serving">Jobs {machine} is serving</h2>
      <div class="sp-card">
        {#if agent && agent.jobs.length}
          <div class="sp-table-scroll" role="group" aria-labelledby="aw-serving" use:scrollRegion>
            <table>
              <thead><tr><th scope="col">For</th><th scope="col">Model</th><th scope="col">Kind</th><th scope="col">Started</th><th scope="col" class="num">Elapsed</th><th scope="col" class="num">Tokens so far</th></tr></thead>
              <tbody>
                {#each agent.jobs as j (j.id + j.startedAtMs)}
                  <tr>
                    <td>{requesterText(j)}</td>
                    <td>{j.model ? shortModel(j.model) : "–"}</td>
                    <td>{jobKindText(j)}</td>
                    <td class="sp-muted">{clockText(j.startedAtMs)}</td>
                    <td class="num">{elapsedText(j.elapsedMs)}</td>
                    <td class="num">{j.kind === "inference" ? tokensText(j.outputTokens) : "–"}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else if agent?.reachable && agent.jobsUnknown}
          <EmptyNote title="This computer's agent doesn't report its jobs" description="It runs an older version. After the next app update, the network jobs it serves show here." />
        {:else if !agent}
          <EmptyNote title="No network jobs" description="This computer isn't on the network. Once it is enrolled (Settings → Compute), the jobs it serves for others show here." />
        {:else}
          <EmptyNote title="No network jobs right now." description="When {machine} serves a job, it shows here: the model, when it started and how much it has written so far. Jobs for other people never show who asked." />
        {/if}
      </div>
    </section>

    <section class="sp-group" aria-labelledby="aw-mine">
      <h2 class="sp-group-title" id="aw-mine">Your requests in flight</h2>
      <div class="sp-card">
        {#if snap && snap.mine.length}
          <div class="sp-table-scroll" role="group" aria-labelledby="aw-mine" use:scrollRegion>
            <table>
              <thead><tr><th scope="col">What</th><th scope="col">Kind</th><th scope="col">Where it's running</th><th scope="col" class="num">Elapsed</th><th scope="col" class="num">cSats so far</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {#each snap.mine as m (m.id)}
                  <tr>
                    <td class="what"><span class="title">{m.title}</span>{#if m.source}<div class="sp-muted">{m.source}</div>{/if}</td>
                    <td>{KIND_TEXT[m.kind]}</td>
                    <td class="where">{runningWhere(m)}</td>
                    <td class="num">{since(m.startedAtMs)}</td>
                    <td class="num">{m.cSats ? m.cSats.toLocaleString(undefined, { maximumFractionDigits: 3 }) : "0"}</td>
                    <td><StatusPill status={m.progress === "Waiting for your approval" ? "waiting" : "running"} label={m.progress ?? undefined} /></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else if loading && !snap}
          <div class="sp-row"><span class="sp-muted">Loading…</span></div>
        {:else}
          <EmptyNote title="Nothing of yours is running." description="Chats, Code turns, bit runs, helpers and API calls show here while they run, with where each one is running." />
        {/if}
      </div>
    </section>
  {/if}
</div>

<style>
  .what .title { display: block; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .where { max-width: 260px; }
</style>
