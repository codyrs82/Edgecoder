<script lang="ts">
  import MarkdownRenderer from "./MarkdownRenderer.svelte";
  import StreamingIndicator from "./StreamingIndicator.svelte";
  import ToolCallBlock from "./ToolCallBlock.svelte";
  import ShellBlock from "./ShellBlock.svelte";
  import DiffBlock from "./DiffBlock.svelte";
  import PlanBlock from "./PlanBlock.svelte";
  import ChangesCard from "./ChangesCard.svelte";
  import NetworkTaskCard from "./NetworkTaskCard.svelte";
  import type { StreamProgress } from "../lib/api";
  import { usageText } from "../lib/compute-choice";
  import type { ToolEvent } from "../lib/types";
  import { ChevronRight } from "@lucide/svelte";
  import { summarizeSteps } from "../lib/tool-steps";
  import { Copy, Check } from "@lucide/svelte";

  interface Props {
    role: "user" | "assistant";
    content: string;
    streaming?: boolean;
    streamProgress?: StreamProgress;
    onOpenInEditor?: (code: string, language: string) => void;
    toolEvents?: ToolEvent[];
    onToolApproval?: (id: string, approved: boolean) => void;
    /** Agent turn checkpoint and the files it wrote: shows the review / undo card. */
    turnId?: string;
    changedFiles?: string[];
    onFilesReverted?: () => void;
    onOpenPath?: (path: string) => void;
    networkTaskId?: string;
    onPreview?: (path: string) => void;
    /** What the reply cost and where it ran. */
    usage?: { cSats: number; where?: string };
  }
  let { role, content, streaming = false, streamProgress, onOpenInEditor, toolEvents, onToolApproval, turnId, changedFiles, onFilesReverted, onOpenPath, networkTaskId, onPreview, usage }: Props = $props();

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
    <div class="bubble user-bubble">{content}</div>
  {:else}
    <div class="bubble assistant-bubble">
      {#if toolEvents && toolEvents.length > 0}
        {@const stepCount = toolEvents.filter((e) => e.type === "tool_call" || e.type === "shell_output").length}
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
              {#if evt.type === "tool_call"}
                <ToolCallBlock
                  id={evt.id ?? ""}
                  tool={evt.tool ?? "unknown"}
                  args={evt.args ?? {}}
                  requiresApproval={evt.requires_approval ?? false}
                  result={evt.result}
                  error={evt.error}
                  status={evt.error ? "completed" : evt.result !== undefined ? "completed" : evt.approval_status === "rejected" ? "rejected" : evt.approval_status === "pending" ? "pending" : "executing"}
                  onApprove={(id) => onToolApproval?.(id, true)}
                  onReject={(id) => onToolApproval?.(id, false)}
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
      <MarkdownRenderer source={content} {onOpenInEditor} />
      {#if networkTaskId}
        <NetworkTaskCard taskId={networkTaskId} />
      {/if}
      {#if turnId && changedFiles && changedFiles.length > 0 && !streaming}
        <ChangesCard {turnId} files={changedFiles} onReverted={onFilesReverted} {onOpenPath} {onPreview} />
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
            <span class="reply-usage" title="Where this reply ran and what it cost">{usageText(usage)}</span>
          {/if}
        </div>
      {:else if usage && !streaming && usageText(usage)}
        <div class="reply-footer"><span class="reply-usage" title="Where this reply ran and what it cost">{usageText(usage)}</span></div>
      {/if}
    </div>
  {/if}
</div>

<style>
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
