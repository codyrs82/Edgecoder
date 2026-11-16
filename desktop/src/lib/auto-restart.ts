// Restart automatically to finish a downloaded update, but only when nothing would be lost.
//
// Busy signals, from two places:
//  - In-window work registers itself with setBusy(key, reason) / clearBusy(key): a streaming chat
//    or editor-chat turn, a tool call waiting for approval, unsaved editor buffers, a model pull,
//    and first-time install of the local agent's runtime (Ollama / Docker VM).
//  - Probes asked just before a countdown starts and again at zero (see defaultProbes in App):
//    shared coding sessions on the IDE server (/v1/ide/sessions: a running turn or a pending
//    approval; older providers without the route count as idle), and network work on the local
//    agent. The agent exposes no "job running now" flag, so a job counts as active when the local
//    coordinator has queued tasks (/health/runtime coordinator.queued > 0) or the account recorded
//    a task within the last 30 s (/v1/ide/compute account.recent[].atMs).
//
// The decision itself is restartDecision(), a pure function; AutoRestart wires it to timers.

export const AUTO_RESTART_KEY = "edgecoder_autoRestart";
export const UPDATED_TO_KEY = "edgecoder_updatedTo";
export const COUNTDOWN_S = 60;
export const LATER_MS = 60 * 60 * 1000;
export const STUCK_BUSY_MS = 24 * 60 * 60 * 1000;
export const NETWORK_JOB_GRACE_MS = 30_000;
export const POLL_MS = 15_000;

export type BusyReason = "streaming" | "approval" | "unsaved" | "session" | "network-job" | "install" | "model-pull";

type Store = Pick<Storage, "getItem">;
export function autoRestartEnabled(store: Store | null = safeStorage()): boolean {
  return store?.getItem(AUTO_RESTART_KEY) !== "off";
}
export function setAutoRestartEnabled(on: boolean, store: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try { store?.setItem(AUTO_RESTART_KEY, on ? "on" : "off"); } catch { /* storage unavailable */ }
}
function safeStorage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

// ---- In-window busy registry -------------------------------------------------------------
const busy = new Map<string, BusyReason>();
export function setBusy(key: string, reason: BusyReason | null | false): void {
  if (reason) busy.set(key, reason);
  else busy.delete(key);
}
export function clearBusy(key: string): void { busy.delete(key); }
export function busyReasons(): BusyReason[] { return [...new Set(busy.values())]; }

// ---- Network-job heuristic -------------------------------------------------------------
export function networkJobBusy(queued: number | undefined, recentAtMs: number[], nowMs: number): boolean {
  return (queued ?? 0) > 0 || recentAtMs.some((t) => nowMs - t < NETWORK_JOB_GRACE_MS);
}
export function sessionsBusy(sessions: Array<{ running?: boolean; pending?: number }>): boolean {
  return sessions.some((s) => s.running || (s.pending ?? 0) > 0);
}

// ---- Policy ----------------------------------------------------------------------------
export interface RestartInputs {
  autoUpdate: boolean;
  autoRestart: boolean;
  /** An update is downloaded and verified. */
  ready: boolean;
  busy: BusyReason[];
  nowMs: number;
  postponedUntilMs: number;
  readySinceMs: number;
}
export type RestartDecision =
  /** Nothing to do (no update, or updates are off). */
  | { action: "none" }
  /** The setting is off, or the app has been busy over a day: only "Restart to update". */
  | { action: "manual" }
  | { action: "wait"; reasons: BusyReason[] }
  | { action: "countdown" };

export function restartDecision(i: RestartInputs): RestartDecision {
  if (!i.autoUpdate || !i.ready) return { action: "none" };
  if (!i.autoRestart) return { action: "manual" };
  if (i.nowMs < i.postponedUntilMs) return { action: "wait", reasons: [] };
  if (i.busy.length > 0) {
    // Never force it: past a day the prompt stays on the persistent "Restart to update" row.
    if (i.nowMs - i.readySinceMs > STUCK_BUSY_MS) return { action: "manual" };
    return { action: "wait", reasons: i.busy };
  }
  return { action: "countdown" };
}

// ---- Controller ------------------------------------------------------------------------
export type AutoRestartView =
  | { phase: "off" }
  | { phase: "waiting"; reasons: BusyReason[]; stuck: boolean }
  | { phase: "countdown"; version: string; secondsLeft: number }
  | { phase: "restarting" };

export interface AutoRestartDeps {
  autoUpdate: () => boolean;
  autoRestart: () => boolean;
  /** Version of the downloaded update, or null when none is ready. */
  readyVersion: () => string | null;
  /** Everything busy right now (registry plus probes). Probes that fail count as idle. */
  checkBusy: () => Promise<BusyReason[]>;
  restart: (version: string) => Promise<void>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export class AutoRestart {
  private view: AutoRestartView = { phase: "off" };
  private listeners: Array<(v: AutoRestartView) => void> = [];
  private timer: unknown = null;
  private postponedUntilMs = 0;
  private readySinceMs = 0;
  private readyVersion: string | null = null;
  private stopped = false;
  private evaluating = false;
  private now: () => number;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (id: unknown) => void;

  constructor(private deps: AutoRestartDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  }

  get state(): AutoRestartView { return this.view; }
  /** A countdown or restart began while the busy check was in flight. */
  private busyElsewhere(): boolean { return this.view.phase === "countdown" || this.view.phase === "restarting"; }
  subscribe(fn: (v: AutoRestartView) => void): () => void {
    this.listeners.push(fn);
    fn(this.view);
    return () => { this.listeners = this.listeners.filter((f) => f !== fn); };
  }
  private emit(v: AutoRestartView) {
    this.view = v;
    for (const fn of this.listeners) fn(v);
  }
  private schedule(fn: () => void, ms: number) {
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.timer = null; fn(); }, ms);
  }

  /** Re-evaluate now (call when update status changes; also runs itself every POLL_MS). */
  async evaluate(): Promise<void> {
    if (this.evaluating) return;
    this.evaluating = true;
    try { await this.evaluateOnce(); } finally { this.evaluating = false; }
  }

  private async evaluateOnce(): Promise<void> {
    if (this.stopped || this.view.phase === "countdown" || this.view.phase === "restarting") return;
    const version = this.deps.readyVersion();
    if (version !== this.readyVersion) {
      this.readyVersion = version;
      this.readySinceMs = this.now();
    }
    const busy = version && this.deps.autoUpdate() && this.deps.autoRestart() && this.now() >= this.postponedUntilMs
      ? await this.deps.checkBusy().catch(() => [] as BusyReason[])
      : [];
    if (this.stopped || this.busyElsewhere()) return;
    const d = restartDecision({
      autoUpdate: this.deps.autoUpdate(), autoRestart: this.deps.autoRestart(), ready: version != null,
      busy, nowMs: this.now(), postponedUntilMs: this.postponedUntilMs, readySinceMs: this.readySinceMs,
    });
    if (d.action === "none" || (d.action === "manual" && busy.length === 0)) {
      this.emit({ phase: "off" });
      if (d.action === "none" || !version) return; // status changes call evaluate() again
    } else if (d.action === "manual" || d.action === "wait") {
      this.emit({ phase: "waiting", reasons: d.action === "wait" ? d.reasons : busy, stuck: d.action === "manual" });
    } else {
      this.startCountdown(version!);
      return;
    }
    this.schedule(() => void this.evaluate(), POLL_MS);
  }

  private startCountdown(version: string) {
    let left = COUNTDOWN_S;
    this.emit({ phase: "countdown", version, secondsLeft: left });
    const step = () => {
      left -= 1;
      if (left > 0) {
        this.emit({ phase: "countdown", version, secondsLeft: left });
        this.schedule(step, 1000);
      } else {
        void this.finish(version);
      }
    };
    this.schedule(step, 1000);
  }

  /** At zero: re-check, and restart only if it is still safe. */
  private async finish(version: string) {
    const busy = await this.deps.checkBusy().catch(() => [] as BusyReason[]);
    if (this.stopped || this.view.phase !== "countdown") return;
    const d = restartDecision({
      autoUpdate: this.deps.autoUpdate(), autoRestart: this.deps.autoRestart(), ready: this.deps.readyVersion() != null,
      busy, nowMs: this.now(), postponedUntilMs: this.postponedUntilMs, readySinceMs: this.readySinceMs,
    });
    if (d.action === "countdown") return this.restartNow(version);
    this.emit({ phase: "off" });
    void this.evaluate();
  }

  async restartNow(version = this.readyVersion ?? ""): Promise<void> {
    if (this.timer != null) { this.clearTimer(this.timer); this.timer = null; }
    this.emit({ phase: "restarting" });
    await this.deps.restart(version);
  }

  /** "Later": no automatic restart for an hour, then at the next safe moment. */
  later(): void {
    this.postponedUntilMs = this.now() + LATER_MS;
    this.emit({ phase: "off" });
    this.schedule(() => void this.evaluate(), LATER_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer != null) { this.clearTimer(this.timer); this.timer = null; }
  }
}

// ---- "Updated to x" after the relaunch -------------------------------------------------
export function rememberUpdatingTo(version: string, store: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try { store?.setItem(UPDATED_TO_KEY, version); } catch { /* ignore */ }
}
/** The version just updated to, once: returns it and forgets it, if this build is that version. */
export function takeUpdatedTo(currentVersion: string, store: Pick<Storage, "getItem" | "removeItem"> | null = safeStorage()): string | null {
  try {
    const v = store?.getItem(UPDATED_TO_KEY);
    if (!v) return null;
    store!.removeItem(UPDATED_TO_KEY);
    return v === currentVersion ? v : null;
  } catch { return null; }
}
