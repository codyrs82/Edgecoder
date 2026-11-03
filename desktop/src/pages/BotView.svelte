<script lang="ts">
  import ChatMessage from "../components/ChatMessage.svelte";
  import ChatInput from "../components/ChatInput.svelte";
  import { Play, Pause, Square, Pencil, Trash2, History, MessageSquare } from "@lucide/svelte";
  import { approveBotCall, botHistory, botMessages, cancelBotRun, deleteBot, runBot, sendBotMessage, updateBot, botErrorText } from "../lib/api";
  import { RUN_STATUS_TEXT, botInitial, botStatusLine, budgetText, foldBotReply, formatCSats, relativeTime, scheduleText, type Bot, type BotMessage, type BotRun } from "../lib/bots";
  import { refreshBots } from "../lib/bots-store";

  interface Props {
    bot: Bot;
    onEdit: (bot: Bot) => void;
    onDeleted: () => void;
    onOpenPath?: (path: string) => void;
    onPreview?: (path: string) => void;
  }
  let { bot, onEdit, onDeleted, onOpenPath, onPreview }: Props = $props();

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
  const togglePause = () => act(() => updateBot(bot.id, { enabled: !bot.enabled }));
  const send = (text: string) => act(() => sendBotMessage(bot.id, text));
  const approve = (callId: string, approved: boolean) => act(() => approveBotCall(bot.id, callId, approved));
  async function remove() {
    if (!confirmDelete) {
      confirmDelete = true;
      return;
    }
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

<div class="bot-view">
  <header class="bot-head">
    <span class="avatar big" style="background: {bot.color}">{botInitial(bot.name)}</span>
    <div class="who">
      <div class="name">{bot.name}{#if bot.role}<span class="role"> · {bot.role}</span>{/if}</div>
      <div class="sub" class:warn={bot.status === "needs_approval" || bot.status === "over_budget"} class:err={bot.status === "error"}>{botStatusLine(bot)}</div>
      <div class="meta">
        <span title="Schedule">{scheduleText(bot.schedule)}{#if bot.enabled && bot.nextRunAtMs} · next {relativeTime(bot.nextRunAtMs)}{:else if !bot.enabled && bot.schedule} · paused{/if}</span>
        <span title="Spent today against the daily budget">{budgetText(bot)}</span>
        <span class="path" title={bot.projectRoot}>{bot.projectRoot.replace(/^\/Users\/[^/]+/, "~")}</span>
      </div>
    </div>
    <div class="actions">
      {#if busy}
        <button onclick={stop} title="Stop this run"><Square size={14} /> Stop</button>
      {:else}
        <button class="primary" onclick={runNow} disabled={bot.status === "over_budget"} title={bot.status === "over_budget" ? "Today's budget is spent" : "Start a run now"}><Play size={14} /> Run now</button>
      {/if}
      <button onclick={togglePause} title={bot.enabled ? "Pause the schedule (messages and Run now still work)" : "Resume the schedule"}>
        {#if bot.enabled}<Pause size={14} /> Pause{:else}<Play size={14} /> Resume{/if}
      </button>
      <button onclick={() => onEdit(bot)} title="Edit"><Pencil size={14} /> Edit</button>
      <button class="icon danger" onclick={remove} title={confirmDelete ? "Click again to delete" : "Delete bot"}><Trash2 size={14} />{#if confirmDelete} Delete?{/if}</button>
    </div>
  </header>

  <div class="tabs" role="tablist">
    <button role="tab" aria-selected={view === "chat"} class:active={view === "chat"} onclick={() => (view = "chat")}><MessageSquare size={13} /> Conversation</button>
    <button role="tab" aria-selected={view === "history"} class:active={view === "history"} onclick={() => (view = "history")}><History size={13} /> Runs ({runs.length})</button>
  </div>

  {#if error}<div class="error" role="alert">{error}</div>{/if}

  {#if view === "chat"}
    <div class="messages" bind:this={scrollEl}>
      {#if messages.length === 0}
        <div class="empty">
          <span class="avatar huge" style="background: {bot.color}">{botInitial(bot.name)}</span>
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
          <ChatMessage
            role="assistant"
            content={turn.text}
            streaming={run?.status === "running" && !turn.text && turn.toolEvents.length === 0}
            toolEvents={turn.toolEvents}
            turnId={turn.turnId}
            changedFiles={turn.changedFiles}
            usage={run ? { cSats: run.cSats, where: run.where } : turn.usage}
            onToolApproval={approve}
            {onOpenPath}
            {onPreview}
          />
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
                <td>{r.where ?? "—"}</td>
                <td class="num">{duration(r)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  {/if}

  <div class="composer">
    <ChatInput onSend={send} placeholder={busy ? `${bot.name} is working; your message goes next…` : `Message ${bot.name}…`} />
  </div>
</div>

<style>
  .bot-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .bot-head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 14px 20px 10px;
    border-bottom: 0.5px solid var(--border);
  }
  .avatar {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    color: white;
    font-weight: 600;
  }
  .avatar.big {
    width: 40px;
    height: 40px;
    font-size: 17px;
  }
  .avatar.huge {
    width: 56px;
    height: 56px;
    font-size: 24px;
  }
  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .name {
    font-size: 15px;
    font-weight: 600;
  }
  .role {
    font-weight: 400;
    color: var(--text-secondary);
  }
  .sub {
    font-size: 12.5px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub.warn {
    color: var(--yellow);
  }
  .sub.err {
    color: var(--danger);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    font-size: 11.5px;
    color: var(--text-muted, var(--text-secondary));
  }
  .meta .path {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
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
  .actions button.danger {
    color: var(--danger);
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
