<script lang="ts">
  // A shared session from the terminal (`edgecoder code`, /remote), co-edited here. The IDE
  // provider runs the turns; this panel follows the session's events. Both clients may send at any
  // time (a message sent during a turn is queued for the next one), approve (the first answer
  // wins) and change settings; neither has to take control.
  import { onDestroy, untrack } from "svelte";
  import { Radio, Users } from "@lucide/svelte";
  import ChatMessage from "./ChatMessage.svelte";
  import ChatInput from "./ChatInput.svelte";
  import QuoteSelection from "./QuoteSelection.svelte";
  import JumpToLatest from "./JumpToLatest.svelte";
  import CompactionNote from "./CompactionNote.svelte";
  import { createFollower, type FollowState } from "../lib/follow-bottom";
  import { isCompactCommand } from "../lib/compaction";
  import { DESKTOP_CLIENT, followSession, getSession, sessionApprove, sessionApprovePlan, sessionCancel, sessionCompact, sessionSend, sessionSettings, sessionTentacles, sessionUnqueue, tentacleCancel, tentacleMerge } from "../lib/api";
  import PermissionModePicker from "./PermissionModePicker.svelte";
  import PlanApproval from "./PlanApproval.svelte";
  import { modeOption, isEngineMode, type EngineMode } from "../lib/permission-modes";
  import TentacleTree from "./TentacleTree.svelte";
  import { applyTentacleEvent, emptyTentacles, type TentacleState } from "../lib/tentacles";
  import { applySessionEvent, pendingPlan, presenceText, viewFromSnapshot, type LiveView } from "../lib/live-session";
  import { markApproval } from "../lib/agent-events";
  import { projectName, tildePath } from "../lib/projects";
  import { frontierFooter } from "../lib/compute-choice";

  interface Props {
    sessionId: string;
    /** The agent wrote files (reload open buffers). */
    onFilesChanged?: () => void;
    onOpenPath?: (path: string) => void;
    onPreview?: (path: string) => void;
  }
  let { sessionId, onFilesChanged, onOpenPath, onPreview }: Props = $props();

  let view = $state<LiveView | null>(null);
  let error = $state<string | null>(null);
  let scroller: HTMLDivElement | undefined = $state();
  let chatInput: ChatInput | undefined = $state();
  let abort: AbortController | null = null;
  // Tentacles hook: the session's helper agents (TentacleTree).
  let tentacles = $state<TentacleState>(emptyTentacles());
  // Scroll (follow-bottom.ts): opens at the latest messages; follows a reply only while at the bottom.
  let follow = $state<FollowState>({ atBottom: true, unseen: false });
  const follower = createFollower((s) => (follow = s));

  const presence = $derived(view ? presenceText(view, DESKTOP_CLIENT) : "");
  const lastNote = $derived(view?.notes.at(-1) ?? null);

  async function load(id: string) {
    abort?.abort();
    const ctl = new AbortController();
    abort = ctl;
    error = null;
    try {
      const snap = await getSession(id);
      if (ctl.signal.aborted) return;
      const fresh = view?.id !== snap.session.id;
      view = viewFromSnapshot(snap);
      if (fresh) follower.reset();
      else scrollDown();
      void followSession(id, snap.seq, (e) => {
        if (!view || ctl.signal.aborted) return;
        view = applySessionEvent(view, e);
        if (e.type.startsWith("tentacle_")) tentacles = applyTentacleEvent(tentacles, e);
        if (e.type === "agent" && (e.event as { type?: string }).type === "file_change") onFilesChanged?.();
        if (view.needsResync) void load(id);
        scrollDown();
      }, ctl.signal);
      // Tentacles hook: never in the way of the session itself (an older provider has no tentacles).
      void Promise.resolve()
        .then(() => sessionTentacles(id))
        .then((r) => {
          if (!ctl.signal.aborted && r) tentacles = { items: r.tentacles, spentCSats: r.spentCSats, enabled: r.config.enabled };
        })
        .catch(() => undefined);
    } catch (err) {
      error = (err as Error).message;
    }
  }

  $effect(() => {
    const id = sessionId;
    untrack(() => void load(id));
  });
  onDestroy(() => abort?.abort());

  function scrollDown() {
    follower.contentChanged();
  }

  async function act(fn: () => Promise<unknown>) {
    error = null;
    try {
      await fn();
    } catch (err) {
      error = (err as Error).message;
    }
  }

  // Sent at once; while a turn runs the provider queues it (it shows below as Queued).
  // `/compact` summarizes the session's older messages now (as in the terminal).
  const send = (text: string) => {
    if (isCompactCommand(text)) return act(() => sessionCompact(sessionId));
    follower.reset();
    return act(() => sessionSend(sessionId, text));
  };
  const stop = () => act(() => sessionCancel(sessionId));
  const unqueue = (id: string) => act(() => sessionUnqueue(sessionId, id));
  function approve(id: string, approved: boolean, always = false, forRun = false, session = false) {
    if (view?.streaming) view = { ...view, streaming: { ...view.streaming, toolEvents: markApproval(view.streaming.toolEvents, id, approved) } };
    void act(() => (always || forRun || session ? sessionApprove(sessionId, id, approved, always, forRun, session) : sessionApprove(sessionId, id, approved)));
  }
  // The mode is the session's own (persisted by the provider; the terminal sees changes too).
  const mode = $derived<EngineMode>(isEngineMode(view?.mode) ? (view!.mode as EngineMode) : "ask");
  function setMode(m: EngineMode) {
    if (view) view = { ...view, mode: m };
    void act(() => sessionSettings(sessionId, { mode: m }));
  }
  const plan = $derived(view ? pendingPlan(view) : null);
</script>

<div class="live-panel" aria-label="Live session">
  {#if view}
    <div class="live-header">
      <span class="live-badge" title="Shared with the terminal"><Radio size={12} /> Live</span>
      <span class="live-title" title={view.title}>{view.title}</span>
      <span class="live-meta" title={tildePath(view.projectRoot)}>{projectName(view.projectRoot)} · {view.frontierModel ? frontierFooter(view.frontierModel, view.frontierUsd ?? 0) : view.model} · {modeOption(view.mode).title}</span>
    </div>
    <div class="presence-bar" role="status">
      <span><Users size={13} /> {presence}</span>
      {#if lastNote}<span class="note-inline">{lastNote}</span>{/if}
    </div>
    {#if view.allowances.length}
      <div class="allowances-bar" data-testid="session-allowances" title="Calls like these run without asking until this session ends.">Allowed this session: {view.allowances.join(", ")}</div>
    {/if}
  {/if}

  <TentacleTree tree={tentacles} canAct={true} onCancel={(tid) => void act(() => tentacleCancel(sessionId, tid))} onMerge={(tid, ok) => void act(() => tentacleMerge(sessionId, tid, ok))} />

  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="messages-scroll" bind:this={scroller} use:follower.action tabindex="0" role="region" aria-label="Conversation">
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if view?.deleted}
      <p class="note">This session was deleted.</p>
    {:else if view}
      <div class="messages">
        {#each view.messages as m (m.id)}
          {#if m.role === "user" && m.by === "terminal"}<div class="from">from the terminal</div>{/if}
          <ChatMessage role={m.role} content={m.content} toolEvents={m.toolEvents} turnId={m.turnId} changedFiles={m.changedFiles} usage={m.usage} onFilesReverted={onFilesChanged} {onOpenPath} {onPreview} />
          {#if view.summary?.throughId === m.id}<CompactionNote savedTokens={view.summary.savedTokens} />{/if}
        {/each}
        {#if view.streaming}
          <ChatMessage role="assistant" content={view.streaming.text} streaming={true} toolEvents={view.streaming.toolEvents} usage={view.streaming.usage} onToolApproval={approve} onToolAlways={(id) => approve(id, true, true)} onToolForRun={(id) => approve(id, true, false, true)} onToolSession={(id) => approve(id, true, false, false, true)} />
        {/if}
        {#if plan}
          <PlanApproval onApprove={(m) => void act(() => sessionApprovePlan(sessionId, m))} onRevise={() => chatInput?.focus()} />
        {/if}
      </div>
    {:else if !error}
      <p class="note">Loading the session…</p>
    {/if}
    <QuoteSelection scope={scroller} onQuote={(b) => void chatInput?.insertQuote(b)} />
    <JumpToLatest visible={!follow.atBottom && !!view && view.messages.length > 0} unseen={follow.unseen} onJump={follower.jump} />
  </div>

  <div class="panel-input">
    <ChatInput
      bind:this={chatInput}
      onSend={(t) => void send(t)}
      placeholder={view?.streaming ? "Type the next message: it runs when this reply ends (Esc stops the reply)" : "Message this session (the terminal sees it too)…"}
      disabled={!view || view.deleted}
      streaming={!!view?.streaming}
      onStop={() => void stop()}
      queue={view?.queue ?? []}
      onUnqueue={(id) => void unqueue(id)}
      sendWhileWorking
    >
      {#snippet controls()}
        <PermissionModePicker {mode} onChange={setMode} disabled={!view || view.deleted} allowFull project={view?.projectRoot ?? null} />
      {/snippet}
    </ChatInput>
  </div>
</div>

<style>
  .live-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
  }
  .live-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px 6px;
    min-width: 0;
  }
  .live-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 7px;
    border-radius: 999px;
    font-size: var(--fs-2xs);
    color: var(--green);
    background: color-mix(in srgb, var(--green) 12%, transparent);
    flex-shrink: 0;
  }
  .live-title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .live-meta {
    color: var(--text-muted);
    font-size: var(--fs-xs);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .presence-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 16px;
    border-bottom: 0.5px solid var(--border);
    font-size: var(--fs-xs);
    color: var(--text-secondary);
  }
  .presence-bar span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .allowances-bar {
    padding: 4px 16px;
    border-bottom: 0.5px solid var(--border);
    font-size: var(--fs-2xs);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note-inline {
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .messages-scroll {
    flex: 1;
    overflow-y: auto;
  }
  .messages {
    display: flex;
    flex-direction: column;
    gap: 20px;
    max-width: 760px;
    margin: 0 auto;
    padding: 20px 20px 12px;
  }
  .from {
    margin-bottom: -16px;
    font-size: var(--fs-2xs);
    color: var(--text-muted);
    text-align: right;
  }
  .note,
  .error {
    margin: 24px;
    font-size: var(--fs-sm);
    color: var(--text-secondary);
  }
  .error {
    color: var(--red);
  }
  .panel-input {
    padding: 8px 16px 16px;
  }
</style>
