<script lang="ts">
  // Getting started: the steps of src/common/onboarding.ts (byte-identical lib/onboarding.ts), the
  // same guide as the web's /portal/welcome. Progress lives on the portal (per account), so it
  // resumes on any computer and on the web. Checklists read real state: the account's machines,
  // balance, keys and GitHub from the portal, and this computer's models and CLI from the app.
  // Each step has a route (#/welcome/<step>), a data-video-anchor and a video slot hidden until set.
  import { tick, untrack } from "svelte";
  import { Check, Copy } from "@lucide/svelte";
  import { open as openUrl } from "@tauri-apps/plugin-shell";
  import Dialog from "./ui/Dialog.svelte";
  import * as O from "../lib/onboarding";
  import type { OnboardingSignals, OnboardingState, StepId } from "../lib/onboarding";
  import {
    computeOverview, getCliStatus, getModelPullProgress, getOllamaTags, getOnboarding, getOnchainDeposits, getSystemMetrics,
    getPaymentPaths, getWalletOverview, installCliTool, portalWebUrl, pullModel, saveOnboarding, type OnboardingPatch, type PaymentPaths,
  } from "../lib/api";
  import { computeChoice } from "../lib/compute-choice";

  interface Props {
    /** Open on this step instead of the saved one. */
    initialStep?: StepId | null;
    onClose: () => void;
    /** A Settings section (the wizard closes first; progress is saved). */
    onOpenSettings: (section: string) => void;
    /** try-chat, open-code, new-bot: the app does it (the wizard closes first). */
    onRun: (action: string) => void;
  }
  let { initialStep = null, onClose, onOpenSettings, onRun }: Props = $props();

  const UNKNOWN: OnboardingSignals = {
    machines: null, machinesOnline: null, balanceCSats: null, apiKeys: null, github: null, firstTask: null,
    hostApproved: null, hostRequested: null, newAccount: null, localModels: null, cliInstalled: null,
  };

  let ob = $state<OnboardingState>(O.emptyOnboardingState(Date.now()));
  let server = $state<OnboardingSignals>(UNKNOWN);
  let local = $state<{ localModels: number | null; cliInstalled: boolean | null }>({ localModels: null, cliInstalled: null });
  const signals = $derived<OnboardingSignals>({ ...server, ...local });
  let loaded = $state(false);
  let loadError = $state("");
  let hw = $state<{ ramGb: number | null; computeClass: string | null }>({ ramGb: null, computeClass: null });
  let models = $state<Array<{ model: string; cSatsPerMTokens?: { input: number; output: number } }>>([]);
  let btcUsd = $state<number | null>(null);
  let onchain = $state<boolean | null>(null);
  let network = $state<string | null>(null);
  // Direct-payment buttons (reservations paid buyer to host) show only while that path is on.
  let paths = $state<PaymentPaths | null>(null);
  let calls = $state(50);
  let classId = $state("35b");
  let pull = $state<{ model: string; pct: number | null; status: string; error: string } | null>(null);
  let cliMessage = $state("");
  let announce = $state("");
  let titleEl: HTMLHeadingElement | undefined = $state();

  const steps = $derived(O.stepsFor(ob.goal));
  const step = $derived(O.stepById(ob.current));
  const progress = $derived(O.progressFor(ob, signals, "desktop"));
  const next = $derived(O.nextStepId(ob.current, ob.goal));
  const prev = $derived(O.prevStepId(ob.current, ob.goal));
  const suggestion = $derived(O.suggestModel(hw));
  const actions = $derived(O.actionsFor(step, "desktop", paths));
  // Rows the step's own choices don't already answer (Welcome's goal, Models' routing aren't repeated).
  const checklist = $derived(O.shownChecklist(step, "desktop"));

  async function refreshLocal() {
    try {
      const tags = await getOllamaTags();
      local.localModels = (tags.models ?? []).filter((m) => !/embed/i.test(m.name)).length;
    } catch {
      local.localModels = null;
    }
    try {
      local.cliInstalled = (await getCliStatus()).installed;
    } catch {
      local.cliInstalled = null;
    }
  }

  async function refreshServer() {
    try {
      const r = await getOnboarding();
      server = r.signals;
      return r;
    } catch (err) {
      loadError = (err as Error).message;
      return null;
    }
  }

  async function save(patch: OnboardingPatch) {
    try {
      const r = await saveOnboarding(patch);
      if (r.state) ob = { ...O.normalizeOnboardingState(r.state, Date.now()), current: ob.current };
      server = r.signals;
    } catch {
      // Kept on screen; the next change tries again.
    }
  }

  $effect(() => {
    untrack(() => void start());
    const t = setInterval(() => { void refreshServer(); void refreshLocal(); }, 5000);
    return () => clearInterval(t);
  });

  async function start() {
    const [r] = await Promise.all([refreshServer(), refreshLocal()]);
    if (r?.state) ob = O.normalizeOnboardingState(r.state, Date.now());
    if (initialStep) ob.current = initialStep;
    loaded = true;
    // Opening the guide brings it back if it was closed, and marks it seen.
    void save({ current: ob.current, dismissed: false });
    void loadHardware();
    await focusStep();
  }

  async function loadHardware() {
    const [metrics, overview] = await Promise.all([getSystemMetrics(), computeOverview().catch(() => null)]);
    const self = overview?.account?.machines?.find((m) => m.agentId === overview.selfAgentId);
    hw = { ramGb: metrics ? Math.round(metrics.memory_total_mb / 1024) : null, computeClass: self?.computeClass ?? (navigator.userAgent.includes("Mac") ? "apple" : null) };
    models = overview?.models ?? [];
  }

  async function loadWallet() {
    if (btcUsd !== null) return;
    void getPaymentPaths().then((p) => (paths = p)).catch(() => undefined);
    try {
      const w = await getWalletOverview();
      btcUsd = w.btcUsd;
      network = w.network ?? null;
    } catch {
      btcUsd = null;
    }
    try {
      onchain = (await getOnchainDeposits()).enabled === true;
    } catch {
      onchain = false;
    }
  }

  async function focusStep() {
    await tick();
    announce = `Step ${progress.index + 1} of ${progress.total}: ${step.title}`;
    titleEl?.focus();
    try { history.replaceState(null, "", O.stepRoute(ob.current, "desktop")); } catch { /* not in a browser context */ }
    if (ob.current === "fund") void loadWallet();
  }

  async function go(id: StepId) {
    ob.current = id;
    void save({ current: id });
    await focusStep();
  }

  async function nextStep() {
    const done = ob.done.includes(ob.current) ? ob.done : [...ob.done, ob.current];
    const skipped = ob.skipped.filter((s) => s !== ob.current);
    ob.done = done;
    ob.skipped = skipped;
    if (!next) {
      await save({ done, skipped, completed: true });
      close();
      return;
    }
    void save({ done, skipped });
    await go(next);
  }

  async function skipStep() {
    const skipped = ob.skipped.includes(ob.current) ? ob.skipped : [...ob.skipped, ob.current];
    ob.skipped = skipped;
    void save({ skipped });
    if (next) await go(next);
  }

  function close() {
    try { history.replaceState(null, "", location.pathname + location.search); } catch { /* ignore */ }
    onClose();
  }

  async function dismiss() {
    await save({ dismissed: true });
    close();
  }

  function chooseGoal(goal: O.OnboardingGoal) {
    ob.goal = goal;
    void save({ goal });
  }

  function chooseRouting(r: O.RoutingPolicy) {
    ob.routing = r;
    void save({ routing: r });
    // The chat's compute menu takes the two that map onto it directly.
    if (r === "auto") computeChoice.set("auto");
    if (r === "local_only") computeChoice.set(undefined);
  }

  async function runAction(target: string) {
    if (target.startsWith("settings:")) {
      close();
      onOpenSettings(target.slice("settings:".length));
      return;
    }
    if (target === "run:pull-model") return void pullSuggested();
    if (target === "run:install-cli") return void installCli();
    if (target.startsWith("run:")) {
      close();
      onRun(target.slice(4));
      return;
    }
    const href = O.actionHref(target);
    void openUrl(href.startsWith("/") ? portalWebUrl(href) : href).catch(() => undefined);
  }

  async function pullSuggested() {
    const model = suggestion.model;
    pull = { model, pct: 0, status: "Starting", error: "" };
    try {
      await pullModel(model);
      for (let i = 0; i < 3600; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const p = await getModelPullProgress();
        if (!p) break;
        if (p.error) throw new Error(p.error);
        pull = { model, pct: Math.round(p.progressPct), status: p.status, error: "" };
        if (p.status === "success" || p.progressPct >= 100) break;
      }
      pull = { model, pct: 100, status: "Done", error: "" };
      await refreshLocal();
    } catch (err) {
      pull = { model, pct: null, status: "", error: (err as Error).message || "The download failed." };
    }
  }

  async function installCli() {
    try {
      const r = await installCliTool();
      cliMessage = r.message;
    } catch (err) {
      cliMessage = (err as Error).message;
    }
    await refreshLocal();
  }

  async function copy(text: string, e: MouseEvent) {
    const btn = e.currentTarget as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(text);
      btn.dataset.copied = "1";
      setTimeout(() => delete btn.dataset.copied, 1500);
    } catch {
      // select the text instead
    }
  }

  const priceRows = $derived(
    O.MODEL_CLASSES.map((c) => {
      const p = O.classPrice(c.id, { models, btcUsd });
      const per = p ? O.cSatsPerCall(p) : null;
      return { ...c, per, calls: per ? O.callsPerThousand(per) : null };
    }),
  );
  const fundBuys = $derived(O.callsForCSats(1000, O.FUND_EXAMPLE_CLASS, { models, btcUsd }));
  const testNote = $derived(O.testNetworkNote(network));
  const selected = $derived(priceRows.find((r) => r.id === classId) ?? null);
  const statusText = (v: boolean | null) => (v === true ? "Done" : v === false ? "Not yet" : "Can't check here");
</script>

<Dialog variant="full" labelledby="wz-title" onClose={close} initialFocus={() => titleEl}>
  <div class="wz" data-testid="onboarding-wizard">
    <aside class="wz-side">
      <!-- macOS overlay title bar: room for the traffic lights, and a handle to drag the window. -->
      <div class="wz-titlebar" data-tauri-drag-region data-testid="wz-titlebar" aria-hidden="true"></div>
      <h1 class="wz-h1">Getting started</h1>
      <progress class="wz-progress" max={progress.total} value={progress.completed} aria-label="Getting started progress" aria-valuetext="{progress.completed} of {progress.total} steps done"></progress>
      <nav aria-label="Getting started steps">
        <ol class="wz-steps">
          {#each steps as s, i (s.id)}
            {@const p = progress.steps.find((x) => x.id === s.id)}
            <li>
              <!-- done: complete and moved past (or being worked on now); ready: already complete from
                   the account's state but not reached yet, so it reads quieter. -->
              <button
                class="wz-step"
                class:done={p?.complete && (p.visited || s.id === ob.current)}
                class:ready={p?.complete && !p.visited && s.id !== ob.current}
                aria-current={s.id === ob.current ? "step" : undefined}
                onclick={() => go(s.id)}
              >
                <span class="wz-num" aria-hidden="true">{#if p?.complete}<Check size={12} strokeWidth={2.5} />{:else}{i + 1}{/if}</span>
                <span class="wz-step-label">{s.title}</span>
                {#if p?.complete}<span class="sr-only">, done</span>{:else if p?.skipped}<span class="sr-only">, skipped</span>{/if}
              </button>
            </li>
          {/each}
        </ol>
      </nav>
      <button class="wz-btn ghost wz-close" onclick={dismiss}>Close guide</button>
    </aside>

    <section class="wz-main" data-video-anchor="welcome-{step.id}" data-step={step.id} aria-labelledby="wz-title">
      <div class="wz-titlebar" data-tauri-drag-region aria-hidden="true"></div>
      <div class="wz-scroll">
        <div class="wz-col" data-testid="wz-col">
          <p class="sr-only" role="status" aria-live="polite">{announce}</p>
          <p class="wz-count">Step {progress.index + 1} of {progress.total}</p>
          <h2 id="wz-title" tabindex="-1" bind:this={titleEl}>{step.title}</h2>
          <p class="wz-body">{step.body}</p>
          {#if loadError && !loaded}<p class="wz-err" role="alert">{loadError}</p>{/if}

          <!-- Explainer videos play on the web guide only; here the slot links to it. -->
          <div class="wz-video" data-video-slot={step.id} hidden={!step.video.src}>
            {#if step.video.src}
              <button class="wz-link" onclick={() => void openUrl(portalWebUrl(O.stepRoute(step.id, "web"))).catch(() => undefined)}>Watch the explainer</button>
              <span class="wz-muted">(opens in your browser)</span>
            {/if}
          </div>

          {#if step.id === "welcome"}
            <fieldset class="wz-choices">
              <legend class="sr-only">What do you want to do?</legend>
              {#each O.GOAL_OPTIONS as g (g.id)}
                <label class="wz-choice" class:on={ob.goal === g.id}>
                  <input type="radio" name="wz-goal" value={g.id} checked={ob.goal === g.id} onchange={() => chooseGoal(g.id)} />
                  <span><span class="wz-choice-title">{g.title}</span><span class="wz-choice-desc">{g.desc}</span></span>
                </label>
              {/each}
            </fieldset>
          {:else if step.id === "how"}
            <ol class="wz-cards">
              {#each O.HOW_CARDS as c, i (c.title)}<li class="wz-card"><h3>{i + 1}. {c.title}</h3><p>{c.body}</p></li>{/each}
            </ol>
            <h3 class="wz-sub">Also in EdgeCoder</h3>
            <ul class="wz-cards plain">
              {#each O.HOW_MORE as c (c.title)}<li class="wz-card"><h3>{c.title}</h3><p>{c.body}</p></li>{/each}
            </ul>
          {:else if step.id === "this-machine"}
            <div class="wz-note">
              <p><strong>Suggested for this computer: {suggestion.label}</strong></p>
              <p class="wz-muted">{hw.ramGb ? `${hw.ramGb} GB memory${hw.computeClass ? `, ${hw.computeClass === "apple" ? "Apple silicon" : hw.computeClass === "cpu" ? "CPU" : "GPU"}` : ""}. ` : ""}{suggestion.reason}</p>
              {#if pull}
                {#if pull.error}
                  <p class="wz-err" role="alert">{pull.error}</p>
                {:else}
                  <p role="status">{pull.status === "Done" ? `${pull.model} is ready.` : `Downloading ${pull.model}: ${pull.status}`}</p>
                  <progress max="100" value={pull.pct ?? 0} aria-label="Download progress"></progress>
                {/if}
              {/if}
            </div>
          {:else if step.id === "machines"}
            <p class="wz-live" aria-live="polite">Machines on your account: <strong>{signals.machines ?? "…"}</strong>{#if signals.machinesOnline !== null}, {signals.machinesOnline} online{/if}.</p>
            <h3 class="wz-sub">Mac and Windows</h3>
            <p>Install the desktop app on the other computer and sign in with this account.</p>
            <div class="wz-actions">
              <button class="wz-btn" onclick={() => runAction("@mac")}>Download for Mac</button>
              <button class="wz-btn" onclick={() => runAction("@windows")}>Download for Windows</button>
            </div>
            <h3 class="wz-sub">Linux and GPU servers</h3>
            <ol class="wz-howto">
              <li>
                <strong>Create an install key</strong> on the web: Settings → Connect your tools → API keys → Create key. Keep it private: it acts as your account.
                <div class="wz-actions"><button class="wz-btn" onclick={() => runAction("/portal/settings#tools")}>Create an install key</button></div>
              </li>
              <li>
                <strong>Connect to the server with SSH.</strong> On a Mac or Linux open Terminal; on Windows open PowerShell. Put in your server's IP address; most GPU clouds log in as <code>ubuntu</code>, some as <code>root</code>.
                {@render code(O.SERVER_SETUP.sshCommand, "SSH command")}
              </li>
              <li>
                <strong>Paste the install command</strong> into the server, with your key in place of {O.SERVER_SETUP.keyPlaceholder}. It takes 5 to 15 minutes and starts one agent per GPU.
                {@render code(O.serverInstallCommand(portalWebUrl(""), O.SERVER_SETUP.keyPlaceholder), "Installer command")}
              </li>
              <li>
                <strong>NVIDIA GPU with 24 GB or more? Switch to vLLM</strong>, which serves several calls at once. It picks the settings for your GPU:
                {@render code(O.SERVER_SETUP.vllmCommand, "vLLM command")}
              </li>
            </ol>
            <p>Full guide: <button class="wz-link" onclick={() => runAction("@serverGuide")}>{O.SERVER_SETUP.guideTitle}</button>. SSH keys, providers and GPU sizes, checks, and troubleshooting.</p>
            <p class="wz-muted">Each machine's models: Settings → Nodes on the web.</p>
            <p class="wz-note">{O.LOCAL_NETWORK_NOTE}</p>
          {:else if step.id === "models"}
            <fieldset class="wz-choices">
              <legend class="sr-only">Where things run</legend>
              {#each O.ROUTING_OPTIONS as r (r.id)}
                <label class="wz-choice" class:on={(ob.routing ?? "auto") === r.id}>
                  <input type="radio" name="wz-routing" value={r.id} checked={(ob.routing ?? "auto") === r.id} onchange={() => chooseRouting(r.id)} />
                  <span><span class="wz-choice-title">{r.title}{#if r.recommended} <span class="wz-tag">Recommended</span>{/if}</span><span class="wz-choice-desc">{r.desc}</span></span>
                </label>
              {/each}
            </fieldset>
            <p class="wz-muted">Auto and This computer only set the chat's compute menu. Bots have their own setting in the bot form; pick a specific model in the chat's compute menu.</p>
            <h3 class="wz-sub">Bring your own frontier key (optional)</h3>
            <p>Add your own Anthropic or OpenAI-compatible key to lead with a frontier model. Only your account uses it, and the provider bills you.</p>
          {:else if step.id === "fund"}
            {#if O.fundingOptional(ob.goal)}<p class="wz-note">You chose your own machines: they're free, so you can skip this.</p>{/if}
            {#if fundBuys !== null}<p data-testid="wz-buys">1,000 cSats ≈ <strong>{O.groupThousands(fundBuys)} calls</strong> on a 30B coder model (about 1,000 sats).</p>{/if}
            <h3 class="wz-sub">How to buy cSats</h3>
            <ol class="wz-howto" data-testid="wz-fund-steps">
              {#each O.FUND_STEPS as f (f.title)}<li><strong>{f.title}</strong> {f.body}</li>{/each}
            </ol>
            {#if testNote}<p class="wz-note" data-testid="wz-test-network">{testNote}</p>{/if}
            <h3 class="wz-sub">Reserve a machine</h3>
            <p>To hold a machine for your jobs only, use Settings → Compute. It's paid from the same cSats balance; unused time comes back when you cancel.</p>
            <div class="wz-est">
              <h3>Estimate your cost</h3>
              <label for="wz-calls">Calls per day: <strong>{calls}</strong></label>
              <input id="wz-calls" type="range" min="0" max="500" step="10" bind:value={calls} />
              <label for="wz-class">Model size</label>
              <select id="wz-class" bind:value={classId}>
                {#each O.MODEL_CLASSES as c (c.id)}<option value={c.id}>{c.label}</option>{/each}
              </select>
              <p aria-live="polite" data-testid="wz-estimate">
                {#if selected?.per}About <strong>{O.groupThousands(O.estimateCSats(calls, selected.per, 1))} cSats a day</strong>, {O.groupThousands(O.estimateCSats(calls, selected.per, 30))} a month, on the network. Your own machines cost nothing.{:else}Prices are unavailable right now.{/if}
              </p>
              <div class="wz-table">
                <table>
                  <caption class="sr-only">Cost per typical call by model size</caption>
                  <thead><tr><th>Model size</th><th class="num">cSats per call</th><th class="num">Calls per 1,000 cSats</th></tr></thead>
                  <tbody>
                    {#each priceRows as r (r.id)}
                      <tr class:on={r.id === classId}><td>{r.label}</td><td class="num">{r.per === null ? "–" : r.per.toFixed(r.per < 1 ? 2 : 1)}</td><td class="num">{r.calls === null ? "–" : `about ${O.groupThousands(r.calls)}`}</td></tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </div>
            <div class="wz-actions">
              <button class="wz-btn primary" onclick={() => runAction("settings:plan")}>Fund with Lightning</button>
              {#if onchain}
                <button class="wz-btn" onclick={() => runAction("settings:plan")}>Fund with Bitcoin</button>
              {:else}
                <button class="wz-btn" disabled aria-describedby="wz-onchain-soon">Fund with Bitcoin</button><span id="wz-onchain-soon" class="wz-muted">Coming soon</span>
              {/if}
            </div>
            <p class="wz-muted">Bots have a daily budget, so a bot never spends more than you allow.</p>
          {:else if step.id === "tools"}
            <h3 class="wz-sub">GitHub</h3>
            <p>Clone repositories and open pull requests (Code → New project → Clone from GitHub).</p>
            <h3 class="wz-sub">Editors on this computer</h3>
            <p>Continue, Zed, Cline, Claude Code and others can use this app's local provider. Settings → Connect your tools gives each tool its own key and setup. Cursor can't reach this computer: use the hosted API.</p>
            {@render code(O.localProviderSnippet("from Connect your tools"), "Local provider settings")}
            <h3 class="wz-sub">Hosted API</h3>
            <p>OpenAI-compatible <code>/v1/chat/completions</code> and Anthropic-style <code>/v1/messages</code>, with an API key from Settings on the web.</p>
            {@render code(O.hostedApiSnippet(portalWebUrl("")), "Hosted API example")}
            <h3 class="wz-sub">Terminal</h3>
            <p>Install the command-line tool, then run <code>edgecoder code</code> in a project. Type <code>/remote</code> to keep working on the session in the Code view.</p>
            {#if cliMessage}<p role="status" class="wz-muted">{cliMessage}</p>{/if}
          {:else if step.id === "try"}
            <ul class="wz-list">
              <li><strong>Ask in Chat</strong> sends a short question, so you can see the reply and where it ran.</li>
              <li><strong>Explain a file in Code</strong>: open a project and ask about any file.</li>
              <li><strong>Create a bot</strong> with a small daily budget.</li>
            </ul>
            <p class="wz-muted">Each reply ends with where it ran (your machine or the network) and what it cost.</p>
          {:else if step.id === "host"}
            <ul class="wz-list">
              <li>A machine that stays on, with a good connection.</li>
              <li>A model people use. A 30B coder on a GPU or a 32 GB+ Mac earns most.</li>
              <li>Approval: send the request and an admin reviews it.</li>
            </ul>
            {#if signals.hostApproved}<p class="wz-note">You're approved: your machines can take network work.</p>{:else if signals.hostRequested}<p class="wz-note">Request sent. We'll email you.</p>{/if}
          {:else if step.id === "done"}
            <ul class="wz-checklist">
              {#each progress.steps.filter((p) => p.id !== "done") as p (p.id)}
                <li>
                  <span class="wz-check" class:on={p.complete} aria-hidden="true">{#if p.complete}<Check size={11} />{/if}</span>
                  <button class="wz-link" onclick={() => go(p.id)}>{O.stepById(p.id).title}</button>
                  <span class="sr-only">: {p.complete ? "done" : p.skipped ? "skipped" : "not yet"}</span>
                  {#if p.skipped && !p.complete}<span class="wz-muted">(skipped)</span>{/if}
                </li>
              {/each}
            </ul>
          {/if}

          {#if checklist.length}
            <ul class="wz-checklist" aria-label="Checklist">
              {#each checklist as c (c.id)}
                {@const v = O.itemDone(c.id, signals, ob)}
                <li data-item={c.id}>
                  <span class="wz-check" class:on={v === true} aria-hidden="true">{#if v === true}<Check size={11} />{/if}</span>
                  <span>{c.label}{#if c.optional} <span class="wz-muted">(optional)</span>{/if}</span>
                  <span class="sr-only">: {statusText(v)}</span>
                </li>
              {/each}
            </ul>
          {/if}

          {#if actions.length}
            <div class="wz-actions">
              {#each actions as a (a.id)}
                <button class={a.primary ? "wz-btn primary" : "wz-btn"} data-action={a.id} disabled={a.id === "pull" && !!pull && !pull.error && pull.status !== "Done"} onclick={() => runAction(a.desktop!)}>
                  {a.id === "pull" ? `Download ${suggestion.model}` : a.label}
                </button>
              {/each}
            </div>
          {/if}

          <div class="wz-footer">
            {#if prev}<button class="wz-btn" onclick={() => go(prev!)}>Back</button>{:else}<span></span>{/if}
            <div class="wz-footer-right">
              {#if step.skip && next}<button class="wz-btn ghost" onclick={skipStep}>{step.skip}</button>{/if}
              <button class="wz-btn primary" onclick={nextStep}>{next ? "Next" : "Finish"}</button>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</Dialog>

{#snippet code(text: string, label: string)}
  <div class="wz-code">
    <pre aria-label={label}><code>{text}</code></pre>
    <button class="wz-btn small" onclick={(e) => copy(text, e)} aria-label="Copy {label}"><Copy size={12} /> Copy</button>
  </div>
{/snippet}

<style>
  .wz { flex: 1; min-height: 0; display: flex; background: var(--bg-base); color: var(--text-primary); }
  .wz-side { width: 250px; flex-shrink: 0; display: flex; flex-direction: column; gap: 10px; padding: 20px 12px; border-right: 0.5px solid var(--border); background: var(--bg-deep); overflow-y: auto; }
  /* The window's title bar strip. Elsewhere it takes no room; on macOS (overlay title bar, see
     main.ts) it clears the traffic lights (tauri.conf.json trafficLightPosition) and drags the window. */
  .wz-titlebar { flex: none; height: 0; -webkit-app-region: drag; user-select: none; }
  :global(html[data-titlebar="overlay"]) .wz-side .wz-titlebar { height: 24px; margin: -20px -12px 0; padding-top: 20px; box-sizing: content-box; }
  :global(html[data-titlebar="overlay"]) .wz-main .wz-titlebar { height: 28px; }
  .wz-h1 { margin: 0 8px; font-size: var(--fs-lg); font-weight: 600; }
  .wz-progress { width: calc(100% - 16px); margin: 0 8px; height: 6px; accent-color: var(--accent); }
  .wz-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  /* Badge and label share a 20px line, so a two-line label keeps its badge on the first line. */
  .wz-step { width: 100%; display: flex; align-items: flex-start; gap: 10px; padding: 7px 8px; border: none; border-radius: var(--radius-md); background: none; color: var(--text-secondary); font: inherit; font-size: var(--fs-sm); line-height: 20px; text-align: left; cursor: pointer; }
  .wz-step-label { min-width: 0; }
  .wz-step:hover { background: var(--bg-surface); color: var(--text-primary); }
  .wz-step[aria-current="step"] { background: var(--bg-surface); color: var(--text-primary); font-weight: 600; }
  .wz-num { flex: none; box-sizing: border-box; width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--border-strong); display: inline-flex; align-items: center; justify-content: center; font-size: var(--fs-2xs); line-height: 1; font-variant-numeric: tabular-nums; }
  .wz-step[aria-current="step"] .wz-num { border-color: var(--accent); color: var(--accent); }
  .wz-step.done .wz-num { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .wz-step.ready { color: var(--text-muted); }
  .wz-step.ready .wz-num { border-color: var(--border-strong); color: var(--text-muted); }
  .wz-close { margin-top: auto; }
  .wz-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .wz-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 32px 40px 40px; }
  /* One centred column: heading, intro, cards, checklist and the Back / Next row share its edges. */
  .wz-col { max-width: 800px; margin: 0 auto; }
  .wz-main h2 { margin: 0 0 6px; font-size: var(--fs-xl); font-weight: 600; }
  .wz-main h2:focus { outline: none; }
  .wz-main h3 { margin: 0 0 4px; font-size: var(--fs-sm); font-weight: 600; }
  .wz-main p, .wz-main li { font-size: var(--fs-sm); line-height: var(--lh-ui); }
  .wz-count { margin: 0 0 4px; color: var(--text-muted); font-size: var(--fs-xs); }
  .wz-body { margin: 0 0 16px; color: var(--text-secondary); }
  .wz-sub { margin-top: 18px !important; }
  .wz-muted { color: var(--text-muted); font-size: var(--fs-xs); }
  .wz-howto { margin: 8px 0 12px; padding-left: 22px; display: flex; flex-direction: column; gap: 12px; line-height: 1.5; }
  .wz-err { color: var(--danger); }
  .wz-note { padding: 10px 12px; border: 0.5px solid var(--border); border-radius: var(--radius-md); background: var(--bg-surface); }
  .wz-note p { margin: 0 0 4px; }
  .wz-note progress { width: 100%; }
  .wz-choices { border: 0; padding: 0; margin: 0 0 12px; display: grid; gap: 8px; }
  .wz-choice { display: flex; gap: 10px; align-items: flex-start; padding: 12px; border: 0.5px solid var(--border-strong); border-radius: var(--radius-lg); cursor: pointer; }
  .wz-choice.on { border-color: var(--accent); background: var(--bg-surface); }
  .wz-choice input { margin-top: 3px; }
  .wz-choice-title { display: block; font-weight: 600; font-size: var(--fs-sm); }
  .wz-choice-desc { display: block; color: var(--text-secondary); font-size: var(--fs-xs); }
  .wz-tag { margin-left: 6px; font-size: var(--fs-2xs); font-weight: 600; padding: 1px 6px; border-radius: 999px; background: var(--accent); color: var(--on-accent); }
  .wz-cards { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
  .wz-card { padding: 12px; border: 0.5px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-surface); }
  .wz-card p { margin: 0; color: var(--text-secondary); font-size: var(--fs-xs); }
  .wz-list { padding-left: 18px; }
  .wz-code { position: relative; margin: 8px 0; }
  .wz-code pre { margin: 0; padding: 10px 84px 10px 12px; background: var(--bg-surface); border: 0.5px solid var(--border); border-radius: var(--radius-md); font-family: var(--font-mono); font-size: 12px; overflow-x: auto; white-space: pre; }
  .wz-code .wz-btn { position: absolute; top: 6px; right: 6px; }
  .wz-checklist { list-style: none; margin: 16px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .wz-checklist li { display: flex; align-items: center; gap: 8px; font-size: var(--fs-sm); }
  .wz-check { flex: none; width: 18px; height: 18px; border-radius: 50%; border: 0.5px solid var(--border-strong); display: inline-flex; align-items: center; justify-content: center; }
  .wz-check.on { background: var(--green); border-color: var(--green); color: var(--on-accent); }
  .wz-link { border: none; background: none; padding: 0; color: var(--accent); font: inherit; cursor: pointer; text-decoration: underline; }
  .wz-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 0; align-items: center; }
  .wz-btn { height: var(--control-md); padding: 0 12px; border: 0.5px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--bg-base); color: var(--text-primary); font: inherit; font-size: var(--fs-sm); font-weight: 500; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
  .wz-btn:hover:not(:disabled) { border-color: var(--text-secondary); }
  .wz-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .wz-btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
  .wz-btn.ghost { border-color: transparent; background: none; color: var(--text-secondary); }
  .wz-btn.small { height: var(--control-sm); padding: 0 8px; font-size: var(--fs-xs); }
  .wz-footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 24px; padding-top: 14px; border-top: 0.5px solid var(--border); flex-wrap: wrap; }
  .wz-footer-right { display: flex; gap: 8px; flex-wrap: wrap; }
  .wz-video { margin: 0 0 14px; }
  .wz-est { display: flex; flex-direction: column; gap: 6px; max-width: 520px; }
  .wz-est select { width: max-content; height: var(--control-md); background: var(--bg-input); color: var(--text-primary); border: 0.5px solid var(--border-control); border-radius: var(--radius-sm); }
  .wz-table { overflow-x: auto; }
  .wz-table table { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); }
  .wz-table th, .wz-table td { text-align: left; padding: 6px 8px; border-top: 0.5px solid var(--border); }
  .wz-table .num { text-align: right; font-variant-numeric: tabular-nums; }
  .wz-table tr.on td { font-weight: 600; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  @media (max-width: 760px) {
    .wz { flex-direction: column; }
    .wz-side { width: auto; border-right: none; border-bottom: 0.5px solid var(--border); }
    .wz-steps { flex-direction: row; overflow-x: auto; }
    .wz-step { white-space: nowrap; }
    .wz-scroll { padding: 20px 16px 32px; }
    .wz-step { align-items: center; }
    /* Stacked: the step list is on top and clears the traffic lights for the whole window. */
    :global(html[data-titlebar="overlay"]) .wz-main .wz-titlebar { height: 0; }
  }
</style>
