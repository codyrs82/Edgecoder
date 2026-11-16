<script lang="ts">
  // A status as words with a tone (done, failed, running, …); the colour only repeats the word.
  let { status, label }: { status: "done" | "failed" | "cancelled" | "running" | "waiting"; label?: string } = $props();
  const TONE = { done: "ok", failed: "err", cancelled: "", running: "run", waiting: "warn" } as const;
  const TEXT = { done: "Done", failed: "Failed", cancelled: "Cancelled", running: "Running", waiting: "Waiting" } as const;
</script>

<span class="sp-pill {TONE[status]}">{label ?? TEXT[status]}</span>
