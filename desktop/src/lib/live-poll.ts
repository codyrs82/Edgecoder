// Refresh a live page every few seconds while it can be seen: runs at once, then every `ms`,
// never two at a time, stops while the window is hidden and refreshes as soon as it is shown.

export interface LivePoll {
  stop(): void;
  /** Refresh now (e.g. after a filter change), unless one is running. */
  now(): Promise<void>;
}

export function livePoll(fn: () => Promise<void> | void, ms: number, doc: Pick<Document, "hidden" | "addEventListener" | "removeEventListener"> | null = typeof document === "undefined" ? null : document): LivePoll {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;

  const schedule = () => {
    if (stopped || timer || doc?.hidden) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, ms);
  };
  const tick = async () => {
    if (stopped || running) return;
    if (doc?.hidden) return;
    running = true;
    try {
      await fn();
    } catch {
      // the page shows its own error; keep polling
    } finally {
      running = false;
      schedule();
    }
  };
  const onVisibility = () => {
    if (doc?.hidden) {
      if (timer) clearTimeout(timer);
      timer = null;
    } else {
      void tick();
    }
  };
  doc?.addEventListener("visibilitychange", onVisibility);
  void tick();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      doc?.removeEventListener("visibilitychange", onVisibility);
    },
    now: tick,
  };
}
