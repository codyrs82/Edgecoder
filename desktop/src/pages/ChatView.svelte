<script lang="ts">
  import { NO_VISION, attachmentLabel, attachmentsText, type AttachmentPayload } from "../lib/attachments";
  import { applyAgentEvent, markApproval } from "../lib/agent-events";
  import { setBusy as setRestartBusy, clearBusy as clearRestartBusy } from "../lib/auto-restart";
  import { expandMentions } from "../lib/mentions";
  import { autoApplySetting } from "../lib/project-mode";
  import PlanApproval from "../components/PlanApproval.svelte";
  import { chatMode, PLAN_APPROVED_MESSAGE, type EngineMode } from "../lib/permission-modes";
  import { onMount, onDestroy, untrack } from "svelte";
  import ChatMessage from "../components/ChatMessage.svelte";
  import JumpToLatest from "../components/JumpToLatest.svelte";
  import CompactionNote from "../components/CompactionNote.svelte";
  import { createFollower, type FollowState } from "../lib/follow-bottom";
  import { applyCompaction, compactPaidTokensSetting, contextTokens, estimateTokens, historyForModel, isCompactCommand, isPaidChoice, PRE_SEND_SHARE } from "../lib/compaction";
  import QuoteSelection from "../components/QuoteSelection.svelte";
  import { computeChoice, freeReplyUsage } from "../lib/compute-choice";
  import { get } from "svelte/store";
  import {
    streamChat,
    streamPortalChat,
    streamIdeChat,
    streamIdeWebChat,
    ideCompact,
    WebOffError,
    ideSendToolApproval,
    portalCreateConversation,
    portalRenameConversation,
    getModelPullProgress,
    isRemoteMode,
    backendReady,
    agentGitHubToken,
    fsGitStatus,
  } from "../lib/api";
  import type { StreamProgress, ModelPullProgress, IdeStreamEvent, RepoConnection } from "../lib/api";
  import ConnectRepo from "../components/ConnectRepo.svelte";
  import ServiceNotice from "../components/ServiceNotice.svelte";
  import { onServiceReady, serviceStatus, whenServiceReady } from "../lib/service-status";
  import {
    createConversation,
    addMessage,
    saveConversation,
    loadConversation as loadConversationFromDb,
    listConversationsBySource,
  } from "../lib/chat-store";
  import type { Conversation, ReplyUsage, ToolEvent } from "../lib/types";
  import { NEEDS_CSATS_NOTE, chatWebMode, webAutoStore, webOffered, webUsageOf, type WebStatus, type WebUsage } from "../lib/web-tool";

  interface Props {
    onOpenInEditor?: (code: string, language: string) => void;
    projectRoot?: string | null;
    /** Told when a reply starts and stops streaming (the page's input shows Stop meanwhile). */
    onStreamingChange?: (streaming: boolean) => void;
    /** Open a project file in the editor tab (from an agent reply's changes card). */
    onOpenPath?: (path: string) => void;
    onPreview?: (path: string) => void;
    /** A repository was connected from this chat's empty state; it is now the open project. */
    onRepoConnected?: (r: RepoConnection) => void;
    /** The title bar's text: this chat's title and its project (and branch) or "Synced". */
    onHeaderChange?: (h: { title: string; detail: string | null }) => void;
    /** "Add to chat": text selected in a message, as a Markdown quote for the page's composer. */
    onQuote?: (block: string) => void;
    /** This chat's permission mode, for the composer's picker (it changes it with setMode). */
    onModeChange?: (mode: EngineMode) => void;
    /** Plan's "Revise": put the cursor in the page's composer. */
    onFocusComposer?: () => void;
    /** Web search for the chat's model now (set up, a model that calls tools, cSats); docs/web-tool.md. */
    webStatus?: WebStatus | null;
    /** This chat's own web choice (true Auto, false Off, unset the default), for the composer (it changes it with setWeb). */
    onWebChange?: (choice: boolean | undefined) => void;
    /** A reply used the web or was turned down for it: the status (balance) may have changed. */
    onWebStale?: () => void;
    /** The context meter beside the composer's model picker (compaction.ts); null when compacting isn't available (portal chat). */
    onContextChange?: (c: { tokens: number; compacting: boolean; note: string | null } | null) => void;
  }
  let { onOpenInEditor, projectRoot = null, onStreamingChange, onOpenPath, onPreview, onRepoConnected, onHeaderChange, onQuote, onModeChange, onFocusComposer, webStatus = null, onWebChange, onWebStale, onContextChange }: Props = $props();

  let connectRepoBox: ConnectRepo | undefined = $state(undefined);
  /** The open project's folder name and branch, for the header. */
  let projectBranch = $state<string | null>(null);
  const projectName = $derived(projectRoot ? projectRoot.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? null : null);
  $effect(() => {
    const root = projectRoot;
    void isStreaming; // a reply may have switched branches
    if (!root || usePortalChat) {
      projectBranch = null;
      return;
    }
    fsGitStatus().then((s) => { if (root === projectRoot) projectBranch = s.branch; }).catch(() => { projectBranch = null; });
  });

  /** Put the cursor in the "Connect a repository" field (new chat). */
  export function focusConnect() {
    connectRepoBox?.focus();
  }

  /** The project folder this chat was working in, if any (reopened when the chat is). */
  export function getProjectRoot(): string | null {
    return conversation.projectRoot ?? null;
  }

  function repoConnected(r: RepoConnection) {
    conversation.projectRoot = r.path;
    onRepoConnected?.(r);
  }

  let conversation: Conversation = $state(createConversation("chat"));
  $effect(() => {
    const title = conversation.messages.length ? conversation.title : "New chat";
    const detail = usePortalChat ? "Synced" : projectName ? `${projectName}${projectBranch ? ` · ${projectBranch}` : ""}` : null;
    onHeaderChange?.({ title, detail });
  });
  /** This chat's permission mode (kept with the chat; new chats start in Settings' default). */
  const mode = $derived<EngineMode>(chatMode(conversation.permissionMode, autoApplySetting(conversation.projectRoot ?? projectRoot)));
  $effect(() => {
    onModeChange?.(mode);
  });
  /** The composer's picker changed the mode. */
  export function setMode(m: EngineMode) {
    conversation.permissionMode = m;
    conversation = conversation;
    if (conversation.messages.length > 0) void saveConversation(conversation);
  }
  $effect(() => {
    onWebChange?.(conversation.web);
  });
  /** The composer's Web menu: "Auto" (true) or "Off for this chat" (false), kept with the chat. */
  export function setWeb(on: boolean) {
    conversation.web = on;
    conversation = conversation;
    if (conversation.messages.length > 0) void saveConversation(conversation);
  }
  /** The web tool's total and sources for the reply streaming now, and its status line. */
  let streamingWeb: WebUsage | undefined = $state(undefined);
  /** Web was wanted but not offered for the reply streaming now ("needs_csats"…). */
  let streamingWebOff: string | undefined = undefined;
  let streamingActivity: string | undefined = $state(undefined);
  let streamingContent = $state("");
  let isStreaming = $state(false);
  let streamProgress: StreamProgress | undefined = $state(undefined);
  let meshWarning: string | null = $state(null);
  let abortController: AbortController | null = $state(null);
  let scrollContainer: HTMLDivElement | undefined = $state(undefined);
  // Scroll (follow-bottom.ts): a chat opens at its latest messages; a streaming reply is followed
  // only while the reader is at the bottom; "Jump to latest" shows when they scrolled up.
  let follow = $state<FollowState>({ atBottom: true, unseen: false });
  const follower = createFollower((s) => (follow = s));
  let followFor = "";
  $effect(() => {
    const id = conversation.id;
    if (id === followFor) return;
    followFor = id;
    untrack(() => follower.reset());
  });

  /** Whether we should stream via the portal API (server-side conversations) */
  let usePortalChat = $state(false);

  // Compaction (compaction.ts): the meter's size, a run in progress, and a manual one's short answer.
  let compacting = $state(false);
  let compactNote = $state<string | null>(null);
  let streamingContext: number | undefined = $state(undefined);
  let streamingCompacted = 0;
  /** This reply's cost notes (cost-guard.ts): live, then the reply's notice. */
  let streamingCostNotes: string[] = $state([]);
  $effect(() => {
    const tokens = isStreaming && streamingContext ? streamingContext : contextTokens(conversation);
    onContextChange?.(usePortalChat ? null : { tokens, compacting, note: compactNote });
  });

  /**
   * Summarize the older messages and keep the summary with the chat (POST /v1/ide/compact).
   * `force`: now (`/compact`, the context meter); otherwise only a paid model's chat past its budget.
   */
  async function compactNow(force: boolean): Promise<boolean> {
    if (usePortalChat || compacting) return false;
    const sent = historyForModel(conversation);
    const choice = get(computeChoice);
    if (!force && (!isPaidChoice(choice) || estimateTokens(sent.messages) <= compactPaidTokensSetting() * PRE_SEND_SHARE)) return false;
    compacting = true;
    compactNote = null;
    try {
      const r = await ideCompact(sent.messages, choice, force);
      if (applyCompaction(conversation, r, sent, force)) {
        conversation = conversation;
        if (conversation.messages.length > 0) await saveConversation(conversation);
        return true;
      }
      if (force) compactNote = "Nothing to compact yet";
    } catch (err) {
      if (force) compactNote = `Couldn't compact: ${(err as Error).message}`;
    } finally {
      compacting = false;
    }
    if (compactNote) setTimeout(() => (compactNote = null), 4000);
    return false;
  }

  /** "Compact conversation" (the context meter) and `/compact`. */
  export function compactConversation() {
    if (!isStreaming) void compactNow(true);
  }

  /** IDE agent streaming tool events */
  let streamingToolEvents: ToolEvent[] = $state([]);
  const restartKey = `chat:${Math.random().toString(36).slice(2)}`;
  $effect(() => {
    setRestartBusy(`${restartKey}:approval`, streamingToolEvents.some((e) => e.type === "tool_call" && e.approval_status === "pending") && "approval");
    return () => clearRestartBusy(`${restartKey}:approval`);
  });
  let streamingTurnId: string | undefined = $state(undefined);
  let streamingUsage: ReplyUsage | undefined = $state(undefined);
  let streamingChanged: string[] = $state([]);

  $effect(() => {
    void agentGitHubToken().catch(() => {});
    // Re-read when GitHub is connected via settings
    const handler = () => { void agentGitHubToken(true).catch(() => {}); };
    window.addEventListener("edgecoder:github-connected", handler);
    return () => window.removeEventListener("edgecoder:github-connected", handler);
  });

  /** Active model download progress */
  let pullProgress: ModelPullProgress | null = $state(null);
  let pullPollTimer: ReturnType<typeof setInterval> | undefined;

  const quickActions = [
    { label: "Fix a bug", prompt: "Help me fix a bug in my code" },
    { label: "Write tests", prompt: "Help me write tests" },
    { label: "Explain code", prompt: "Explain how this code works" },
    { label: "Review code", prompt: "Review this code for issues" },
  ];

  // Restore last chat conversation on mount
  onMount(async () => {
    // Use portal chat when no local agent is running
    await backendReady;
    // While EdgeCoder's local service is still starting, wait for it rather than fall back to the
    // portal (onServiceReady below decides again once it answers).
    if (isRemoteMode() && get(serviceStatus).phase === "ready") {
      usePortalChat = true;
    }

    const lastId = localStorage.getItem("edgecoder-last-chat-id");
    if (lastId) {
      const loaded = await loadConversationFromDb(lastId);
      if (loaded) {
        conversation = loaded;
      }
    }
    if (!conversation.messages.length) {
      // Fallback: load most recent chat conversation
      const recent = await listConversationsBySource("chat");
      if (recent.length > 0) {
        const loaded = await loadConversationFromDb(recent[0].id);
        if (loaded) conversation = loaded;
      }
    }

    // Poll for model download progress
    pullPollTimer = setInterval(async () => {
      pullProgress = await getModelPullProgress();
    }, 3000);
  });

  // The local service came back (or finished starting): use it.
  onDestroy(onServiceReady(() => (usePortalChat = isRemoteMode())));

  // Save current conversation when component unmounts (tab switch)
  onDestroy(() => {
    if (pullPollTimer) clearInterval(pullPollTimer);
    if (conversation.messages.length > 0) {
      localStorage.setItem("edgecoder-last-chat-id", conversation.id);
      saveConversation(conversation);
    }
  });

  /**
   * Ensure the conversation has a portal-side conversation ID.
   * Creates one on the portal server if needed.
   */
  async function ensurePortalConversation(): Promise<string> {
    if (conversation.portalConversationId) {
      return conversation.portalConversationId;
    }
    const portalId = await portalCreateConversation(conversation.title);
    conversation.portalConversationId = portalId;
    conversation = conversation;
    await saveConversation(conversation);
    return portalId;
  }

  function handleToolApproval(id: string, approved: boolean, always = false, forRun = false) {
    ideSendToolApproval(id, approved, always, undefined, forRun);
    streamingToolEvents = markApproval(streamingToolEvents, id, approved);
  }

  /** A cost check's answer (CostCheckCard): Keep going, Switch (the picker moves to the cheaper model too) or Stop. */
  function handleCostChoice(id: string, choice: "continue" | "switch" | "stop", suggest?: { id: string; name: string }) {
    void ideSendToolApproval(id, choice !== "stop", false, choice);
    streamingToolEvents = markApproval(streamingToolEvents, id, choice !== "stop");
    if (choice === "switch" && suggest) computeChoice.set(suggest.id);
  }

  export async function sendMessage(typed: string, attachments: AttachmentPayload[] = []) {
    // The conversation keeps the typed text and the attached names; the files go with this request only.
    const text = [typed, attachmentLabel(attachments)].filter(Boolean).join("\n\n");
    // Without the agent (portal / plain chat) text files go inline and images/PDFs as a note.
    const inlineText = attachments.length ? [text, attachmentsText(attachments, NO_VISION)].filter(Boolean).join("\n\n") : text;
    if (isStreaming) return;
    if (isCompactCommand(typed) && !attachments.length) {
      compactConversation();
      return;
    }

    addMessage(conversation, "user", text);
    // Where this chat ran last (the sidebar's laptop / server / cloud icon).
    conversation.selectedModel = get(computeChoice);
    if (projectRoot) conversation.projectRoot = projectRoot;
    conversation = conversation; // trigger reactivity
    // Your own message: show it, and follow the reply.
    follower.reset();

    isStreaming = true;
    streamingContent = "";
    streamProgress = undefined;
    meshWarning = null;
    abortController = new AbortController();
    // Sent while the local service starts or restarts: wait for it (the notice above says so), up
    // to a minute, instead of failing with "couldn't reach".
    if (!usePortalChat && get(serviceStatus).phase !== "ready" && get(serviceStatus).phase !== "failed") {
      await Promise.race([whenServiceReady(), new Promise((r) => setTimeout(r, 60_000))]);
    }
    const sentMode: EngineMode = mode;
    // Web (docs/web-tool.md): automatic unless off for this chat (or by default in Settings); offered
    // only when it can be used now (set up, a model that calls tools, cSats), and the model decides.
    const webMode = chatWebMode(conversation.web, get(webAutoStore));
    let useWeb = webOffered(webStatus, webMode);
    streamingWeb = undefined;
    streamingActivity = undefined;
    streamingWebOff = webMode === "auto" && webStatus?.reason === "needs_csats" ? "needs_csats" : undefined;
    let planned = false;
    if (projectRoot && !conversation.permissionMode) conversation.permissionMode = sentMode;

    try {
      if ((projectRoot || useWeb) && !usePortalChat) {
        // IDE agent mode — stream with tool events (no project: the web tool only, /v1/ide/web-chat)
        // A paid model's long chat is summarized first, so this and later turns send less.
        await compactNow(false);
        // The kept summary goes in place of the messages it covers (compaction.ts).
        const apiMessages: Array<{ role: string; content: string }> = historyForModel(conversation).messages;
        streamingContext = undefined;
        streamingCompacted = 0;
        streamingCostNotes = [];
        streamingToolEvents = [];
        streamingTurnId = undefined;
        streamingUsage = undefined;
        streamingChanged = [];
        const onEvent = (event: IdeStreamEvent) => {
          const next = applyAgentEvent(
            { text: streamingContent, toolEvents: streamingToolEvents, turnId: streamingTurnId, changedFiles: streamingChanged, usage: streamingUsage, web: streamingWeb, activity: streamingActivity, costNotes: streamingCostNotes },
            event,
          ).turn;
          if (next.text !== streamingContent) streamingContent = next.text;
          if (next.toolEvents !== streamingToolEvents) streamingToolEvents = next.toolEvents;
          streamingTurnId = next.turnId;
          streamingUsage = next.usage;
          streamingWeb = next.web;
          streamingActivity = next.activity;
          if (next.webOff) streamingWebOff = next.webOff.reason;
          if (next.contextTokens) streamingContext = next.contextTokens;
          if (next.compactedTokens) streamingCompacted = next.compactedTokens;
          if (next.costNotes && next.costNotes !== streamingCostNotes) streamingCostNotes = next.costNotes;
          if (next.changedFiles && next.changedFiles !== streamingChanged) streamingChanged = next.changedFiles;
          if (event.type !== "status" && event.type !== "done") scrollToBottom();
        };
        if (projectRoot) {
          const attached = await expandMentions(text);
          if (attached) apiMessages[apiMessages.length - 1] = { role: "user", content: `${attached}\n\n${text}` };
          planned = sentMode === "plan";
          await streamIdeChat(
            apiMessages,
            projectRoot,
            onEvent,
            abortController.signal,
            get(computeChoice),
            await agentGitHubToken().catch(() => null),
            sentMode,
            "chat",
            attachments,
            useWeb,
          );
        } else {
          if (inlineText !== text) apiMessages[apiMessages.length - 1] = { role: "user", content: inlineText };
          try {
            await streamIdeWebChat(apiMessages, onEvent, abortController.signal, get(computeChoice));
          } catch (err) {
            // Web wasn't offered for this reply after all (no cSats since the last check): answer without it.
            if (!(err instanceof WebOffError)) throw err;
            streamingWebOff = err.reason;
            useWeb = false;
            await streamLocalChat(inlineText);
          }
        }
      } else if (usePortalChat) {
        // Stream through the portal API (server persists messages)
        const portalConvId = await ensurePortalConversation();

        await streamPortalChat(
          portalConvId,
          inlineText,
          (chunk) => {
            streamingContent += chunk;
            streamingActivity = undefined;
            scrollToBottom();
          },
          abortController.signal,
          (progress) => {
            streamProgress = progress;
            if (progress.warning) meshWarning = progress.warning;
          },
          useWeb
            ? {
                onStatus: (m) => (streamingActivity = m),
                onWeb: (w) => {
                  const u = webUsageOf({ type: "web", ...w });
                  if (u) streamingWeb = u;
                },
                onWebOff: (off) => (streamingWebOff = off.reason),
              }
            : undefined,
        );
      } else {
        await streamLocalChat(inlineText);
      }

      addMessage(conversation, "assistant", streamingContent);
      attachTurn();
      if (planned && streamingContent.trim()) conversation.messages[conversation.messages.length - 1].plan = true;
      conversation = conversation;
      await saveConversation(conversation);
      localStorage.setItem("edgecoder-last-chat-id", conversation.id);

      // Auto-rename on portal if title is still default
      if (
        usePortalChat &&
        conversation.portalConversationId &&
        conversation.title.startsWith("New chat")
      ) {
        const newTitle =
          text.length > 40 ? text.substring(0, 40) + "..." : text;
        portalRenameConversation(
          conversation.portalConversationId,
          newTitle,
        ).catch(() => {});
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // Stopped: keep what arrived so far.
        if (streamingContent || streamingToolEvents.length > 0) {
          addMessage(conversation, "assistant", `${streamingContent}\n\n_(stopped)_`);
          attachTurn();
          conversation = conversation;
          await saveConversation(conversation);
        }
      } else {
        addMessage(conversation, "assistant", `Error: ${(err as Error).message}`);
        conversation = conversation;
      }
    } finally {
      // Set from the stream's callbacks, so TypeScript can't see it change here.
      const used = streamingWeb as WebUsage | undefined;
      if (streamingWebOff || (used && (used.searches > 0 || used.pages > 0))) onWebStale?.();
      streamingContent = "";
      streamingWeb = undefined;
      streamingActivity = undefined;
      isStreaming = false;
      streamProgress = undefined;
      streamingToolEvents = [];
      abortController = null;
    }
  }

  /** Stream through the local IDE provider (OpenAI-compatible format), without tools. */
  async function streamLocalChat(inlineText: string) {
    const apiMessages: Array<{ role: string; content: string }> = historyForModel(conversation).messages;
    if (inlineText !== apiMessages[apiMessages.length - 1]?.content) apiMessages[apiMessages.length - 1] = { role: "user", content: inlineText };
    await streamChat(
      apiMessages,
      (chunk) => {
        streamingContent += chunk;
        scrollToBottom();
      },
      abortController?.signal,
      (progress) => {
        streamProgress = progress;
      },
      get(computeChoice),
    );
  }

  /** Attach the streamed tool events and the turn's file changes to the last assistant message. */
  function attachTurn() {
    const lastMsg = conversation.messages[conversation.messages.length - 1];
    if (!lastMsg) return;
    if (streamingToolEvents.length > 0) lastMsg.toolEvents = [...streamingToolEvents];
    const usage = streamingUsage ?? freeReplyUsage(get(computeChoice));
    if (usage) lastMsg.usage = usage;
    if (streamingWeb && (streamingWeb.searches > 0 || streamingWeb.pages > 0)) lastMsg.web = streamingWeb;
    // No cSats: the reply came without the web; say so once per chat, quietly.
    if (streamingWebOff === "needs_csats" && !conversation.webCSatsNoted) {
      lastMsg.notice = NEEDS_CSATS_NOTE;
      conversation.webCSatsNoted = true;
    }
    if (streamingTurnId && streamingChanged.length > 0) {
      lastMsg.turnId = streamingTurnId;
      lastMsg.changedFiles = [...streamingChanged];
    }
    // The context meter: what the turn's last call sent, plus this reply.
    if (streamingContext) conversation.contextTokens = streamingContext + Math.ceil(lastMsg.content.length / 3);
    // Older messages were compacted inside this turn (they're sent whole again next time).
    if (streamingCompacted > 0 && !lastMsg.notice) lastMsg.notice = `Earlier messages summarized for this reply to save tokens · ~${streamingCompacted.toLocaleString("en-US")} tokens saved`;
    if (streamingCostNotes.length) lastMsg.notice = [lastMsg.notice, ...streamingCostNotes].filter(Boolean).join("\n");
    streamingCostNotes = [];
    streamingContext = undefined;
    streamingCompacted = 0;
  }

  /** A note in the conversation from the app itself (e.g. that a project was created). */
  export function addNote(text: string) {
    addMessage(conversation, "assistant", text);
    conversation = conversation;
  }

  /** Stop the reply that is streaming (the partial reply is kept). */
  export function stop() {
    abortController?.abort();
  }

  $effect(() => {
    onStreamingChange?.(isStreaming);
  });

  function scrollToBottom() {
    follower.contentChanged();
  }

  export async function newChat() {
    if (isStreaming && abortController) {
      abortController.abort();
    }
    // Save current conversation if it has messages
    if (conversation.messages.length > 0) {
      await saveConversation(conversation);
    }
    conversation = createConversation("chat");
    streamingContent = "";
    isStreaming = false;
    abortController = null;
    localStorage.setItem("edgecoder-last-chat-id", conversation.id);
  }

  export async function loadConversation(id: string) {
    if (isStreaming && abortController) {
      abortController.abort();
    }
    // Save current conversation if it has messages
    if (conversation.messages.length > 0) {
      await saveConversation(conversation);
    }
    const loaded = await loadConversationFromDb(id);
    if (loaded) {
      conversation = loaded;
      streamingContent = "";
      isStreaming = false;
      abortController = null;
    }
  }

  export function getConversationId(): string {
    return conversation.id;
  }

  /** The last reply is a plan waiting for approval (the chat is still in Plan mode). */
  const pendingPlan = $derived(!isStreaming && !!projectRoot && mode === "plan" && conversation.messages.at(-1)?.role === "assistant" && conversation.messages.at(-1)?.plan === true);
  function approvePlan(next: EngineMode) {
    setMode(next);
    void sendMessage(PLAN_APPROVED_MESSAGE);
  }

  function handleQuickAction(prompt: string) {
    sendMessage(prompt);
  }
</script>

<div class="chat-view" bind:this={scrollContainer} use:follower.action>
  {#if !usePortalChat && $serviceStatus.phase !== "ready"}<div class="service-notice"><ServiceNotice /></div>{/if}
  {#if meshWarning}
    <div class="mesh-warning">
      <span class="mesh-warning-icon">&#9888;</span>
      <span>{meshWarning}</span>
    </div>
  {/if}

  {#if pullProgress}
    <div class="pull-banner">
      <span class="pull-label">Downloading {pullProgress.model}</span>
      <div class="pull-bar-track">
        <div class="pull-bar-fill" style="width: {pullProgress.progressPct}%"></div>
      </div>
      <span class="pull-pct">{pullProgress.progressPct}%</span>
    </div>
  {/if}

  {#if conversation.messages.length === 0 && !isStreaming}
    <div class="empty-state">
      <h2>What would you like to build?</h2>
      <p>Ask a question, or describe a change. With a project open, the agent can read and edit its files and run commands.</p>
      <div class="quick-actions">
        {#each quickActions as action}
          <button class="chip" onclick={() => handleQuickAction(action.prompt)}>
            {action.label}
          </button>
        {/each}
      </div>
      {#if onRepoConnected && !usePortalChat}
        <div class="connect-slot">
          <ConnectRepo bind:this={connectRepoBox} onConnected={repoConnected} />
        </div>
      {/if}
    </div>
  {:else}
    <div class="messages">
      {#each conversation.messages as msg (msg.id)}
        <ChatMessage role={msg.role as "user" | "assistant"} content={msg.content} toolEvents={msg.toolEvents} turnId={msg.turnId} changedFiles={msg.changedFiles} usage={msg.usage} web={msg.web} notice={msg.notice} {onOpenPath} {onPreview} {onOpenInEditor} onToolApproval={handleToolApproval} />
        {#if conversation.summary?.throughId === msg.id}<CompactionNote savedTokens={conversation.summary.savedTokens} />{/if}
      {/each}
      {#if isStreaming && (streamingContent || streamingToolEvents.length > 0 || streamingActivity)}
        <ChatMessage role="assistant" content={streamingContent} streaming={true} {streamProgress} toolEvents={streamingToolEvents} activity={streamingActivity} {onOpenInEditor} onToolApproval={handleToolApproval} onToolAlways={(id) => handleToolApproval(id, true, true)} onToolForRun={(id) => handleToolApproval(id, true, false, true)} onCostChoice={handleCostChoice} costNotes={streamingCostNotes} />
      {/if}
      {#if pendingPlan}
        <PlanApproval onApprove={approvePlan} onRevise={() => onFocusComposer?.()} />
      {/if}
    </div>
  {/if}
  {#if onQuote}<QuoteSelection scope={scrollContainer} {onQuote} />{/if}
  <JumpToLatest visible={!follow.atBottom && (conversation.messages.length > 0 || isStreaming)} unseen={follow.unseen} onJump={follower.jump} />
</div>

<style>
  .chat-view {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .connect-slot {
    width: 100%;
    max-width: 520px;
    display: flex;
    justify-content: center;
    margin-top: 24px;
    padding-top: 24px;
    border-top: 0.5px solid var(--border);
  }
  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    text-align: center;
    padding: 24px;
  }
  .empty-state h2 {
    margin: 0;
    font-size: var(--fs-xl);
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text-primary);
  }
  .empty-state p {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--fs-base);
    max-width: 440px;
  }
  .quick-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    margin-top: 8px;
  }
  .chip {
    height: var(--control-md);
    padding: 0 12px;
    border: 0.5px solid var(--border-strong);
    background: transparent;
    color: var(--text-secondary);
    border-radius: 999px;
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-sm);
    transition: background-color .12s, color .12s;
  }
  .chip:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }
  .messages {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 24px;
    max-width: 760px;
    width: 100%;
    margin: 0 auto;
    padding: 24px 24px 16px;
    box-sizing: border-box;
  }
  .service-notice { padding: 0.75rem 1rem 0; }
  .mesh-warning {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    background: color-mix(in srgb, var(--yellow) 8%, transparent);
    border-bottom: 0.5px solid color-mix(in srgb, var(--yellow) 20%, transparent);
    font-size: 12px;
    color: var(--yellow);
    flex-shrink: 0;
  }
  .mesh-warning-icon {
    flex-shrink: 0;
  }
  .pull-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 16px;
    background: var(--bg-surface);
    border-bottom: 0.5px solid var(--border);
    font-size: 12px;
    color: var(--text-secondary);
    flex-shrink: 0;
  }
  .pull-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
  }
  .pull-bar-track {
    flex: 1;
    height: 4px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
  }
  .pull-bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    transition: width 0.3s ease;
  }
  .pull-pct {
    min-width: 32px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
</style>
