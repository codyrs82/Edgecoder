<script lang="ts">
  // A shared session from the terminal (`edgecoder code`, /remote), continued here. The IDE
  // provider runs the turns; this panel follows the session's events, and while it is in control
  // sends messages and answers approvals. The terminal mirrors whatever happens here.
  import { onDestroy, untrack } from "svelte";
  import { Radio, SquareTerminal } from "@lucide/svelte";
  import ChatMessage from "./ChatMessage.svelte";
  import ChatInput from "./ChatInput.svelte";
  import { DESKTOP_CLIENT, followSession, getSession, sessionApprove, sessionCancel, sessionSend, sessionTakeControl } from "../lib/api";
  import { applySessionEvent, canWrite, viewFromSnapshot, type LiveView } from "../lib/live-session";
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
  let busy = $state(false);
  let scroller: HTMLDivElement | undefined = $state();
  let abort: AbortController | null = null;

  const inControl = $derived(view ? canWrite(view, DESKTOP_CLIENT) : false);
  const controllerName = $derived(view?.controller ? (view.controller.clientId === DESKTOP_CLIENT.clientId ? "You" : view.controller.label ?? view.controller.kind) : null);
  const terminalHere = $derived(view?.clients.some((c) => c.kind === "terminal") ?? false);

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
    busy = true;
    error = null;
    try {
      await fn();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  const take = () => act(() => sessionTakeControl(sessionId));
  const send = (text: string) => act(() => sessionSend(sessionId, text));
  const stop = () => act(() => sessionCancel(sessionId));
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
      <span class="live-meta" title={tildePath(view.projectRoot)}>{projectName(view.projectRoot)} · {view.model}</span>
    </div>
    <div class="control-bar" role="status">
      {#if inControl}
        <span>You're in control.{terminalHere ? " The terminal is following along." : ""}</span>
      {:else}
        <span><SquareTerminal size={13} /> {controllerName ?? "The terminal"} is in control. You're watching.</span>
        <button class="btn btn--sm btn--primary" type="button" onclick={() => void take()} disabled={busy}>Take control</button>
      {/if}
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
          <ChatMessage role="assistant" content={view.streaming.text} streaming={true} toolEvents={view.streaming.toolEvents} onToolApproval={inControl ? approve : undefined} />
        {/if}
      </div>
    {:else if !error}
      <p class="note">Loading the session…</p>
    {/if}
  </div>

  <div class="panel-input">
    <ChatInput
      onSend={(t) => void send(t)}
      placeholder={inControl ? "Message this session (the terminal sees it too)…" : "Take control to send messages"}
      disabled={!inControl || busy}
      streaming={!!view?.streaming}
      onStop={inControl ? () => void stop() : undefined}
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
  .control-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 16px;
    border-bottom: 0.5px solid var(--border);
    font-size: var(--fs-xs);
    color: var(--text-secondary);
  }
  .control-bar span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
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
