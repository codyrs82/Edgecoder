<script lang="ts">
  // The quiet line where a chat's older messages were summarized (compaction.ts): above it the
  // model has a summary, below it the messages as they are.
  import { compactionNoteText } from "../lib/compaction";

  let { savedTokens }: { savedTokens: number } = $props();
</script>

<div class="compaction-note" role="note">{compactionNoteText(savedTokens)}</div>

<style>
  .compaction-note {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--text-muted);
    font-size: var(--fs-xs);
    text-align: center;
  }
  .compaction-note::before,
  .compaction-note::after {
    content: "";
    flex: 1;
    border-top: 0.5px solid var(--border);
  }
</style>
