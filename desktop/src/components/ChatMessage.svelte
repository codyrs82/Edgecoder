<script lang="ts">
  import MarkdownRenderer from "./MarkdownRenderer.svelte";
  import StreamingIndicator from "./StreamingIndicator.svelte";
  import ToolCallBlock from "./ToolCallBlock.svelte";
  import ShellBlock from "./ShellBlock.svelte";
  import DiffBlock from "./DiffBlock.svelte";
  import PlanBlock from "./PlanBlock.svelte";
  import type { StreamProgress } from "../lib/api";
  import type { ToolEvent } from "../lib/types";

  interface Props {
    role: "user" | "assistant";
    content: string;
    streaming?: boolean;
    streamProgress?: StreamProgress;
    onOpenInEditor?: (code: string, language: string) => void;
    toolEvents?: ToolEvent[];
    onToolApproval?: (id: string, approved: boolean) => void;
  }
  let { role, content, streaming = false, streamProgress, onOpenInEditor, toolEvents, onToolApproval }: Props = $props();
</script>

<div class="message {role}">
  {#if role === "user"}
    <div class="bubble user-bubble">{content}</div>
  {:else}
    <div class="bubble assistant-bubble">
      <MarkdownRenderer source={content} {onOpenInEditor} />
      {#if toolEvents && toolEvents.length > 0}
        <div class="tool-events">
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
      {#if streaming}
        <StreamingIndicator progress={streamProgress} />
      {/if}
    </div>
  {/if}
</div>

<style>
  .message {
    display: flex;
    margin-bottom: 16px;
    padding: 0 16px;
  }
  .message.user {
    justify-content: flex-end;
  }
  .message.assistant {
    justify-content: flex-start;
  }
  .bubble {
    max-width: 85%;
    border-radius: var(--radius-md);
    padding: 10px 14px;
  }
  .user-bubble {
    background: var(--bg-surface);
    color: var(--text-primary);
    font-size: 14px;
    line-height: 1.5;
    white-space: pre-wrap;
  }
  .assistant-bubble {
    color: var(--text-primary);
  }
  .tool-events {
    margin-top: 8px;
  }
  .message:hover {
    opacity: 1;
  }
</style>
