<script lang="ts">
  interface Step {
    index: number;
    description: string;
    status: "pending" | "in_progress" | "completed" | "failed";
  }

  interface Props {
    steps: Array<Step>;
    planStatus: "proposed" | "approved" | "executing";
  }
  let { steps, planStatus }: Props = $props();

  function badgeClass(s: string): string {
    switch (s) {
      case "proposed": return "badge-proposed";
      case "approved": return "badge-approved";
      case "executing": return "badge-executing";
      default: return "";
    }
  }
</script>

<div class="plan-block">
  <div class="header">
    <span class="title">Plan</span>
    <span class="badge {badgeClass(planStatus)}">{planStatus}</span>
  </div>

  <div class="body">
    {#each steps as step}
      <div class="step {step.status}">
        <span class="step-indicator">
          {#if step.status === "completed"}
            <span class="icon check">&#10003;</span>
          {:else if step.status === "failed"}
            <span class="icon cross">&#10007;</span>
          {:else if step.status === "in_progress"}
            <span class="icon play">&#9654;</span>
          {:else}
            <span class="step-number">{step.index + 1}</span>
          {/if}
        </span>
        <span class="step-description">{step.description}</span>
      </div>
    {/each}
  </div>
</div>

<style>
  .plan-block {
    border-left: 3px solid var(--accent, #3b82f6);
    border-radius: var(--radius-sm, 6px);
    background: var(--bg-surface, #3a3a37);
    margin: 6px 0;
    overflow: hidden;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border, rgba(214, 204, 194, 0.08));
  }

  .title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary, #f7f5f0);
  }

  .badge {
    font-size: 11px;
    font-weight: 500;
    padding: 2px 8px;
    border-radius: 10px;
    text-transform: capitalize;
  }
  .badge-proposed {
    color: var(--text-muted, #8a8478);
    background: var(--bg-elevated, #454542);
  }
  .badge-approved {
    color: var(--green, #4ade80);
    background: rgba(74, 222, 128, 0.1);
  }
  .badge-executing {
    color: var(--accent, #3b82f6);
    background: rgba(59, 130, 246, 0.1);
  }

  .body {
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .step {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 4px 0;
  }

  .step-indicator {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .step-number {
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    font-weight: 500;
    color: var(--text-muted, #8a8478);
  }

  .icon {
    font-size: 13px;
    line-height: 1;
  }
  .icon.check {
    color: var(--green, #4ade80);
  }
  .icon.cross {
    color: var(--red, #f87171);
  }
  .icon.play {
    color: var(--accent, #3b82f6);
    font-size: 11px;
    animation: pulse-play 1.2s ease-in-out infinite;
  }

  .step-description {
    font-size: 13px;
    line-height: 1.4;
    color: var(--text-secondary, #b8b0a4);
  }

  .step.completed .step-description {
    color: var(--text-muted, #8a8478);
    text-decoration: line-through;
  }
  .step.failed .step-description {
    color: var(--red, #f87171);
  }
  .step.in_progress .step-description {
    color: var(--text-primary, #f7f5f0);
    font-weight: 500;
  }

  @keyframes pulse-play {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
</style>
