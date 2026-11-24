<script lang="ts">
  import ToolArgs from "./ToolArgs.svelte";
  import { editDiff, failureReason, stepLabel, type StepStatus } from "../lib/tool-steps";

  interface Props {
    id: string;
    tool: string;
    args: Record<string, unknown>;
    requiresApproval: boolean;
    result?: string;
    error?: string;
    status: StepStatus;
    onApprove?: (id: string) => void;
    onReject?: (id: string) => void;
    /** "Always allow `rule` in this project": shown when the call offers a rule and this is set. */
    allowRule?: string;
    /** A command line's rules, one per part (`python3 tools/x.py:*`, ...); allowRule is the first. */
    allowRules?: string[];
    onAlways?: (id: string) => void;
    /** Asked only because a web page was read this run: the mode would have run it on its own. */
    webGuard?: boolean;
    /** With webGuard: the file this run changed that the call runs (no run-wide answer for it). */
    runsEdited?: string;
    /** "Allow for the rest of this run" (only with webGuard): later calls like it go ahead until the run ends. */
    onForRun?: (id: string) => void;
    /** "Allow for this session" (never with webGuard): what it lets run without asking ("npm test commands"). */
    allowSession?: string;
    /** Approve and allow later calls like it for the rest of the session (or run). */
    onSession?: (id: string) => void;
    /** "session": a chat or shared session; "run": a bot's run. */
    sessionScope?: "session" | "run";
    /** Ran without asking because of an earlier "Allow for this session": what was allowed. */
    sessionAllowed?: string;
  }
  let {
    id,
    tool,
    args,
    requiresApproval,
    result,
    error,
    status,
    onApprove,
    onReject,
    allowRule,
    allowRules,
    onAlways,
    webGuard = false,
    runsEdited,
    onForRun,
    allowSession,
    onSession,
    sessionScope = "session",
    sessionAllowed,
  }: Props = $props();

  let scopeWord = $derived(sessionScope === "run" ? "run" : "session");

  /** The rules "Always allow" keeps (one per part of a command line). */
  let rules = $derived(allowRules?.length ? allowRules : allowRule ? [allowRule] : []);

  let expanded = $state(false);

  const MAX_RESULT_LENGTH = 2000;

  const readTools = [
    "read_file",
    "list_directory",
    "search_files",
    "git_status",
    "git_diff",
    "git_log",
    "git_fetch",
    "github_list_prs",
    "github_list_issues",
  ];

  let borderColor = $derived.by(() => {
    if (status === "rejected" || status === "failed") return "var(--red)";
    if (status === "completed") return "var(--green)";
    if (status === "pending" && requiresApproval)
      return "var(--yellow)";
    if (readTools.includes(tool))
      return "var(--accent-secondary)";
    return "var(--yellow)";
  });

  /** Waiting for the user's Allow / Deny: the whole call is shown, nothing shortened. */
  let asking = $derived(status === "pending" && requiresApproval);

  // One-line summary for the header of a call that is not waiting for approval.
  let mainArg = $derived.by(() => {
    const keys = ["path", "file_path", "command", "pattern", "query", "url"];
    for (const key of keys) {
      if (args[key] && typeof args[key] === "string") {
        const val = args[key] as string;
        return val.length > 60 ? val.slice(0, 57) + "..." : val;
      }
    }
    return "";
  });

  /** "Read" + "index.html": the step in plain words (the tool's own name is the tooltip). */
  let label = $derived(stepLabel(tool, args, status !== "executing" && !(status === "pending" && requiresApproval), status === "failed"));
  /** The lines an edit changes, shown instead of its raw arguments. */
  let diff = $derived(editDiff(tool, args));

  let truncatedResult = $derived.by(() => {
    if (!result) return "";
    if (result.length > MAX_RESULT_LENGTH) {
      return result.slice(0, MAX_RESULT_LENGTH) + "\n... (truncated)";
    }
    return result;
  });

  function toggle() {
    expanded = !expanded;
  }

  function handleApprove(e: MouseEvent) {
    e.stopPropagation();
    onApprove?.(id);
  }

  function handleAlways(e: MouseEvent) {
    e.stopPropagation();
    onAlways?.(id);
  }

  function handleForRun(e: MouseEvent) {
    e.stopPropagation();
    onForRun?.(id);
  }

  function handleSession(e: MouseEvent) {
    e.stopPropagation();
    onSession?.(id);
  }

  function handleReject(e: MouseEvent) {
    e.stopPropagation();
    onReject?.(id);
  }
</script>

<div class="tool-call-block" class:asking style="--step-color: {borderColor}">
  <button class="header" onclick={toggle} type="button" aria-expanded={expanded} title={tool}>
    <span class="tool-info">
      {#if status === "executing"}
        <span class="spinner"></span>
      {:else if status === "completed"}
        <span class="icon check" role="img" aria-label="Completed">&#10003;</span>
      {:else if status === "rejected"}
        <span class="icon cross" role="img" aria-label="Rejected">&#10007;</span>
      {:else if status === "failed"}
        <span class="icon cross" role="img" aria-label="Failed">&#10007;</span>
      {:else}
        <span class="dot" style="background: {borderColor}"></span>
      {/if}
      <span class="tool-name">{label.verb}</span>
      {#if label.target && !asking}
        <span class="main-arg" title={label.target}>{label.target}</span>
      {:else if mainArg && !asking}
        <span class="main-arg">{mainArg}</span>
      {/if}
      {#if status === "failed" && error}
        <span class="fail-reason" title={error}>{failureReason(error)}</span>
      {/if}
      {#if sessionAllowed && !asking}
        <span class="session-allowed" title="Allowed: {sessionAllowed}" data-testid="session-allowed">Allowed for this {scopeWord}</span>
      {/if}
    </span>
    <span class="chevron" class:open={expanded} aria-hidden="true">&#9656;</span>
  </button>

  {#if asking}
    <!-- Everything the user is about to approve, always open: full command, full arguments,
         the content an edit writes. Never shortened (the header summary is hidden meanwhile). -->
    <div class="approval-details" data-testid="approval-details">
      <ToolArgs {tool} {args} />
    </div>
    {#if webGuard}
      <p class="guard-note" data-testid="web-guard-note">
        {#if runsEdited}Asked because this run read a web page and changed <code>{runsEdited}</code>, which this runs.{:else}Asked because this run read a web page. Your permission mode would run it without asking.{/if}
      </p>
    {/if}
    <div class="approval-bar">
      <span class="approval-label">Approve this action?</span>
      <div class="approval-actions">
        <button class="btn allow" onclick={handleApprove} type="button"
          >Allow</button
        >
        {#if webGuard && !runsEdited && onForRun}
          <button class="btn always" onclick={handleForRun} type="button" title="Calls your permission mode runs anyway stop asking until this run ends. Anything the mode asks about still asks."
            >Allow for the rest of this run</button
          >
        {/if}
        {#if allowSession && onSession && !webGuard}
          <button class="btn always" onclick={handleSession} type="button" data-testid="allow-session" title="Also runs {allowSession} without asking until this {scopeWord} ends. Never covers pushes, pull requests, secrets, files outside the project or refused commands."
            >Allow for this {scopeWord}: <span class="session-label">{allowSession}</span></button
          >
        {/if}
        {#if rules.length && onAlways}
          <button class="btn always" onclick={handleAlways} type="button" title="Commands starting with this run without asking in this project. Remove it in Settings → General → Always-allowed commands."
            >Always allow {#each rules as r, i (r)}{i ? ", " : ""}<code>{r.replace(/:\*$/, " …")}</code>{/each} in this project</button
          >
        {/if}
        <button class="btn deny" onclick={handleReject} type="button"
          >Deny</button
        >
      </div>
    </div>
  {/if}

  {#if expanded}
    <div class="body">
      {#if !asking}
        {#if diff}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <pre class="step-diff" tabindex="0" aria-label="Changes to {label.target || 'the file'}">{#each diff as l, i (i)}<span class="dl {l.kind}"><span class="sign" aria-hidden="true">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>{l.text}</span>{/each}</pre>
        {:else}
          <div class="body-args"><ToolArgs {tool} {args} /></div>
        {/if}
      {/if}
      {#if error}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <pre class="output error-output" tabindex="0" aria-label="Tool error">{error}</pre>
      {:else if truncatedResult}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <pre class="output" tabindex="0" aria-label="Tool result">{truncatedResult}</pre>
      {:else if status === "executing"}
        <span class="placeholder">Running...</span>
      {:else}
        <span class="placeholder">No output</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* One quiet line per step, like Claude Code and Cursor; a call waiting for approval is a card. */
  .tool-call-block {
    border-radius: var(--radius-sm);
    margin: 0;
    overflow: hidden;
  }
  .tool-call-block.asking {
    margin: 6px 0;
    border: 0.5px solid var(--border-strong);
    border-left: 3px solid var(--step-color);
    background: var(--bg-surface);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    min-height: 26px;
    padding: 3px 6px;
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    cursor: pointer;
    font-size: var(--fs-sm);
    font-family: inherit;
    text-align: left;
  }
  .asking .header {
    padding: 8px 12px;
    color: var(--text-primary);
  }
  .header:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .step-diff {
    margin: 0 0 8px;
    padding: 6px 0;
    max-height: 320px;
    overflow: auto;
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 1.5;
  }
  .dl {
    display: block;
    padding: 0 10px 0 4px;
    white-space: pre;
    color: var(--text-secondary);
  }
  .dl .sign {
    display: inline-block;
    width: 14px;
    color: var(--text-muted);
  }
  .dl.add {
    background: color-mix(in srgb, var(--green) 14%, transparent);
    color: var(--text-primary);
  }
  .dl.del {
    background: color-mix(in srgb, var(--red) 14%, transparent);
    color: var(--text-primary);
  }

  .tool-info {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    overflow: hidden;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .icon {
    font-size: 13px;
    flex-shrink: 0;
    line-height: 1;
  }
  .icon.check {
    color: var(--green);
  }
  .icon.cross {
    color: var(--red);
  }

  /* Why a step failed, in its header (the full error is in its details). */
  .fail-reason {
    color: var(--red);
    font-size: 12px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid var(--border-strong);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }

  .tool-name {
    font-weight: 500;
    white-space: nowrap;
  }

  .main-arg {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chevron {
    font-size: 12px;
    color: var(--text-muted);
    transition: transform 0.15s ease;
    flex-shrink: 0;
    margin-left: 8px;
  }
  .chevron.open {
    transform: rotate(90deg);
  }

  .approval-details {
    padding: 8px 12px;
    border-top: 1px solid var(--border);
  }
  .body-args {
    margin-bottom: 8px;
  }

  .guard-note {
    margin: 0;
    padding: 6px 12px 0;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .approval-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: color-mix(in srgb, var(--yellow) 8%, transparent);
    border-top: 1px solid var(--border);
  }
  .approval-label {
    font-size: 12px;
    color: var(--yellow);
    font-weight: 500;
  }
  .approval-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
  }

  .btn {
    padding: 3px 12px;
    border-radius: var(--radius-sm);
    border: none;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  .btn:hover {
    opacity: 0.85;
  }
  .btn.allow {
    background: var(--green);
    color: var(--bg-deep);
  }
  .btn.deny {
    background: var(--red);
    color: var(--bg-deep);
  }
  .btn.always {
    background: transparent;
    color: var(--text-primary);
    border: 0.5px solid var(--border-strong);
    font-weight: 400;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .btn.always code {
    font-size: 11px;
  }
  .btn.always .session-label {
    color: var(--text-secondary);
  }

  /* "Allowed for this session": quiet, after the step's summary. */
  .session-allowed {
    flex-shrink: 0;
    color: var(--text-muted);
    font-size: 11px;
    white-space: nowrap;
  }

  .body {
    padding: 4px 6px 8px 26px;
  }
  .asking .body {
    border-top: 1px solid var(--border);
    padding: 8px 12px;
  }

  .output {
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 300px;
    overflow-y: auto;
    margin: 0;
  }

  .error-output {
    color: var(--red);
  }

  .placeholder {
    font-size: 12px;
    color: var(--text-muted);
    font-style: italic;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
