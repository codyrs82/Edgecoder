<script lang="ts">
  import ChatMessage from "../components/ChatMessage.svelte";
  import ChatInput from "../components/ChatInput.svelte";
  import BotAvatar from "../components/BotAvatar.svelte";
  import { Play, Pause, Square, Pencil, Trash2, History, MessageSquare, Ellipsis, CircleAlert, X, CalendarClock, Cpu, Folder, PanelRight, Copy, FolderOpen } from "@lucide/svelte";
  import { approveBotCall, botHistory, botMessages, cancelBotRun, deleteBot, getBot, runBot, sendBotMessage, updateBot, botErrorText } from "../lib/api";
  import {
    NOTICE_ACTION_TEXT, RUN_STATUS_TEXT, askCards, botCompute, botStatusLine, computeText, failureNotice, foldBotReply, folderName, formatCSats, relativeTime, scheduleText, statusChip,
    type Bot, type BotMessage, type BotRun, type NoticeAction,
  } from "../lib/bots";
  import type { ToolEvent } from "../lib/types";
  import { choiceLabel } from "../lib/compute-choice";
  import { refreshBots } from "../lib/bots-store";

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
  $effect(() => {
    const id = bot.id;
    void bot.updatedAtMs;
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

  const chip = $derived(statusChip(bot));
  const compute = $derived(botCompute(bot));
  const computeLabel = $derived(computeText(compute, choiceLabel));
  const notice = $derived.by(() => {
    const n = failureNotice(bot);
    return n && !dismissed.includes(n.runId) ? n : null;
  });
  const budgetPct = $derived(bot.budgetCSatsPerDay ? Math.min(100, (bot.spentTodayCSats / bot.budgetCSatsPerDay) * 100) : 0);

  function noticeAction(a: NoticeAction) {
    if (a === "buy") onOpenSettings?.("plan");
    else if (a === "edit") onEdit(bot);
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
  let view = $state<"chat" | "history">("chat");
  let error = $state<string | null>(null);
  let confirmDelete = $state(false);
  let scrollEl: HTMLDivElement | undefined = $state();
  let lastCount = 0;

  const busy = $derived(bot.status === "running" || bot.status === "needs_approval");
  const pendingIds = $derived(bot.pending.map((p) => p.callId));

  async function load(id: string) {
    try {
      const [m, h] = await Promise.all([botMessages(id), botHistory(id)]);
      if (id !== bot.id) return;
      messages = m;
      runs = h;
      const count = m.length + m.reduce((n, x) => n + (x.events?.length ?? 0), 0);
      if (count !== lastCount) {
        lastCount = count;
        queueMicrotask(() => scrollEl?.scrollTo({ top: scrollEl.scrollHeight }));
      }
    } catch (err) {
      error = botErrorText(err);
    }
  }

  // Reload when the bot changes or its state does (the store polls), and poll while it works.
  $effect(() => {
    const id = bot.id;
    void bot.status;
    void bot.lastRun?.id;
    void bot.lastRun?.status;
    void bot.pending.length;
    void load(id);
    if (!busy) return;
    const t = setInterval(() => load(id), 1_500);
    return () => clearInterval(t);
  });
  $effect(() => {
    void bot.id;
    confirmDelete = false;
    menuOpen = false;
    memory = null;
    error = null;
    lastCount = 0;
  });

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

  const runNow = () => act(() => runBot(bot.id));
  const stop = () => act(() => cancelBotRun(bot.id));
  const togglePause = () => {
    closeMenu();
    return act(() => updateBot(bot.id, { enabled: !bot.enabled }));
  };
  const send = (text: string) => act(() => sendBotMessage(bot.id, text));
  const approve = (callId: string, approved: boolean) => act(() => approveBotCall(bot.id, callId, approved));
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
        <button role="menuitem" onclick={togglePause}>
          {#if bot.enabled}<Pause size={14} /> Pause schedule{:else}<Play size={14} /> Resume schedule{/if}
        </button>
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
        <div class="meta status-line" title={botStatusLine(bot)}>{botStatusLine(bot)}</div>
      {:else}
      <div class="meta" data-testid="bot-meta">
        <span class="m" title="Schedule"><CalendarClock size={12} />{scheduleText(bot.schedule)}{bot.enabled && bot.nextRunAtMs ? ` · next ${relativeTime(bot.nextRunAtMs)}` : !bot.enabled && bot.schedule ? " · paused" : ""}</span>
        <span class="sep" aria-hidden="true">·</span>
        <span class="m budget" title="cSats spent today against the daily budget">
          {#if bot.budgetCSatsPerDay != null}
            <span class="meter" role="meter" aria-label="Daily budget used" aria-valuemin="0" aria-valuemax={bot.budgetCSatsPerDay} aria-valuenow={bot.spentTodayCSats}><span style="width: {budgetPct}%"></span></span>
            {formatCSats(bot.spentTodayCSats)} / {formatCSats(bot.budgetCSatsPerDay)} cSats today
          {:else}
            {formatCSats(bot.spentTodayCSats)} cSats today · no limit
          {/if}
        </span>
        <span class="sep" aria-hidden="true">·</span>
        <span class="m" title="Compute: where its model calls run (change it in Edit)"><Cpu size={12} />{computeLabel}</span>
        <span class="sep" aria-hidden="true">·</span>
        <span class="m folder" title={bot.projectRoot}><Folder size={12} /><span class="folder-name">{folderName(bot.projectRoot)}</span></span>
      </div>
      {/if}
    </div>
    <div class="actions">
      {#if busy}
        <button onclick={stop} title="Stop this run"><Square size={14} /> Stop</button>
      {:else}
        <button class="primary" onclick={runNow} disabled={bot.status === "over_budget"} title={bot.status === "over_budget" ? "Today's budget is spent" : "Start a run now"}><Play size={14} /> Run now</button>
      {/if}
      {#if !panelOpen}{@render moreMenu()}{/if}
      <button class="icon" class:on={panelOpen} onclick={togglePanel} aria-pressed={panelOpen} aria-label={panelOpen ? "Hide details" : "Show details"} title={panelOpen ? "Hide details" : "Show details"}><PanelRight size={16} /></button>
    </div>
  </header>

  <div class="tabs" role="tablist">
    <button role="tab" aria-selected={view === "chat"} class:active={view === "chat"} onclick={() => (view = "chat")}><MessageSquare size={13} /> Conversation</button>
    <button role="tab" aria-selected={view === "history"} class:active={view === "history"} onclick={() => (view = "history")}><History size={13} /> Runs ({runs.length})</button>
  </div>

  {#if error}<div class="error" role="alert">{error}</div>{/if}

  {#if view === "chat" && notice}
    <div class="notice" role="status" data-testid="bot-failure-notice">
      <CircleAlert size={15} />
      <div class="notice-text">
        <div class="notice-title">{notice.title}</div>
        <div class="notice-detail">{notice.detail}</div>
      </div>
      <div class="notice-actions">
        {#each notice.actions as a (a)}
          {#if a !== "buy" || onOpenSettings}
            <button onclick={() => noticeAction(a)}>{NOTICE_ACTION_TEXT[a]}</button>
          {/if}
        {/each}
      </div>
      <button class="notice-close" onclick={() => dismiss(notice.runId)} aria-label="Dismiss" title="Dismiss"><X size={14} /></button>
    </div>
  {/if}

  {#if view === "chat"}
    <div class="messages" bind:this={scrollEl}>
      {#if messages.length === 0}
        <div class="empty">
          <BotAvatar name={bot.name} color={bot.color} shape={bot.avatarShape} status={bot.status} size={72} decorative />
          <p>Message {bot.name} or press <b>Run now</b>. {bot.schedule ? `It also runs ${scheduleText(bot.schedule).toLowerCase()}.` : ""}</p>
        </div>
      {/if}
      {#each messages as m (m.id)}
        {#if m.role === "event"}
          <div class="event">{m.content} · {when(m.atMs)}</div>
        {:else if m.role === "user"}
          <ChatMessage role="user" content={m.content} />
        {:else}
          {@const turn = foldBotReply(m.events, pendingIds)}
          {@const run = runs.find((r) => r.id === m.runId)}
          {@const cards = askCards(turn.toolEvents, bot.name)}
          <div class="bot-turn">
            <BotAvatar name={bot.name} color={bot.color} shape={bot.avatarShape} status={run?.status === "running" ? "running" : "idle"} mood={run?.status === "running" ? "working" : run?.status === "needs_approval" ? "needs" : run?.status === "failed" ? "failed" : "idle"} size={26} decorative />
            <div class="bot-turn-body">
              <ChatMessage
                role="assistant"
                content={turn.text}
                streaming={(run?.status === "running" || run?.status === "needs_approval") && !turn.text && turn.toolEvents.length === 0}
                toolEvents={withoutPendingBars(turn.toolEvents)}
                turnId={turn.turnId}
                changedFiles={turn.changedFiles}
                usage={run ? { cSats: run.cSats, where: run.where } : turn.usage}
                onToolApproval={approve}
                {onOpenPath}
                {onPreview}
              />
              {#each cards as c (c.id)}
                <div class="ask-card" class:waiting={!c.answer} data-testid="ask-card">
                  <div class="ask-q">{c.question}</div>
                  {#if c.detail}<code class="ask-detail">{c.detail}</code>{/if}
                  {#if c.answer}
                    <div class="ask-answer" class:denied={c.answer === "Denied"}>You: {c.answer}</div>
                  {:else}
                    <div class="ask-choices">
                      <button class="primary" onclick={() => approve(c.id, true)}>Allow</button>
                      <button onclick={() => approve(c.id, false)}>Deny</button>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}
      {/each}
    </div>
  {:else}
    <div class="history">
      {#if runs.length === 0}
        <div class="empty"><p>No runs yet.</p></div>
      {:else}
        <table>
          <thead><tr><th>Started</th><th>Trigger</th><th>Status</th><th>Summary</th><th class="num">cSats</th><th>Ran on</th><th class="num">Time</th></tr></thead>
          <tbody>
            {#each runs as r (r.id)}
              <tr>
                <td>{when(r.startedAtMs)}</td>
                <td>{r.trigger === "schedule" ? "Schedule" : r.trigger === "message" ? "Message" : "Run now"}</td>
                <td class="st {r.status}">{RUN_STATUS_TEXT[r.status]}</td>
                <td class="sum" title={r.summary}>{r.summary}</td>
                <td class="num">{formatCSats(r.cSats)}</td>
                <td>{r.where ?? (r.status === "failed" ? "Didn't run" : "—")}{#if r.note}<div class="run-note">{r.note}</div>{/if}</td>
                <td class="num">{duration(r)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  {/if}

  <div class="composer">
    <ChatInput onSend={send} placeholder={busy ? `${bot.name} is working; your message goes next…` : `Message ${bot.name}`} />
  </div>
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
    <div class="d-tabs" role="tablist" aria-label="Details">
      {#each [["details", "Details"], ["memory", "Memory"], ["folder", "Folder"]] as [id, label] (id)}
        <button role="tab" aria-selected={panelTab === id} class:active={panelTab === id} onclick={() => (panelTab = id as typeof panelTab)}>{label}</button>
      {/each}
    </div>
    <div class="d-body" role="tabpanel">
      {#if panelTab === "details"}
        <div class="d-section">
          <div class="d-label">Routines</div>
          {#if bot.schedule}
            <div class="routine">
              <CalendarClock size={15} />
              <div class="routine-text">
                <div class="routine-title">{scheduleText(bot.schedule)}</div>
                <div class="routine-sub">{bot.enabled ? (bot.nextRunAtMs ? `Next run ${relativeTime(bot.nextRunAtMs)}` : "On") : "Off: runs only when asked"}</div>
              </div>
              <button class="switch" role="switch" aria-checked={bot.enabled} aria-label="Run {scheduleText(bot.schedule).toLowerCase()}" onclick={togglePause}></button>
            </div>
          {:else}
            <div class="routine empty-routine">
              <div class="routine-text"><div class="routine-sub">No routine: it runs when you message it or press Run now.</div></div>
              <button class="link" onclick={() => onEdit(bot)}>Add one</button>
            </div>
          {/if}
        </div>
        <div class="d-section">
          <div class="d-label">Compute</div>
          <div class="d-row"><Cpu size={14} /><span class="d-val">{computeLabel}</span><button class="link" onclick={() => onEdit(bot)}>Change</button></div>
        </div>
        <div class="d-section">
          <div class="d-label">Budget today</div>
          {#if bot.budgetCSatsPerDay != null}
            <div class="d-meter" role="meter" aria-label="Daily budget used" aria-valuemin="0" aria-valuemax={bot.budgetCSatsPerDay} aria-valuenow={bot.spentTodayCSats}><span style="width: {budgetPct}%"></span></div>
            <div class="d-sub">{formatCSats(bot.spentTodayCSats)} of {formatCSats(bot.budgetCSatsPerDay)} cSats</div>
          {:else}
            <div class="d-sub">{formatCSats(bot.spentTodayCSats)} cSats · no limit</div>
          {/if}
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
            <pre class="memory">{memory}</pre>
          {:else}
            <div class="d-sub muted">Nothing yet. It saves notes with its remember tool as it works.</div>
          {/if}
          <button class="link" onclick={() => onEdit(bot)}>Edit memory</button>
        </div>
      {:else}
        <div class="d-section">
          <div class="d-label">Home folder</div>
          <code class="path">{bot.projectRoot}</code>
          <div class="d-actions">
            {#if onOpenFolder}<button onclick={() => onOpenFolder?.(bot.projectRoot)}><FolderOpen size={14} /> Open in editor</button>{/if}
            <button onclick={copyPath}><Copy size={14} /> {copied ? "Copied" : "Copy path"}</button>
          </div>
        </div>
      {/if}
    </div>
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
    border: 0.5px solid var(--border-strong, var(--border));
    border-radius: 14px;
    background: var(--bg-surface);
    margin-bottom: 8px;
  }
  .ask-card.waiting {
    border-color: color-mix(in srgb, var(--warning, #d29922) 55%, transparent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--warning, #d29922) 12%, transparent);
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
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-primary);
  }
  .ask-choices {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .ask-choices button {
    padding: 6px 14px;
    border-radius: 999px;
    border: 0.5px solid var(--border-strong, var(--border));
    background: var(--bg-base);
    color: var(--text-primary);
    font-size: 12.5px;
    cursor: pointer;
  }
  .ask-choices button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
    font-weight: 600;
  }
  .ask-choices button:focus-visible,
  .d-tabs button:focus-visible,
  .details button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .ask-answer {
    align-self: flex-end;
    padding: 4px 12px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--success, #3fb950) 16%, transparent);
    color: var(--success, #3fb950);
    font-size: 12px;
    font-weight: 600;
  }
  .ask-answer.denied {
    background: color-mix(in srgb, var(--danger, #e5484d) 14%, transparent);
    color: var(--danger, #e5484d);
  }
  /* --- details panel --- */
  .details {
    flex-shrink: 0;
    width: 280px;
    display: flex;
    flex-direction: column;
    border-left: 0.5px solid var(--border);
    background: var(--bg-deep, var(--bg-base));
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
  .d-tabs button {
    flex: 1;
    padding: 5px 8px;
    border: none;
    border-radius: 7px;
    background: none;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
  }
  .d-tabs button.active {
    background: var(--bg-surface);
    color: var(--text-primary);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
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
    background: var(--border-strong, #444);
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
    background: #fff;
    transition: transform 0.15s;
  }
  .switch[aria-checked="true"] {
    background: var(--success, #3fb950);
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
    font-family: var(--font-mono, ui-monospace, monospace);
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
    font-family: var(--font-mono, ui-monospace, monospace);
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
    border: 0.5px solid var(--border-strong, var(--border));
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
      box-shadow: -12px 0 32px rgba(0, 0, 0, 0.3);
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
    color: var(--warning, #d29922);
    border-color: color-mix(in srgb, var(--warning, #d29922) 45%, transparent);
    background: color-mix(in srgb, var(--warning, #d29922) 10%, transparent);
  }
  .chip.err {
    color: var(--danger, #e5484d);
    border-color: color-mix(in srgb, var(--danger, #e5484d) 45%, transparent);
    background: color-mix(in srgb, var(--danger, #e5484d) 10%, transparent);
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: 11.5px;
    color: var(--text-muted, var(--text-secondary));
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
  .meta .sep {
    flex-shrink: 0;
    opacity: 0.6;
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
    border: 0.5px solid var(--border-strong, var(--border));
    border-radius: 8px;
    background: var(--bg-base, var(--bg-surface));
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
  .actions button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
    font-weight: 600;
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
    background: var(--bg-elevated, var(--bg-surface));
    border: 0.5px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
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
    border: 0.5px solid color-mix(in srgb, var(--danger, #e5484d) 40%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--danger, #e5484d) 7%, var(--bg-surface));
    color: var(--danger, #e5484d);
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
    border: 0.5px solid var(--border-strong, var(--border));
    border-radius: 7px;
    background: var(--bg-base, var(--bg-surface));
    color: var(--text-primary);
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .notice-actions button:hover {
    border-color: var(--text-secondary);
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
    color: var(--text-muted, var(--text-secondary));
  }
  .tabs {
    display: flex;
    gap: 2px;
    padding: 6px 16px 0;
  }
  .tabs button {
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
  .tabs button.active {
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .error {
    margin: 8px 20px 0;
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 12.5px;
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
  }
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px 20px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .messages > :global(*) {
    width: 100%;
    max-width: 820px;
  }
  .event {
    text-align: center;
    font-size: 11.5px;
    color: var(--text-muted, var(--text-secondary));
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
