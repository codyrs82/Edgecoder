<script lang="ts">
  import { untrack } from "svelte";
  import { Tabs } from "bits-ui";
  import ChatMessage from "../components/ChatMessage.svelte";
  import ChatInput from "../components/ChatInput.svelte";
  import QuoteSelection from "../components/QuoteSelection.svelte";
  import BotAvatar from "../components/BotAvatar.svelte";
  import BotFolderSetup from "../components/BotFolderSetup.svelte";
  import ToolArgs from "../components/ToolArgs.svelte";
  import ServiceNotice from "../components/ServiceNotice.svelte";
  import { connectivity } from "../lib/connectivity";
  import { botStatusChip, offlinePausedIds } from "../lib/offline-bots";
  import { onServiceReady, serviceStatus } from "../lib/service-status";
  import { Play, Pause, RotateCw, Pencil, Trash2, History, MessageSquare, Ellipsis, CircleAlert, X, CalendarClock, Cpu, Folder, PanelRight, Copy, FolderOpen, GitPullRequest, GitBranch, Zap, RefreshCw } from "@lucide/svelte";
  import { answerBotFrontier, approveBotCall, botHistory, botMessages, cancelBotRun, deleteBot, getBot, runBot, sendBotMessage, syncBotRepository, updateBot, botErrorText } from "../lib/api";
  import {
    NOTICE_ACTION_TEXT, RUN_STATUS_TEXT, askCards, botModeOf, autoStatus, botCompute, botPlacement, checksIn, routineText, botSubtitle, computeText, failureNotice, foldBotReply, folderName, formatCSats, prCards, readableSummary, reconcileRuns, relativeTime, runSourceText, shownReplyText, scheduleText,
    triggerStatusText, triggerText, frontierAsk, frontierSpendLine,
    type Bot, type BotMessage, type BotRun, type NoticeAction,
  } from "../lib/bots";
  import { open as openShell } from "@tauri-apps/plugin-shell";

  /** A GitHub link in the browser (only https links the app itself parsed from gh's output). */
  function openLink(url: string) {
    if (!/^https:\/\//.test(url)) return;
    openShell(url).catch(() => window.open(url, "_blank", "noopener"));
  }
  import type { ToolEvent } from "../lib/types";
  import { FAILURE_LINE, collapseFailures, splitModelError } from "../lib/failures";
  import { balanceState, neededCSatsIn, requestBuy, suggestedTopUpSats } from "../lib/buy-csats";
  import { choiceLabel } from "../lib/compute-choice";
  import { refreshBots } from "../lib/bots-store";
  import { NO_VISION, type AttachmentPayload } from "../lib/attachments";
  import PermissionModePicker from "../components/PermissionModePicker.svelte";
  import PlanApproval from "../components/PlanApproval.svelte";
  import { PLAN_APPROVED_MESSAGE, type EngineMode } from "../lib/permission-modes";

  interface Props {
    bot: Bot;
    onEdit: (bot: Bot) => void;
    onDeleted: () => void;
    onOpenPath?: (path: string) => void;
    onPreview?: (path: string) => void;
    /** Open a settings section ("plan" to buy cSats). */
    onOpenSettings?: (section: string) => void;
    /** Open the bot's folder as the editor's project. */
    onOpenFolder?: (path: string) => void;
  }
  let { bot, onEdit, onDeleted, onOpenPath, onPreview, onOpenSettings, onOpenFolder }: Props = $props();

  // The details panel: open on wide windows, remembered per viewer.
  const PANEL_KEY = "edgecoder-bot-panel";
  function loadPanel(): boolean {
    try {
      const v = localStorage.getItem(PANEL_KEY);
      if (v === "open" || v === "closed") return v === "open";
    } catch {
      // storage unavailable
    }
    return typeof window !== "undefined" && window.innerWidth >= 1200;
  }
  let panelOpen = $state(loadPanel());
  let panelTab = $state<"details" | "memory" | "folder">("details");
  let memory = $state<string | null>(null);
  let copied = $state(false);
  function togglePanel() {
    panelOpen = !panelOpen;
    menuOpen = false;
    try {
      localStorage.setItem(PANEL_KEY, panelOpen ? "open" : "closed");
    } catch {
      // storage unavailable
    }
  }
  // The bots list is polled every few seconds and every poll hands this page a new `bot` object, so
  // effects depend on these values (compared by value), never on the object itself: depending on
  // the object re-ran every effect on every poll (reloads, memory refetches, menu and scroll resets).
  const botId = $derived(bot.id);
  const updatedAt = $derived(bot.updatedAtMs);
  $effect(() => {
    const id = botId;
    void updatedAt;
    if (!panelOpen || panelTab !== "memory") return;
    getBot(id)
      .then((r) => {
        if (id === bot.id) memory = r.memory;
      })
      .catch(() => (memory = ""));
  });
  async function copyPath() {
    try {
      await navigator.clipboard.writeText(bot.projectRoot);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // clipboard unavailable
    }
  }
  /** Pending approvals are answered in the ask card, not in the tool block. */
  function withoutPendingBars(events: ToolEvent[]): ToolEvent[] {
    return events.map((e) => (e.type === "tool_call" && e.requires_approval && e.approval_status === "pending" ? { ...e, requires_approval: false } : e));
  }

  let menuOpen = $state(false);
  let menuEl: HTMLDivElement | undefined = $state();
  const DISMISSED_KEY = "edgecoder-bot-dismissed-failures";
  function loadDismissed(): string[] {
    try {
      return JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  }
  let dismissed = $state<string[]>(loadDismissed());
  function dismiss(runId: string) {
    dismissed = [...dismissed, runId].slice(-50);
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed));
    } catch {
      // private mode: dismissed for this session
    }
  }

  // Offline: a network-only bot says "Offline" (paused until the connection is back), not "Failed".
  const chip = $derived(botStatusChip(bot, $connectivity.state === "offline", offlinePausedIds()));
  // The header says what it's doing or when it next works on its own; the clock keeps "in 12 min" fresh.
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });
  const auto = $derived(autoStatus(bot, now));
  const compute = $derived(botCompute(bot));
  const computeLabel = $derived(computeText(compute, choiceLabel));
  const notice = $derived.by(() => {
    const n = failureNotice(bot);
    return n && !dismissed.includes(n.runId) ? n : null;
  });
  // Where the current (or last) run's model calls run: this machine, your other machines, the network or your key.
  const placement = $derived.by(() => {
    const runId = bot.lastRun?.id;
    const reply = runId ? [...messages].reverse().find((m) => m.role === "assistant" && m.runId === runId) : undefined;
    return reply ? botPlacement(reply.events, bot.lastRun?.cSats ?? 0) : null;
  });
  const budgetPct = $derived(bot.budgetCSatsPerDay ? Math.min(100, (bot.spentTodayCSats / bot.budgetCSatsPerDay) * 100) : 0);

  function buy() {
    requestBuy({ amountSats: suggestedTopUpSats({ budgetCSatsPerDay: bot.budgetCSatsPerDay, stepCSats: neededCSatsIn(bot.lastRun?.error) }), returnTo: bot.name });
    onOpenSettings?.("plan");
  }
  function noticeAction(a: NoticeAction) {
    if (a === "buy") buy();
    else if (a === "edit" || a === "budget") onEdit(bot);
    else void act(() => updateBot(bot.id, { compute: { policy: "local_only" } }));
  }

  function toggleMenu() {
    menuOpen = !menuOpen;
    if (menuOpen) queueMicrotask(() => menuEl?.querySelector<HTMLButtonElement>("button")?.focus());
    else confirmDelete = false;
  }
  function closeMenu() {
    menuOpen = false;
    confirmDelete = false;
  }
  function menuKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeMenu();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = [...(menuEl?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }
  }

  let messages = $state<BotMessage[]>([]);
  let runs = $state<BotRun[]>([]);
  /** The history as shown: it agrees with the details panel's Last run, and shows it before the history loads. */
  const shownRuns = $derived(reconcileRuns(runs, bot.lastRun));
  /**
   * The conversation as shown: a reply that is only a model error is a compact line, and the same
   * failure run after run is one line with a count, not a bubble per attempt.
   */
  const shownMessages = $derived(
    collapseFailures(
      messages,
      (m) => {
        if (m.role !== "assistant") return null;
        const turn = foldBotReply(m.events, []);
        const { text, error } = splitModelError(turn.text || m.content);
        return error && !text.trim() && !turn.toolEvents.length ? { id: m.id, error } : null;
      },
      (m) => m.role === "event",
    ),
  );
  /** The conversation and history have loaded once for this bot (until then there's no empty state). */
  let loaded = $state(false);
  let view = $state<"chat" | "history">("chat");
  let error = $state<string | null>(null);
  let confirmDelete = $state(false);
  let scrollEl: HTMLDivElement | undefined = $state();
  let botInput: ChatInput | undefined = $state();
  let lastCount = 0;

  const busy = $derived(bot.status === "running" || bot.status === "needs_approval");
  const pendingIds = $derived(bot.pending.map((p) => p.callId));

  async function load(id: string) {
    // Starting or restarting: ServiceNotice says so; this loads again once the service answers.
    if ($serviceStatus.phase !== "ready") return;
    try {
      const [m, h] = await Promise.all([botMessages(id), botHistory(id)]);
      if (id !== bot.id) return;
      messages = m;
      runs = h;
      loaded = true;
      // Follow the reply as it grows (new steps and streamed text), unless you scrolled up to read.
      const count = m.length + m.reduce((n, x) => n + (x.events?.length ?? 0) + x.content.length, 0);
      if (count !== lastCount) {
        const first = lastCount === 0;
        lastCount = count;
        const atBottom = !scrollEl || scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 120;
        if (first || atBottom) queueMicrotask(() => scrollEl?.scrollTo({ top: scrollEl.scrollHeight }));
      }
    } catch (err) {
      error = botErrorText(err);
    }
  }

  /** One load at a time: a request that's still out when the next is due is followed by one more, not stacked. */
  let inflight = false;
  let again = false;
  function reload() {
    if (inflight) {
      again = true;
      return;
    }
    inflight = true;
    void load(bot.id).finally(() => {
      inflight = false;
      if (again) {
        again = false;
        reload();
      }
    });
  }

  /** What the conversation and history depend on; a poll that changes none of it loads nothing. */
  const loadKey = $derived(`${bot.status}|${bot.lastRun?.id ?? ""}|${bot.lastRun?.status ?? ""}|${bot.pending.length}|${bot.queuedMessages}`);
  let shownId: string | null = null;
  // Load when the bot or its state changes, and poll while it works.
  $effect(() => {
    const id = botId;
    void loadKey;
    if (id !== shownId) {
      shownId = id;
      // Another bot: start clean.
      untrack(() => {
        confirmDelete = false;
        menuOpen = false;
        memory = null;
        error = null;
        messages = [];
        runs = [];
        loaded = false;
        lastCount = 0;
      });
    }
    untrack(reload);
    if (!busy) return;
    // While it works, the reply and its steps fill in live (one load at a time; see reload).
    const t = setInterval(reload, 1_000);
    return () => clearInterval(t);
  });

  $effect(() => onServiceReady(() => {
    error = null;
    reload();
  }));

  async function act(fn: () => Promise<unknown>) {
    error = null;
    try {
      await fn();
    } catch (err) {
      error = botErrorText(err);
    }
    await refreshBots();
    await load(bot.id);
  }

  /** A manual nudge (the overflow menu): it normally works on its own. */
  const checkNow = () => {
    closeMenu();
    return act(() => runBot(bot.id));
  };
  const stop = () => act(() => cancelBotRun(bot.id));
  const togglePause = () => {
    closeMenu();
    return act(() => updateBot(bot.id, { enabled: !bot.enabled }));
  };
  const toggleTrigger = (id: string | undefined) =>
    act(() => updateBot(bot.id, { triggers: (bot.triggers ?? []).map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t)) }));
  const retryRepo = () => act(() => syncBotRepository(bot.id));
  const send = (text: string, attachments?: AttachmentPayload[]) => act(() => sendBotMessage(bot.id, text, attachments));
  const approve = (callId: string, approved: boolean, always = false, forRun = false) =>
    act(() => (always ? approveBotCall(bot.id, callId, approved, true) : forRun ? approveBotCall(bot.id, callId, approved, false, true) : approveBotCall(bot.id, callId, approved)));
  // Its ask to use your frontier key (bot-frontier.ts on the server), and what that key spent today.
  const fAsk = $derived(frontierAsk(bot));
  const fSpend = $derived(frontierSpendLine(bot));
  const answerFrontier = (callId: string, choice: "run" | "day" | "decline") => act(() => answerBotFrontier(bot.id, callId, choice));
  // Its permission mode, kept with the bot (shown live: a change applies to its next call).
  let modeOverride = $state<{ id: string; mode: EngineMode } | null>(null);
  const mode = $derived<EngineMode>(modeOverride && modeOverride.id === bot.id ? modeOverride.mode : botModeOf(bot));
  $effect(() => {
    // The bot's own value caught up: drop the optimistic one.
    if (modeOverride && modeOverride.id === bot.id && botModeOf(bot) === modeOverride.mode) modeOverride = null;
  });
  const setMode = (m: EngineMode) => {
    modeOverride = { id: bot.id, mode: m };
    return act(() => updateBot(bot.id, { mode: m }));
  };
  /** Its last reply is a plan waiting for approval (still in Plan mode, not working). */
  const lastSaid = $derived([...messages].reverse().find((m) => m.role !== "event"));
  const pendingPlan = $derived(!busy && mode === "plan" && lastSaid?.role === "assistant" && (lastSaid.content ?? "").trim() !== "");
  async function approvePlan(next: EngineMode) {
    await setMode(next);
    await send(PLAN_APPROVED_MESSAGE);
  }
  async function remove() {
    if (!confirmDelete) {
      confirmDelete = true;
      return;
    }
    closeMenu();
    await act(() => deleteBot(bot.id));
    onDeleted();
  }

  function when(ms: number) {
    return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function duration(r: BotRun) {
    if (!r.endedAtMs) return "…";
    const s = Math.round((r.endedAtMs - r.startedAtMs) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }
</script>

{#snippet moreMenu()}
  <div class="more">
    <button class="icon" onclick={toggleMenu} aria-haspopup="menu" aria-expanded={menuOpen} aria-label="More actions" title="More actions"><Ellipsis size={16} /></button>
    {#if menuOpen}
      <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
      <div class="menu-backdrop" onclick={closeMenu}></div>
      <div class="menu" role="menu" tabindex="-1" bind:this={menuEl} onkeydown={menuKey}>
        <!-- Pausing is a secondary control: a bot just works on its own. -->
        <button role="menuitem" onclick={togglePause} title={bot.enabled ? "Stop working on its own (messages still get answers)" : "Start working on its own again"}>{#if bot.enabled}<Pause size={14} /> Pause {bot.name}{:else}<Play size={14} /> Resume {bot.name}{/if}</button>
        <button role="menuitem" onclick={checkNow} disabled={busy || bot.status === "over_budget"} title={bot.status === "over_budget" ? "Today's budget is spent" : `Have ${bot.name} check in now instead of waiting`}><RotateCw size={14} /> Check now</button>
        <button role="menuitem" onclick={() => { closeMenu(); onEdit(bot); }}><Pencil size={14} /> Edit</button>
        <button role="menuitem" class="danger" onclick={remove}><Trash2 size={14} /> {confirmDelete ? "Click again to delete" : "Delete"}</button>
      </div>
    {/if}
  </div>
{/snippet}

<div class="bot-view">
 <div class="bot-main">
  <header class="bot-head">
    <BotAvatar name={bot.name} color={bot.color} shape={bot.avatarShape} status={bot.status} size={36} />
    <div class="who">
      <div class="line1">
        <h2 class="name">{bot.name}{#if bot.role}<span class="role"> · {bot.role}</span>{/if}</h2>
        <span class="chip {chip.tone}" data-testid="bot-status-chip" title={bot.activity ?? chip.text}>{chip.text}</span>
      </div>
      {#if panelOpen}
        <div class="meta status-line" data-testid="bot-subtitle" title={botSubtitle(bot)}>{botSubtitle(bot)}</div>
      {:else}
      <div class="meta" data-testid="bot-meta">
        <span class="m" title="Routine"><CalendarClock size={12} />{routineText(bot)}{!bot.enabled && (bot.schedule || checksIn(bot)) ? " · paused" : ""}</span>
        <span class="sep" aria-hidden="true">·</span>
        <span class="m budget" title="cSats spent today against the daily budget">
          {#if bot.budgetCSatsPerDay != null}
            <span class="meter" role="meter" aria-label="Daily budget used" aria-valuemin="0" aria-valuemax={bot.budgetCSatsPerDay} aria-valuenow={bot.spentTodayCSats}><span style="width: {budgetPct}%"></span></span>
            {formatCSats(bot.spentTodayCSats)} / {formatCSats(bot.budgetCSatsPerDay)} cSats today
          {:else}
            {formatCSats(bot.spentTodayCSats)} cSats today · no limit
          {/if}
        </span>
        {#if fSpend}
          <span class="sep" aria-hidden="true">·</span>
          <span class="m" title="Estimated spend on your own frontier key today (the provider bills you)" data-testid="bot-frontier-spend">{fSpend}</span>
        {/if}
        <span class="sep" aria-hidden="true">·</span>
        <span class="m" title="Compute: where its model calls run (change it in Edit)"><Cpu size={12} />{computeLabel}</span>
        {#if placement}
          <span class="sep" aria-hidden="true">·</span>
          <span class="m placement" data-testid="bot-placement" title={placement}><span class="placement-text">{busy ? "Running on" : "Last ran on"}: {placement}</span></span>
        {/if}
        <span class="sep" aria-hidden="true">·</span>
        {#if bot.repository}
          <span class="m folder" title={bot.repoPath ?? bot.repository}><GitBranch size={12} /><span class="folder-name">{bot.repository}</span></span>
        {:else}
          <span class="m folder" title={bot.projectRoot}><Folder size={12} /><span class="folder-name">{folderName(bot.projectRoot)}</span></span>
        {/if}
      </div>
      {/if}
    </div>
    <div class="actions">
      <span class="auto-status {auto.tone}" role="status" aria-live="polite" data-testid="bot-auto-status">{auto.text}</span>
      {#if !panelOpen}{@render moreMenu()}{/if}
      <button class="icon" class:on={panelOpen} onclick={togglePanel} aria-pressed={panelOpen} aria-label={panelOpen ? "Hide details" : "Show details"} title={panelOpen ? "Hide details" : "Show details"}><PanelRight size={16} /></button>
    </div>
  </header>

  <!-- #24: bits-ui Tabs; the root is display: contents so the column layout is unchanged. -->
  <Tabs.Root class="contents" bind:value={view}>
  <Tabs.List aria-label="Bot views">
    {#snippet child({ props })}
      <div {...props} class="tabs">
        <Tabs.Trigger value="chat"><MessageSquare size={13} /> Conversation</Tabs.Trigger>
        <Tabs.Trigger value="history"><History size={13} /> Runs ({shownRuns.length})</Tabs.Trigger>
      </div>
    {/snippet}
  </Tabs.List>

  {#if $serviceStatus.phase !== "ready"}
    <ServiceNotice />
  {:else if error}<div class="error" role="alert">{error}</div>{/if}

  {#if bot.setup}
    <!-- Made on the web: nothing runs until a folder is chosen here (#409). -->
    <BotFolderSetup {bot} onDone={() => void refreshBots()} />
  {/if}

  {#if view === "chat" && notice}
    <div class="notice" role="status" data-testid="bot-failure-notice">
      <CircleAlert size={15} />
      <div class="notice-text">
        <div class="notice-title">{notice.title}</div>
        <div class="notice-detail">{notice.detail}</div>
      </div>
      <div class="notice-actions">
        {#each notice.actions.filter((a) => a !== "buy" || onOpenSettings) as a, i (a)}
          <button class:primary={i === 0 && a === "buy"} onclick={() => noticeAction(a)}>{NOTICE_ACTION_TEXT[a]}</button>
        {/each}
      </div>
      <button class="notice-close" onclick={() => dismiss(notice.runId)} aria-label="Dismiss" title="Dismiss"><X size={14} /></button>
    </div>
  {/if}

  {#if view === "chat"}
    <Tabs.Content value="chat">
    {#snippet child({ props })}
    <div {...props} class="messages" bind:this={scrollEl}>
      {#if !loaded}
        <div class="empty"><p>Loading…</p></div>
      {:else if messages.length === 0}
        <div class="empty">
          <BotAvatar name={bot.name} color={bot.color} shape={bot.avatarShape} status={bot.status} size={72} decorative />
          {#if bot.lastRun}
            <p data-testid="bot-last-run-note">{bot.name} last worked {relativeTime(bot.lastRun.startedAtMs, now)}{bot.lastRun.summary ? `: ${readableSummary(bot.lastRun.summary)}` : ""}. Its runs are under Runs.</p>
          {/if}
          <p>{bot.enabled && bot.nextRun ? `${bot.name} works on its own: ${auto.text.toLowerCase()}.` : bot.enabled ? `Message ${bot.name} to get it started.` : `${bot.name} is paused. Resume it from the ⋯ menu, or message it.`} {bot.schedule || checksIn(bot) ? `${routineText(bot)}.` : ""}</p>
        </div>
      {/if}
      {#each shownMessages as row (row.kind === "item" ? row.item.id : `failure-${row.id}`)}
        {#if row.kind === "failure"}
          <!-- A failed run: one compact line (repeats collapsed); the banner above has the story and the action. -->
          <div class="failure-line" data-testid="bot-failure-line" title={row.error}>{FAILURE_LINE[row.failure]}{#if row.count > 1}{" "}<span class="times">×{row.count}</span>{/if}</div>
        {:else}
        {@const m = row.item}
        {#if m.role === "event"}
          <div class="event">{m.content} · {when(m.atMs)}</div>
        {:else if m.role === "user"}
          <ChatMessage role="user" content={m.content} />
        {:else}
          {@const turn = foldBotReply(m.events, pendingIds)}
          {@const run = shownRuns.find((r) => r.id === m.runId)}
          {@const cards = askCards(turn.toolEvents, bot.name)}
          <div class="bot-turn">
            <BotAvatar name={bot.name} color={bot.color} shape={bot.avatarShape} status={run?.status === "running" ? "running" : "idle"} mood={run?.status === "running" ? "working" : run?.status === "needs_approval" ? "needs" : run?.status === "failed" ? "failed" : "idle"} size={26} decorative />
            <div class="bot-turn-body">
              <ChatMessage
                role="assistant"
                content={shownReplyText(splitModelError(turn.text).text)}
                streaming={run?.status === "running" || run?.status === "needs_approval"}
                toolEvents={withoutPendingBars(turn.toolEvents)}
                turnId={turn.turnId}
                changedFiles={turn.changedFiles}
                usage={run ? { cSats: run.cSats, where: run.where, ...(turn.usage?.calls ? { calls: turn.usage.calls } : {}) } : turn.usage}
                web={turn.web}
                activity={turn.activity}
                onToolApproval={approve}
                {onOpenPath}
                {onPreview}
              />
              {#each cards as c (c.id)}
                <div class="ask-card" class:waiting={!c.answer} data-testid="ask-card">
                  <div class="ask-q">{c.question}</div>
                  {#if c.pr}
                    <div class="pr-ask" data-testid="pr-ask">
                      <div class="pr-ask-title">{c.pr.title}</div>
                      <div class="pr-ask-branch"><GitBranch size={12} /> <code>{c.pr.branch}</code> → <code>{c.pr.base}</code>{#if c.pr.commits} · {c.pr.commits} commit{c.pr.commits === 1 ? "" : "s"}{/if}</div>
                      {#if c.pr.body}<div class="pr-ask-body">{c.pr.body}</div>{/if}
                      {#if c.pr.diffstat}<code class="ask-detail">{c.pr.diffstat}</code>{/if}
                      {#if c.pr.uncommitted}<div class="pr-ask-note">{c.pr.uncommitted} uncommitted file{c.pr.uncommitted === 1 ? "" : "s"} won't be in the pull request.</div>{/if}
                    </div>
                  {/if}
                  {#if c.call}
                    <!-- Waiting for an answer: every argument in full (file content, commit files), not a one-line summary. -->
                    <ToolArgs tool={c.call.tool} args={c.call.args} />
                  {:else if c.detail}<code class="ask-detail">{c.detail}</code>{/if}
                  {#if c.answer}
                    <div class="ask-answer" class:denied={c.answer === "Denied"}>You: {c.answer}</div>
                  {:else}
                    {#if c.webGuard}<div class="ask-note" data-testid="web-guard-note">Asked because this run read a web page. Its mode would run it without asking.</div>{/if}
                    <div class="ask-choices">
                      <button class="primary" onclick={() => approve(c.id, true)}>Allow</button>
                      {#if c.webGuard}
                        <button class="always" onclick={() => approve(c.id, true, false, true)} title="Calls its permission mode runs anyway stop asking until this run ends. Anything the mode asks about still asks.">Allow for the rest of this run</button>
                      {/if}
                      {#if c.rules?.length}
                        <button class="always" onclick={() => approve(c.id, true, true)} title="Commands starting with this run without asking in this project. Remove it in Settings → General → Always-allowed commands.">Always allow {#each c.rules as r, i (r)}{i ? ", " : ""}<code>{r.replace(/:\*$/, " …")}</code>{/each} in this project</button>
                      {/if}
                      <button onclick={() => approve(c.id, false)}>Deny</button>
                    </div>
                  {/if}
                </div>
              {/each}
              {#each prCards(turn.toolEvents) as p (p.id)}
                <div class="pr-card" data-testid="pr-card">
                  <GitPullRequest size={18} />
                  <div class="pr-card-text">
                    <div class="pr-card-title">Pull request #{p.number}{p.title ? `: ${p.title}` : ""}</div>
                    <div class="pr-card-sub">{p.branch}{p.base ? ` → ${p.base}` : ""}</div>
                  </div>
                  <button onclick={() => openLink(p.url)} title={p.url}>Open on GitHub</button>
                </div>
              {/each}
            </div>
          </div>
        {/if}
        {/if}
      {/each}
      {#if fAsk}
        <!-- Before it uses your frontier key: you approve each use (or every run today), or it carries on without it. -->
        <div class="ask-card waiting" data-testid="frontier-ask-card" role="group" aria-label="{bot.name} asks: {fAsk.question}">
          <div class="ask-q">{bot.name} asks: {fAsk.question}</div>
          <div class="ask-detail-text">It leads with your own key (billed to you by the provider), and its usual compute does the rest. No answer in 30 minutes: it carries on without it.</div>
          <div class="ask-choices">
            <button class="primary" onclick={() => answerFrontier(fAsk.callId, "run")}>Approve this run</button>
            <button onclick={() => answerFrontier(fAsk.callId, "day")}>Approve for today</button>
            <button onclick={() => answerFrontier(fAsk.callId, "decline")}>Decline</button>
          </div>
        </div>
      {/if}
      {#if pendingPlan}
        <PlanApproval onApprove={(m) => void approvePlan(m)} onRevise={() => botInput?.focus()} />
      {/if}
      <QuoteSelection scope={scrollEl} onQuote={(b) => void botInput?.insertQuote(b)} />
    </div>
    {/snippet}
    </Tabs.Content>
  {:else}
    <Tabs.Content value="history">
    {#snippet child({ props })}
    <div {...props} class="history">
      {#if shownRuns.length === 0}
        <div class="empty"><p>{loaded ? "No runs yet." : "Loading…"}</p></div>
      {:else}
        <table>
          <thead><tr><th>Started</th><th>Trigger</th><th>Status</th><th>Summary</th><th class="num">cSats</th><th>Ran on</th><th class="num">Time</th></tr></thead>
          <tbody>
            {#each shownRuns as r (r.id)}
              <tr>
                <td>{when(r.startedAtMs)}</td>
                <td class="src" title={runSourceText(r)}>{runSourceText(r)}</td>
                <td class="st {r.status}">{RUN_STATUS_TEXT[r.status]}</td>
                <td class="sum" title={r.summary}>
                  {readableSummary(r.summary)}
                  {#each r.pullRequests ?? [] as p (p.url)}
                    <button class="link pr-link" onclick={() => openLink(p.url)} title={p.url}><GitPullRequest size={12} /> PR #{p.number}</button>
                  {/each}
                </td>
                <td class="num">{formatCSats(r.cSats)}</td>
                <td>{r.where ?? (r.status === "failed" ? "Didn't run" : "—")}{#if r.note}<div class="run-note">{r.note}</div>{/if}</td>
                <td class="num">{duration(r)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
    {/snippet}
    </Tabs.Content>
  {/if}
  </Tabs.Root>

  {#if !bot.setup}
  <div class="composer">
    <!-- Working: the send arrow is Stop (no Stop in the header); Enter still sends, and the bot takes it next.
         queue={[]}: the bot keeps its own queue, so messages go to it at once. Bot models never
         get images or PDFs (even with a frontier lead): those are saved in its folder by name. -->
    <ChatInput
      bind:this={botInput}
      onSend={send}
      streaming={busy}
      onStop={stop}
      queue={[]}
      attach={{ vision: NO_VISION, who: bot.name, savedToFolder: true }}
      placeholder={busy ? `${bot.name} is working; your message goes next…` : `Message ${bot.name}`}
    >
      {#snippet controls()}
        <PermissionModePicker {mode} onChange={(m) => void setMode(m)} />
      {/snippet}
    </ChatInput>
  </div>
  {/if}
 </div>

 {#if panelOpen}
  <aside class="details" aria-label="{bot.name} details" data-testid="bot-details">
    <div class="d-top">
      {@render moreMenu()}
    </div>
    <div class="d-who">
      <BotAvatar name={bot.name} color={bot.color} shape={bot.avatarShape} status={bot.status} size={76} />
      <div class="d-name">{bot.name}</div>
      {#if bot.role}<div class="d-role">{bot.role}</div>{/if}
      <span class="chip {chip.tone}">{chip.text}</span>
    </div>
    <Tabs.Root class="contents" bind:value={panelTab}>
    <Tabs.List aria-label="Details">
      {#snippet child({ props })}
        <div {...props} class="d-tabs">
          {#each [["details", "Details"], ["memory", "Memory"], ["folder", "Folder"]] as [id, label] (id)}
            <Tabs.Trigger value={id}>{label}</Tabs.Trigger>
          {/each}
        </div>
      {/snippet}
    </Tabs.List>
    <Tabs.Content value={panelTab}>
    {#snippet child({ props })}
    <div {...props} class="d-body">
      {#if panelTab === "details"}
        <div class="d-section">
          <div class="d-label">Routines</div>
          {#if bot.schedule}
            <div class="routine">
              <CalendarClock size={15} />
              <div class="routine-text">
                <div class="routine-title">{scheduleText(bot.schedule)}</div>
                <div class="routine-sub">{bot.enabled ? (bot.nextRunAtMs ? `Next run ${relativeTime(bot.nextRunAtMs)}` : "On") : "Paused: answers messages only"}</div>
              </div>
              <button class="switch" role="switch" aria-checked={bot.enabled} aria-label="Run {scheduleText(bot.schedule).toLowerCase()}" onclick={togglePause}></button>
            </div>
          {:else if checksIn(bot)}
            <div class="routine">
              <CalendarClock size={15} />
              <div class="routine-text">
                <div class="routine-title">{routineText(bot)}</div>
                <div class="routine-sub">{bot.enabled ? `${auto.text}${(bot.auto?.idleStreak ?? 0) > 0 ? " · waiting longer while nothing changes" : ""}` : "Paused: answers messages only"}</div>
              </div>
              <button class="switch" role="switch" aria-checked={bot.enabled} aria-label="{routineText(bot)}" onclick={togglePause}></button>
            </div>
          {:else}
            <div class="routine empty-routine">
              <div class="routine-text"><div class="routine-sub">No routine: give it a role or instructions and it checks in on its own, or add a schedule.</div></div>
              <button class="link" onclick={() => onEdit(bot)}>Add one</button>
            </div>
          {/if}
        </div>
        <div class="d-section" data-testid="bot-triggers-panel">
          <div class="d-label">Triggers</div>
          {#if (bot.triggers ?? []).length}
            {#each bot.triggers ?? [] as t (t.id)}
              <div class="routine">
                <Zap size={15} />
                <div class="routine-text">
                  <div class="routine-title">{triggerText(t)}</div>
                  <div class="routine-sub">{!bot.enabled && t.enabled ? "Paused with the bot" : triggerStatusText(t.id ? bot.triggerStatus?.[t.id] : undefined, t.enabled)}</div>
                </div>
                <button class="switch" role="switch" aria-checked={t.enabled} aria-label="Trigger: {triggerText(t)}" onclick={() => toggleTrigger(t.id)}></button>
              </div>
            {/each}
            {#if bot.queuedEvents}<div class="d-sub muted">{bot.queuedEvents} event{bot.queuedEvents === 1 ? "" : "s"} waiting for the current run</div>{/if}
          {:else}
            <div class="routine empty-routine">
              <div class="routine-text"><div class="routine-sub">{bot.repository ? "No triggers: add one to run on PRs, CI failures or labeled issues." : "Set a repository to run on GitHub events."}</div></div>
              <button class="link" onclick={() => onEdit(bot)}>Add one</button>
            </div>
          {/if}
        </div>
        {#if bot.repository}
          <div class="d-section">
            <div class="d-label">Repository</div>
            <div class="d-row"><GitBranch size={14} /><span class="d-val" title={bot.repository}>{bot.repository}</span>
              {#if bot.repo?.state !== "cloning"}<button class="link" onclick={retryRepo} title="Clone or update it now"><RefreshCw size={12} /> {bot.repo?.state === "error" ? "Retry" : "Update"}</button>{/if}
            </div>
            {#if bot.repo}<div class="d-sub" class:muted={bot.repo.state !== "error"} class:repo-err={bot.repo.state === "error"}>{bot.repo.message}</div>{/if}
          </div>
        {/if}
        <div class="d-section">
          <div class="d-label">Compute</div>
          <div class="d-row"><Cpu size={14} /><span class="d-val">{computeLabel}</span><button class="link" onclick={() => onEdit(bot)}>Change</button></div>
        </div>
        {#if $balanceState.low && onOpenSettings}
          <div class="d-section low" data-testid="bot-running-low">
            <span>Running low: {formatCSats($balanceState.cSats ?? 0)} cSats left.</span>
            <button class="link" onclick={buy}>Buy cSats</button>
          </div>
        {/if}
        <div class="d-section">
          <div class="d-label">Budget today</div>
          {#if bot.budgetCSatsPerDay != null}
            <div class="d-meter" role="meter" aria-label="Daily budget used" aria-valuemin="0" aria-valuemax={bot.budgetCSatsPerDay} aria-valuenow={bot.spentTodayCSats}><span style="width: {budgetPct}%"></span></div>
            <div class="d-sub">{formatCSats(bot.spentTodayCSats)} of {formatCSats(bot.budgetCSatsPerDay)} cSats</div>
          {:else}
            <div class="d-sub">{formatCSats(bot.spentTodayCSats)} cSats · no limit</div>
          {/if}
          {#if fSpend}<div class="d-sub" data-testid="bot-frontier-spend-detail">{fSpend} (your key)</div>{/if}
        </div>
        {#if bot.lastRun}
          <div class="d-section">
            <div class="d-label">Last run</div>
            <div class="d-sub">{RUN_STATUS_TEXT[bot.lastRun.status]} · {relativeTime(bot.lastRun.startedAtMs)}{bot.lastRun.where ? ` · ${bot.lastRun.where}` : ""}</div>
            {#if bot.lastRun.note}<div class="d-sub muted">{bot.lastRun.note}</div>{/if}
          </div>
        {/if}
      {:else if panelTab === "memory"}
        <div class="d-section">
          <div class="d-label">Notes it saved for itself</div>
          {#if memory === null}
            <div class="d-sub muted">Loading…</div>
          {:else if memory.trim()}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <pre class="memory" tabindex="0" aria-label="Bot memory">{memory}</pre>
          {:else}
            <div class="d-sub muted">Nothing yet. It saves notes with its remember tool as it works.</div>
          {/if}
          <button class="link" onclick={() => onEdit(bot)}>Edit memory</button>
        </div>
      {:else}
        {#if bot.repository && bot.repoPath}
          <div class="d-section">
            <div class="d-label">Repository checkout</div>
            <code class="path">{bot.repoPath}</code>
            <div class="d-actions">
              {#if onOpenFolder}<button onclick={() => onOpenFolder?.(bot.repoPath!)}><FolderOpen size={14} /> Open in editor</button>{/if}
            </div>
          </div>
        {/if}
        <div class="d-section">
          <div class="d-label">Home folder</div>
          <code class="path">{bot.projectRoot}</code>
          {#if bot.repository}<div class="d-sub muted">Its notes and memory (memory.md) live here.</div>{/if}
          <div class="d-actions">
            {#if onOpenFolder}<button onclick={() => onOpenFolder?.(bot.projectRoot)}><FolderOpen size={14} /> Open in editor</button>{/if}
            <button onclick={copyPath}><Copy size={14} /> {copied ? "Copied" : "Copy path"}</button>
          </div>
        </div>
      {/if}
    </div>
    {/snippet}
    </Tabs.Content>
    </Tabs.Root>
  </aside>
 {/if}
</div>

<style>
  .bot-view {
    flex: 1;
    display: flex;
    min-height: 0;
    min-width: 0;
  }
  .bot-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }
  .status-line {
    text-overflow: ellipsis;
  }
  .actions button.icon.on {
    color: var(--accent);
  }
  /* --- conversation --- */
  .bot-turn {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }
  .bot-turn > :global(.bot-avatar) {
    margin-top: 10px;
  }
  .bot-turn-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .ask-card {
    max-width: 520px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    border: 0.5px solid var(--border-strong);
    border-radius: 14px;
    background: var(--bg-surface);
    margin-bottom: 8px;
  }
  .ask-card.waiting {
    border-color: color-mix(in srgb, var(--yellow) 55%, transparent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--yellow) 12%, transparent);
  }
  .ask-q {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .ask-detail {
    display: block;
    padding: 6px 9px;
    border-radius: 8px;
    background: var(--bg-base);
    font-family: var(--font-mono);
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-primary);
  }
  .ask-detail-text {
    font-size: 12px;
    color: var(--text-secondary);
  }
  .ask-choices {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .ask-choices button {
    padding: 6px 14px;
    border-radius: 999px;
    border: 0.5px solid var(--border-strong);
    background: var(--bg-base);
    color: var(--text-primary);
    font-size: 12.5px;
    cursor: pointer;
  }
  .ask-note {
    font-size: 12px;
    color: var(--text-secondary);
  }
  .ask-choices button.always code {
    font-size: 11.5px;
  }
  .ask-choices button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
    font-weight: 600;
  }
  .ask-choices button:focus-visible,
  .d-tabs :global(button:focus-visible),
  .details button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .ask-answer {
    align-self: flex-end;
    padding: 4px 12px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--green) 12%, transparent);
    color: var(--green);
    font-size: 12px;
    font-weight: 600;
  }
  .ask-answer.denied {
    background: color-mix(in srgb, var(--danger) 14%, transparent);
    color: var(--red-strong);
  }
  .pr-ask {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .pr-ask-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .pr-ask-branch,
  .pr-ask-note {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .pr-ask-body {
    max-height: 160px;
    overflow-y: auto;
    padding: 6px 9px;
    border-radius: 8px;
    border: 0.5px solid var(--border);
    font-size: 12.5px;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-primary);
  }
  .pr-card {
    max-width: 520px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border: 0.5px solid color-mix(in srgb, var(--green) 50%, transparent);
    border-radius: 14px;
    background: color-mix(in srgb, var(--green) 8%, var(--bg-surface));
    color: var(--green);
    margin-bottom: 8px;
  }
  .pr-card-text {
    flex: 1;
    min-width: 0;
  }
  .pr-card-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pr-card-sub {
    font-size: 12px;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pr-card button {
    padding: 5px 12px;
    border-radius: 999px;
    border: 0.5px solid var(--border-strong);
    background: var(--bg-base);
    color: var(--text-primary);
    font-size: 12px;
    cursor: pointer;
  }
  .pr-card button:focus-visible,
  .pr-link:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .pr-link {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-left: 6px;
  }
  td.src {
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .repo-err {
    color: var(--danger);
  }
  /* --- details panel --- */
  .details {
    flex-shrink: 0;
    width: 280px;
    display: flex;
    flex-direction: column;
    border-left: 0.5px solid var(--border);
    background: var(--bg-deep);
    overflow-y: auto;
  }
  .d-top {
    display: flex;
    justify-content: flex-end;
    padding: 8px 10px 0;
  }
  .d-top .more > button {
    display: inline-flex;
    padding: 5px 6px;
    border: none;
    border-radius: 7px;
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .d-top .more > button:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .d-top .menu button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-primary);
    font-size: 12.5px;
    border-radius: 7px;
    cursor: pointer;
  }
  .d-top .menu button.danger {
    color: var(--danger);
  }
  .d-who {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 4px 16px 14px;
    text-align: center;
  }
  .d-name {
    margin-top: 6px;
    font-size: 16px;
    font-weight: 600;
  }
  .d-role {
    font-size: 12.5px;
    color: var(--text-secondary);
  }
  .d-tabs {
    display: flex;
    gap: 2px;
    margin: 0 12px;
    padding: 2px;
    border-radius: 9px;
    background: var(--bg-base);
    border: 0.5px solid var(--border);
  }
  .d-tabs :global(button) {
    flex: 1;
    padding: 5px 8px;
    border: none;
    border-radius: 7px;
    background: none;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
  }
  .d-tabs :global(button[data-state="active"]) {
    background: var(--bg-surface);
    color: var(--text-primary);
    box-shadow: var(--shadow-sm);
  }
  .d-body {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 14px 16px 20px;
  }
  .d-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .d-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
  }
  .d-sub {
    font-size: 12.5px;
    color: var(--text-primary);
  }
  .d-sub.muted {
    color: var(--text-secondary);
  }
  .d-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: var(--text-secondary);
  }
  .d-val {
    flex: 1;
    min-width: 0;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .d-meter {
    height: 6px;
    border-radius: 3px;
    background: var(--border);
    overflow: hidden;
  }
  .d-meter > span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .routine {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border: 0.5px solid var(--border);
    border-radius: 10px;
    background: var(--bg-surface);
    color: var(--text-secondary);
  }
  .routine-text {
    flex: 1;
    min-width: 0;
  }
  .routine-title {
    font-size: 13px;
    color: var(--text-primary);
  }
  .routine-sub {
    font-size: 11.5px;
    color: var(--text-secondary);
  }
  .switch {
    position: relative;
    flex-shrink: 0;
    width: 34px;
    height: 20px;
    border-radius: 999px;
    border: none;
    padding: 0;
    background: var(--border-control);
    cursor: pointer;
  }
  .switch::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--bg-surface);
    transition: transform 0.15s;
  }
  .switch[aria-checked="true"] {
    background: var(--green);
  }
  .switch[aria-checked="true"]::after {
    transform: translateX(14px);
  }
  .link {
    border: none;
    background: none;
    padding: 0;
    color: var(--accent);
    font-size: 12px;
    cursor: pointer;
    align-self: flex-start;
  }
  .memory {
    margin: 0;
    padding: 10px;
    border-radius: 8px;
    background: var(--bg-base);
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 360px;
    overflow: auto;
  }
  .path {
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--bg-base);
    font-family: var(--font-mono);
    font-size: 11.5px;
    word-break: break-all;
  }
  .d-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .d-actions button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border: 0.5px solid var(--border-strong);
    border-radius: 8px;
    background: var(--bg-base);
    color: var(--text-primary);
    font-size: 12px;
    cursor: pointer;
  }
  @media (prefers-reduced-motion: reduce) {
    .switch::after {
      transition: none;
    }
  }
  /* Narrow windows: the panel overlays the conversation instead of squeezing it. */
  @media (max-width: 980px) {
    .bot-view {
      position: relative;
    }
    .details {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      z-index: 30;
      box-shadow: var(--shadow-lg);
    }
  }
  .bot-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 20px;
    border-bottom: 0.5px solid var(--border);
    min-width: 0;
  }
  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .line1 {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .name {
    margin: 0;
    font-size: 14.5px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .role {
    font-weight: 400;
    color: var(--text-secondary);
  }
  .chip {
    flex-shrink: 0;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    border: 0.5px solid var(--border);
    color: var(--text-secondary);
  }
  .chip.accent {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .chip.warn {
    color: var(--yellow);
    border-color: color-mix(in srgb, var(--yellow) 45%, transparent);
    background: color-mix(in srgb, var(--yellow) 10%, transparent);
  }
  .chip.err {
    color: var(--red-strong);
    border-color: color-mix(in srgb, var(--danger) 45%, transparent);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: 11.5px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
  }
  .meta .m {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  .meta .folder {
    flex-shrink: 1;
    min-width: 0;
  }
  .folder-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .placement {
    min-width: 0;
  }
  .placement-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta .sep {
    flex-shrink: 0;
    color: var(--text-muted);
  }
  .meter {
    display: inline-block;
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--border);
    overflow: hidden;
  }
  .meter > span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .actions {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .actions button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 11px;
    border: 0.5px solid var(--border-strong);
    border-radius: 8px;
    background: var(--bg-base);
    color: var(--text-primary);
    font-size: 12.5px;
    cursor: pointer;
    white-space: nowrap;
  }
  .actions button:hover:not(:disabled) {
    border-color: var(--text-secondary);
  }
  .actions button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  /* What it's doing or when it next works on its own (replaces the old "Run now" button). */
  .auto-status {
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .auto-status.accent {
    color: var(--accent);
  }
  .auto-status.warn {
    color: var(--yellow);
  }
  .auto-status.err {
    color: var(--red-strong);
  }
  .menu button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .actions button.icon {
    padding: 6px 7px;
  }
  .more {
    position: relative;
  }
  .menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
  }
  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: 41;
    min-width: 180px;
    display: flex;
    flex-direction: column;
    padding: 4px;
    background: var(--bg-elevated);
    border: 0.5px solid var(--border);
    border-radius: 10px;
    box-shadow: var(--shadow-lg);
  }
  .menu button {
    border: none;
    background: none;
    justify-content: flex-start;
    width: 100%;
    padding: 7px 9px;
  }
  .menu button:hover,
  .menu button:focus-visible {
    background: var(--bg-surface);
    outline: none;
  }
  .menu button.danger {
    color: var(--danger);
  }
  .notice {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin: 10px 20px 0;
    padding: 10px 12px;
    border: 0.5px solid color-mix(in srgb, var(--danger) 40%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--danger) 7%, var(--bg-surface));
    color: var(--danger);
    font-size: 12.5px;
  }
  .notice-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .notice-title {
    color: var(--text-primary);
    font-weight: 600;
  }
  .notice-detail {
    color: var(--text-secondary);
    line-height: 1.45;
  }
  .notice-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: flex-end;
  }
  .notice-actions button {
    padding: 4px 10px;
    border: 0.5px solid var(--border-strong);
    border-radius: 7px;
    background: var(--bg-base);
    color: var(--text-primary);
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .notice-actions button:hover {
    border-color: var(--text-secondary);
  }
  .notice-actions button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .failure-line {
    text-align: center;
    font-size: 11.5px;
    color: var(--text-muted);
    padding: 6px 0;
  }
  .failure-line .times {
    font-variant-numeric: tabular-nums;
  }
  .d-section.low {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .notice-close {
    border: none;
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 2px;
    border-radius: 6px;
  }
  .notice-close:hover {
    color: var(--text-primary);
    background: var(--bg-base);
  }
  .run-note {
    font-size: 11px;
    color: var(--text-muted);
  }
  .tabs {
    display: flex;
    gap: 2px;
    padding: 6px 16px 0;
  }
  .tabs :global(button) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border: none;
    border-radius: 7px;
    background: none;
    color: var(--text-secondary);
    font-size: 12.5px;
    cursor: pointer;
  }
  .tabs :global(button[data-state="active"]) {
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .error {
    margin: 8px 20px 0;
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 12.5px;
    color: var(--red-strong);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
  }
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 20px 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 20px;
  }
  .messages > :global(*) {
    width: 100%;
    max-width: 760px;
  }
  .event {
    text-align: center;
    font-size: 11.5px;
    color: var(--text-muted);
    padding: 10px 0 4px;
  }
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: var(--text-secondary);
    text-align: center;
  }
  .history {
    flex: 1;
    overflow: auto;
    padding: 12px 20px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
  }
  th,
  td {
    text-align: left;
    padding: 8px 10px;
    border-top: 0.5px solid var(--border);
    vertical-align: top;
  }
  thead th {
    border-top: none;
    color: var(--text-secondary);
    font-weight: 500;
    font-size: 11.5px;
  }
  td.num,
  th.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  td.sum {
    max-width: 360px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  td.st.done {
    color: var(--green);
  }
  td.st.failed,
  td.st.interrupted {
    color: var(--danger);
  }
  td.st.needs_approval,
  td.st.budget {
    color: var(--yellow);
  }
  .composer {
    flex-shrink: 0;
    display: flex;
    justify-content: center;
    padding: 8px 20px 16px;
  }
  .composer > :global(*) {
    width: 100%;
    max-width: 820px;
  }
</style>
