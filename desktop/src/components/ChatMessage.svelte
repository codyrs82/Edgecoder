<script lang="ts">
  import MarkdownRenderer from "./MarkdownRenderer.svelte";
  import StreamingIndicator from "./StreamingIndicator.svelte";
  import ToolCallBlock from "./ToolCallBlock.svelte";
  import CostCheckCard from "./CostCheckCard.svelte";
  import { COST_CHECK_TOOL } from "../lib/cost-check";
  import ShellBlock from "./ShellBlock.svelte";
  import DiffBlock from "./DiffBlock.svelte";
  import PlanBlock from "./PlanBlock.svelte";
  import ChangesCard from "./ChangesCard.svelte";
  import NetworkTaskCard from "./NetworkTaskCard.svelte";
  import WebSources from "./WebSources.svelte";
  import type { WebUsage } from "../lib/web-tool";
  import type { StreamProgress } from "../lib/api";
  import { usageText } from "../lib/compute-choice";
  import { servedBreakdown, servedLine, type CallUsage } from "../lib/served";
  import type { ToolEvent } from "../lib/types";
  import { ChevronRight } from "@lucide/svelte";
  import { summarizeSteps, toolStepStatus } from "../lib/tool-steps";
  import { Copy, Check } from "@lucide/svelte";
  import { FAILURE_LINE, failureDetail, failureKind, splitModelError } from "../lib/failures";
  import { neededCSatsIn, requestBuy, suggestedTopUpSats } from "../lib/buy-csats";

  interface Props {
    role: "user" | "assistant";
    content: string;
    streaming?: boolean;
    streamProgress?: StreamProgress;
    onOpenInEditor?: (code: string, language: string) => void;
    toolEvents?: ToolEvent[];
    onToolApproval?: (id: string, approved: boolean) => void;
    /** "Always allow" on an approval card: approve and keep the call's rule for the project. */
    onToolAlways?: (id: string) => void;
    /** "Allow for the rest of this run" on a web-page guard ask (this computer only, never the phone). */
    onToolForRun?: (id: string) => void;
    /** "Allow for this session" on an approval card: approve and let later calls of its kind run this session. */
    onToolSession?: (id: string) => void;
    /** Agent turn checkpoint and the files it wrote: shows the review / undo card. */
    turnId?: string;
    changedFiles?: string[];
    onFilesReverted?: () => void;
    onOpenPath?: (path: string) => void;
    networkTaskId?: string;
    onPreview?: (path: string) => void;
    /** What the reply cost and where it ran. */
    usage?: { cSats: number; where?: string; calls?: CallUsage[] };
    /** The web tool's searches and pages for this reply, with the numbered sources it cites. */
    web?: WebUsage;
    /** While streaming: what the web tool is doing ("Searching the web…"). */
    activity?: string;
    /** A quiet note under the reply ("Web search needs cSats", once per chat). */
    notice?: string;
    /**
     * A paid reply's cost check (CostCheckCard): Keep going, Switch (with the suggested model) or
     * Stop. Without it the card answers through onToolApproval (Keep going / Stop only).
     */
    onCostChoice?: (id: string, choice: "continue" | "switch" | "stop", suggest?: { id: string; name: string }) => void;
    /** While streaming: the reply's cost notes ("Skipped re-reading 3 unchanged files · ~90K tokens saved"). */
    costNotes?: string[];
  }
  /** The footer's tooltip: each model call (machine, hardware, region, timings, cost). */
  function usageTitle(u: { cSats: number; where?: string; calls?: CallUsage[] }): string {
    return u.calls?.length ? `Where this reply ran:\n${servedBreakdown(u.calls)}` : "Where this reply ran and what it cost";
  }

  let { role, content, streaming = false, streamProgress, onOpenInEditor, toolEvents, onToolApproval, onToolAlways, onToolForRun, onToolSession, turnId, changedFiles, onFilesReverted, onOpenPath, networkTaskId, onPreview, usage, web, activity, notice, onCostChoice, costNotes }: Props = $props();

  /** A failed reply: its text, and the error as one compact notice (with Buy cSats when it's money). */
  let failed = $derived(role === "assistant" && !streaming ? splitModelError(content) : { text: content, error: undefined });
  let failure = $derived(failed.error ? failureKind(failed.error) : null);
  function buy() {
    requestBuy({ amountSats: suggestedTopUpSats({ stepCSats: neededCSatsIn(failed.error) }), returnTo: "the chat" });
  }

  /** A finished turn's steps start folded into their summary line. */
  let stepsOpen = $state(false);
  let copied = $state(false);
  function copyReply() {
    void navigator.clipboard?.writeText(content).then(() => {
      copied = true;
      setTimeout(() => (copied = false), 1500);
    }).catch(() => {});
  }
</script>

<div class="message {role}">
  {#if role === "user"}
    <div class="bubble user-bubble" data-quotable>{content}</div>
  {:else}
    <div class="bubble assistant-bubble">
      {#if toolEvents && toolEvents.length > 0}
        {@const stepCount = toolEvents.filter((e) => (e.type === "tool_call" && e.tool !== COST_CHECK_TOOL) || e.type === "shell_output").length}
        {#if !streaming && stepCount >= 2}
          <!-- A finished turn's steps fold into one line ("Read 2 files, edited 1 file · 5 steps"). -->
          <button type="button" class="steps-summary" aria-expanded={stepsOpen} onclick={() => (stepsOpen = !stepsOpen)}>
            <span class="steps-chev" class:open={stepsOpen} aria-hidden="true"><ChevronRight size={13} /></span>
            <span class="steps-text">{summarizeSteps(toolEvents)}</span>
            <span class="steps-count">· {stepCount} steps</span>
          </button>
        {/if}
        {#if streaming || stepCount < 2 || stepsOpen}
        <div class="tool-events" class:folded={!streaming && stepCount >= 2}>
          {#each toolEvents as evt}
              {#if evt.type === "tool_call" && evt.tool === COST_CHECK_TOOL}
                <CostCheckCard
                  id={evt.id ?? ""}
                  args={evt.args ?? {}}
                  pending={streaming && evt.approval_status === "pending" && !evt.result}
                  result={evt.result}
                  canSwitch={!!onCostChoice}
                  onChoice={onCostChoice ?? ((id, choice) => onToolApproval?.(id, choice !== "stop"))}
                />
              {:else if evt.type === "tool_call"}
                <ToolCallBlock
                  id={evt.id ?? ""}
                  tool={evt.tool ?? "unknown"}
                  args={evt.args ?? {}}
                  requiresApproval={evt.requires_approval ?? false}
                  result={evt.result}
                  error={evt.error}
                  status={toolStepStatus(evt)}
                  onApprove={(id) => onToolApproval?.(id, true)}
                  onReject={(id) => onToolApproval?.(id, false)}
                  allowRule={evt.allow_rule}
                  allowRules={evt.allow_rules}
                  onAlways={onToolAlways}
                  webGuard={evt.web_guard === true}
                  runsEdited={evt.runs_edited}
                  onForRun={onToolForRun}
                  allowSession={evt.allow_session}
                  sessionAllowed={evt.session_allowed}
                  onSession={onToolSession}
                />
              {:else if evt.type === "shell_output"}
                <ShellBlock
                  id={evt.id ?? ""}
                  command={evt.command}
                  stdout={evt.stdout}
                  stderr={evt.stderr}
                  exitCode={evt.exit_code}
                  status="completed"
                />
              {:else if evt.type === "diff"}
                <DiffBlock
                  id={evt.id ?? ""}
                  file={evt.file ?? "unknown"}
                  hunks={evt.hunks ?? []}
                  status="accepted"
                />
              {:else if evt.type === "plan"}
                <PlanBlock
                  steps={(evt.steps ?? []).map(s => ({ ...s, status: s.status as "pending" | "in_progress" | "completed" | "failed" }))}
                  planStatus={(evt.plan_status ?? "proposed") as "proposed" | "approved" | "executing"}
                />
              {/if}
            {/each}
        </div>
        {/if}
      {/if}
      <!-- data-quotable: selected text here can be added to the chat as a quote (QuoteSelection). -->
      {#if failed.text.trim() || !failed.error}
        <div data-quotable><MarkdownRenderer source={failed.text} {onOpenInEditor} /></div>
      {/if}
      {#if failed.error && failure}
        <!-- One compact notice instead of a raw error bubble; money problems lead to Buy cSats. -->
        <div class="reply-failure" role="note" data-testid="reply-failure" title={failed.error}>
          <span class="rf-text"><span class="rf-title">{FAILURE_LINE[failure]}</span>{#if failure === "csats" || failure === "class" || failure === "other"}{" "}<span class="rf-detail">· {failureDetail(failed.error)}</span>{/if}</span>
          {#if failure === "csats"}<button type="button" class="rf-buy" onclick={buy}>Buy cSats</button>{/if}
        </div>
      {/if}
      {#if networkTaskId}
        <NetworkTaskCard taskId={networkTaskId} />
      {/if}
      {#if turnId && changedFiles && changedFiles.length > 0 && !streaming}
        <ChangesCard {turnId} files={changedFiles} onReverted={onFilesReverted} {onOpenPath} {onPreview} />
      {/if}
      {#if web && !streaming}
        <WebSources {web} text={failed.text} />
      {/if}
      {#if notice && !streaming}
        <div class="reply-notice" role="note">{notice}</div>
      {/if}
      {#if streaming && costNotes?.length}
        {#each costNotes as n, i (i)}<div class="reply-notice" role="note">{n}</div>{/each}
      {/if}
      {#if streaming && activity}
        <div class="web-activity" role="status">{activity}</div>
      {/if}
      {#if streaming}
        <StreamingIndicator progress={streamProgress} />
      {/if}
      {#if !streaming && content.trim()}
        <div class="reply-footer">
          <button type="button" class="icon-btn icon-btn--sm" title={copied ? "Copied" : "Copy reply"} aria-label={copied ? "Copied" : "Copy reply"} onclick={copyReply}>
            {#if copied}<Check size={14} />{:else}<Copy size={14} />{/if}
          </button>
          {#if usage && usageText(usage)}
            <span class="reply-usage" title={usageTitle(usage)}>{servedLine(usage.calls) ?? usageText(usage)}</span>
          {/if}
        </div>
      {:else if usage && !streaming && usageText(usage)}
        <div class="reply-footer"><span class="reply-usage" title={usageTitle(usage)}>{servedLine(usage.calls) ?? usageText(usage)}</span></div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .web-activity { margin-top: 6px; font-size: var(--fs-sm); color: var(--text-secondary); }
  .reply-notice { margin-top: 6px; font-size: var(--fs-xs); color: var(--text-muted); white-space: pre-line; }
  .reply-failure { display: flex; align-items: center; gap: 10px; margin-top: 4px; padding: 6px 10px; border-radius: 8px; background: var(--bg-surface); font-size: 12.5px; color: var(--text-secondary); }
  .rf-text { flex: 1; min-width: 0; }
  .rf-title { color: var(--text-primary); font-weight: 500; }
  .rf-buy { flex-shrink: 0; border: 1px solid var(--accent); background: var(--accent); color: var(--on-accent); border-radius: 6px; padding: 3px 10px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .message {
    display: flex;
    min-width: 0;
  }
  .message.user {
    justify-content: flex-end;
  }
  .bubble {
    min-width: 0;
  }
  /* The user's turn: a compact bubble on the right. */
  .user-bubble {
    max-width: min(80%, 560px);
    padding: 8px 14px;
    border-radius: var(--radius-xl);
    background: var(--bg-elevated);
    color: var(--text-primary);
    font-size: var(--prose-size, var(--fs-md));
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  /* The reply: full-width prose, no box. */
  .assistant-bubble {
    width: 100%;
    color: var(--text-primary);
  }
  .steps-summary {
    display: inline-flex;
    max-width: 100%;
    align-items: center;
    gap: 6px;
    margin: 0 0 8px -6px;
    padding: 3px 6px;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--fs-sm);
    cursor: pointer;
  }
  .steps-summary:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .steps-chev {
    display: inline-flex;
    transition: transform 0.15s;
  }
  .steps-chev.open {
    transform: rotate(90deg);
  }
  .steps-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .steps-count {
    flex-shrink: 0;
    white-space: nowrap;
    color: var(--text-muted);
  }
  .tool-events {
    margin: 0 0 10px -6px;
  }
  .reply-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 0 0 -4px;
  }
  .reply-usage {
    font-size: var(--fs-xs);
    color: var(--text-muted);
  }
</style>
