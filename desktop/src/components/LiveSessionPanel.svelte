<script lang="ts">
  // A shared session from the terminal (`edgecoder code`, /remote), co-edited here. The IDE
  // provider runs the turns; this panel follows the session's events. Both clients may send at any
  // time (a message sent during a turn is queued for the next one), approve (the first answer
  // wins) and change settings; neither has to take control.
  import { onDestroy, untrack } from "svelte";
  import { Radio, Users } from "@lucide/svelte";
  import ChatMessage from "./ChatMessage.svelte";
  import ChatInput from "./ChatInput.svelte";
  import { DESKTOP_CLIENT, followSession, getSession, sessionApprove, sessionCancel, sessionSend, sessionUnqueue } from "../lib/api";
  import { applySessionEvent, presenceText, viewFromSnapshot, type LiveView } from "../lib/live-session";
  import { markApproval } from "../lib/agent-events";
  import { projectName, tildePath } from "../lib/projects";

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
  let abort: AbortController | null = null;

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
      view = viewFromSnapshot(snap);
      scrollDown();
      void followSession(id, snap.seq, (e) => {
        if (!view || ctl.signal.aborted) return;
        view = applySessionEvent(view, e);
        if (e.type === "agent" && (e.event as { type?: string }).type === "file_change") onFilesChanged?.();
        if (view.needsResync) void load(id);
        scrollDown();
      }, ctl.signal);
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
    requestAnimationFrame(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
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
  const send = (text: string) => act(() => sessionSend(sessionId, text));
  const stop = () => act(() => sessionCancel(sessionId));
  const unqueue = (id: string) => act(() => sessionUnqueue(sessionId, id));
  function approve(id: string, approved: boolean) {
    if (view?.streaming) view = { ...view, streaming: { ...view.streaming, toolEvents: markApproval(view.streaming.toolEvents, id, approved) } };
    void act(() => sessionApprove(sessionId, id, approved));
  }
</script>

<div class="live-panel" aria-label="Live session">
  {#if view}
    <div class="live-header">
      <span class="live-badge" title="Shared with the terminal"><Radio size={12} /> Live</span>
      <span class="live-title" title={view.title}>{view.title}</span>
      <span class="live-meta" title={tildePath(view.projectRoot)}>{projectName(view.projectRoot)} · {view.model} · {view.mode}</span>
    </div>
    <div class="presence-bar" role="status">
      <span><Users size={13} /> {presence}</span>
      {#if lastNote}<span class="note-inline">{lastNote}</span>{/if}
    </div>
  {/if}

  <div class="messages-scroll" bind:this={scroller}>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if view?.deleted}
      <p class="note">This session was deleted.</p>
    {:else if view}
      <div class="messages">
        {#each view.messages as m (m.id)}
          {#if m.role === "user" && m.by === "terminal"}<div class="from">from the terminal</div>{/if}
          <ChatMessage role={m.role} content={m.content} toolEvents={m.toolEvents} turnId={m.turnId} changedFiles={m.changedFiles} usage={m.usage} onFilesReverted={onFilesChanged} {onOpenPath} {onPreview} />
        {/each}
        {#if view.streaming}
          <ChatMessage role="assistant" content={view.streaming.text} streaming={true} toolEvents={view.streaming.toolEvents} usage={view.streaming.usage} onToolApproval={approve} />
        {/if}
      </div>
    {:else if !error}
      <p class="note">Loading the session…</p>
    {/if}
  </div>

  <div class="panel-input">
    <ChatInput
      onSend={(t) => void send(t)}
      placeholder={view?.streaming ? "Type the next message: it runs when this reply ends (Esc stops the reply)" : "Message this session (the terminal sees it too)…"}
      disabled={!view || view.deleted}
      streaming={!!view?.streaming}
      onStop={() => void stop()}
      queue={view?.queue ?? []}
      onUnqueue={(id) => void unqueue(id)}
    />
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
