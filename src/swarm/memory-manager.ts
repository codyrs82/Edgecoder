// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * The agent's host memory manager: keeps network work inside the host's memory budget
 * (src/swarm/memory-budget.ts) and stops it under system memory pressure
 * (src/swarm/memory-pressure.ts).
 *
 *  - Serving: only installed models that fit the budget on their own are served on the network,
 *    at most as many as fit together (and AGENT_MAX_NETWORK_MODELS / OLLAMA_MAX_LOADED_MODELS);
 *    the rest stay local-only. Loaded models come first, so the coordinator keeps sending the
 *    model already in memory (affinity, no load/unload thrash).
 *  - Admission: before a network call runs, its model must fit next to what is loaded (Ollama
 *    /api/ps), after unloading idle network models if needed (keep_alive 0). Models the agent did
 *    not load (the owner's own chats) are never unloaded to make room: the owner comes first.
 *    Otherwise the call is refused with a `memory_` error, which hands it back to the coordinator.
 *  - Pressure: on warning the agent takes no new network work and unloads its idle models; on
 *    critical it also cancels its running network calls and hands its claims back (onCritical),
 *    and unloads everything but the owner's active model. It resumes once the pressure has been
 *    lower for a while (PressureGuard's hysteresis).
 */

import { estimateModelBytes, fmtGb, planLoad, planServing, type InstalledModel, type LoadedModel, type MemoryTelemetry, type PressureLevel, type ServingPlan } from "./memory-budget.js";
import { PressureGuard, type MemorySnapshot } from "./memory-pressure.js";

export interface MemoryOllama {
  list(): Promise<Array<{ name: string; sizeBytes: number }>>;
  loaded(): Promise<Array<{ name: string; sizeBytes: number; expiresAt?: string }>>;
  unload(model: string): Promise<void>;
}

export interface MemorySettings {
  /** The agent's configured network model (OLLAMA_MODEL). */
  primary: string;
  /** The one context window network calls are served with. */
  contextWindow: number;
  /** The agent's parallel model calls. */
  slots: number;
  /** Slots Ollama allocates KV cache for (OLLAMA_NUM_PARALLEL when known, else `slots`). */
  kvSlots: number;
}

export interface MemoryManagerDeps {
  ollama: MemoryOllama;
  readPressure: () => MemorySnapshot;
  budgetBytes: number;
  maxModels?: number;
  settings: () => MemorySettings;
  /** The pressure guard (AGENT_MEMORY_GUARD); the budget applies either way. */
  guardEnabled: boolean;
  /** Critical pressure: cancel running network calls and hand claims back. */
  onCritical?: () => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
  recoverMs?: number;
  installedTtlMs?: number;
}

export type Admission = { ok: true; release: () => void } | { ok: false; error: string };

/** What the desktop app shows (Active work, Settings → Models), via the forwarder's /forward/health. */
export interface MemoryStatusView {
  pressure: PressureLevel;
  /** Not taking network work for memory reasons. */
  paused: boolean;
  pausedReason: string | null;
  totalBytes: number;
  availableBytes: number | null;
  budgetBytes: number;
  usedBytes: number;
  loadedModels: string[];
  servingModels: string[];
  localOnlyModels: string[];
  tooBigModels: string[];
  contextWindow: number;
  parallel: number;
}

export class HostMemoryManager {
  private readonly guard: PressureGuard;
  private readonly now: () => number;
  private snapshot: MemorySnapshot | undefined;
  private loaded: LoadedModel[] = [];
  private installed: InstalledModel[] = [];
  private installedAtMs = 0;
  private plan: ServingPlan | undefined;
  /** Network calls running, by model. */
  private readonly inflight = new Map<string, number>();
  /** Models this agent loaded or used for network work (others are the owner's). */
  private readonly networkUsed = new Map<string, number>();
  private lock: Promise<unknown> = Promise.resolve();
  private refreshing = false;

  constructor(private readonly d: MemoryManagerDeps) {
    this.guard = new PressureGuard(d.recoverMs ?? 30_000);
    this.now = d.now ?? Date.now;
  }

  private log(msg: string): void {
    this.d.log?.(msg);
  }

  pressure(): PressureLevel {
    return this.d.guardEnabled ? this.guard.current() : "normal";
  }

  /** May the agent pull new network work now? */
  canPull(): boolean {
    if (this.pressure() !== "normal") return false;
    // The plan is known and nothing installed fits: nothing to serve.
    return !(this.plan && this.plan.serving.length === 0 && this.installed.length > 0);
  }

  /** Re-read pressure, loaded and installed models; act on a pressure change. Never throws. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const nowMs = this.now();
      try {
        this.snapshot = this.d.readPressure();
      } catch {
        // keep the last reading
      }
      await this.readOllama(nowMs);
      this.replan();
      if (!this.d.guardEnabled || !this.snapshot) return;
      const { level, changed, from } = this.guard.update(this.snapshot.level, nowMs);
      if (changed) this.log(`memory pressure ${from} -> ${level} (${this.snapshot.detail})${level === "normal" ? ": taking network work again" : ": no new network work"}`);
      if (level === "critical" && changed) {
        await this.d.onCritical?.().catch(() => undefined);
        await this.unloadAllButOwnersActive();
      } else if (level !== "normal") await this.unloadIdle();
    } finally {
      this.refreshing = false;
    }
  }

  private async readOllama(nowMs: number): Promise<void> {
    try {
      this.loaded = (await this.d.ollama.loaded()).map((m) => ({ name: m.name, sizeBytes: m.sizeBytes, expiresAt: m.expiresAt }));
    } catch {
      // Ollama down: nothing loaded we can see
      this.loaded = [];
    }
    if (nowMs - this.installedAtMs >= (this.d.installedTtlMs ?? 60_000) || this.installed.length === 0) {
      try {
        this.installed = (await this.d.ollama.list()).filter((m) => !/embed/i.test(m.name));
        this.installedAtMs = nowMs;
      } catch {
        // keep the last list
      }
    }
  }

  private replan(): void {
    const s = this.d.settings();
    if (this.installed.length === 0) {
      this.plan = undefined;
      return;
    }
    this.plan = planServing({ installed: this.installed, loaded: this.loaded, preferred: s.primary, budgetBytes: this.d.budgetBytes, contextWindow: s.contextWindow, kvSlots: s.kvSlots, maxModels: this.d.maxModels });
  }

  /** The installed models to advertise: those served on the network (all of `installed` before the first plan). */
  advertised(installed: string[]): string[] {
    if (!this.plan) return installed;
    const serving = new Set(this.plan.serving.map((m) => m.model));
    return installed.filter((m) => serving.has(m));
  }

  /** The model to report as active: a served model already loaded, else the first served one. */
  activeModel(): string | undefined {
    return this.plan?.serving.find((m) => m.loaded)?.model ?? this.plan?.serving[0]?.model;
  }

  private ownerModels(): Set<string> {
    return new Set(this.loaded.filter((m) => !this.networkUsed.has(m.name)).map((m) => m.name));
  }

  private busy(): Set<string> {
    return new Set([...this.inflight].filter(([, n]) => n > 0).map(([m]) => m));
  }

  private async unload(model: string, why: string): Promise<void> {
    try {
      await this.d.ollama.unload(model);
      this.loaded = this.loaded.filter((m) => m.name !== model);
      this.log(`unloaded ${model} (${why})`);
    } catch (e) {
      this.log(`could not unload ${model} (${why}): ${String(e).slice(0, 160)}`);
    }
  }

  /** Warning pressure: unload the network models nothing is running on. */
  async unloadIdle(): Promise<void> {
    const busy = this.busy();
    for (const m of [...this.loaded]) if (this.networkUsed.has(m.name) && !busy.has(m.name)) await this.unload(m.name, "memory pressure");
  }

  /** Critical pressure: unload every idle model but the owner's most recently used one. */
  async unloadAllButOwnersActive(): Promise<void> {
    const busy = this.busy();
    const owners = this.loaded.filter((m) => !this.networkUsed.has(m.name)).sort((a, b) => Date.parse(b.expiresAt ?? "") - Date.parse(a.expiresAt ?? "") || 0);
    const keep = owners[0]?.name;
    for (const m of [...this.loaded]) if (m.name !== keep && !busy.has(m.name)) await this.unload(m.name, "critical memory pressure");
  }

  /**
   * Before a network call on `model` runs (or the agent warms it): may it load here? Unloads idle
   * network models first when that makes it fit. On ok, call `release()` when the call ends.
   */
  admit(model: string): Promise<Admission> {
    const run = this.lock.then(() => this.admitNow(model));
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async admitNow(model: string): Promise<Admission> {
    const level = this.pressure();
    if (level !== "normal") return { ok: false, error: `memory_pressure: this host is low on memory (${level}); not starting network work` };
    if (this.plan && !this.plan.serving.some((m) => m.model === model)) {
      const serving = this.plan.serving.map((m) => m.model).join(", ") || "none";
      return { ok: false, error: `memory_model_not_served: ${model} is not served on the network from this host (its memory budget serves: ${serving})` };
    }
    try {
      this.loaded = (await this.d.ollama.loaded()).map((m) => ({ name: m.name, sizeBytes: m.sizeBytes, expiresAt: m.expiresAt }));
    } catch {
      // Ollama unreachable: the last view (the call will fail on its own if Ollama is down)
    }
    const s = this.d.settings();
    const est = (name: string) => estimateModelBytes(name, { sizeBytes: this.installed.find((m) => m.name === name)?.sizeBytes, numCtx: s.contextWindow, slots: s.kvSlots }).totalBytes;
    // Models admitted but not loaded yet (a load in progress) count as loaded at their estimate.
    const view: LoadedModel[] = [...this.loaded];
    for (const m of this.busy()) if (!view.some((l) => l.name === m)) view.push({ name: m, sizeBytes: est(m) });
    const need = est(model);
    const plan = planLoad({ model, needBytes: need, budgetBytes: this.d.budgetBytes, loaded: view, busy: this.busy(), protectedModels: this.ownerModels() });
    if (!plan.ok) return { ok: false, error: plan.reason ?? "memory_budget" };
    for (const m of plan.unload) await this.unload(m, `to make room for ${model}: needs ${fmtGb(need)}`);
    this.inflight.set(model, (this.inflight.get(model) ?? 0) + 1);
    this.networkUsed.set(model, this.now());
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.inflight.set(model, Math.max(0, (this.inflight.get(model) ?? 1) - 1));
        this.networkUsed.set(model, this.now());
      },
    };
  }

  private usedBytes(): number {
    return this.loaded.reduce((s, m) => s + Math.max(0, m.sizeBytes), 0);
  }

  private pausedReason(): string | null {
    const level = this.pressure();
    if (level !== "normal") return level === "critical" ? "This machine is critically low on memory: network work was stopped and handed back" : "This machine is low on memory";
    if (this.plan && this.plan.serving.length === 0 && this.installed.length > 0) return "No installed model fits this machine's memory budget";
    return null;
  }

  /** Heartbeat telemetry for the coordinator's admission control. */
  telemetry(): MemoryTelemetry | undefined {
    if (!this.snapshot) return undefined;
    const s = this.d.settings();
    return {
      totalBytes: this.snapshot.totalBytes,
      ...(this.snapshot.availableBytes !== undefined ? { availableBytes: this.snapshot.availableBytes } : {}),
      pressure: this.pressure(),
      budgetBytes: this.d.budgetBytes,
      usedBytes: this.usedBytes(),
      loadedModels: this.loaded.slice(0, 16).map((m) => ({ name: m.name, bytes: m.sizeBytes })),
      models: (this.plan?.serving ?? []).slice(0, 16).map((m) => ({ name: m.model, bytes: m.bytes, contextWindow: s.contextWindow, slots: s.slots })),
      paused: !this.canPull(),
      atMs: this.now(),
    };
  }

  view(): MemoryStatusView {
    const s = this.d.settings();
    return {
      pressure: this.pressure(),
      paused: !this.canPull(),
      pausedReason: this.pausedReason(),
      totalBytes: this.snapshot?.totalBytes ?? 0,
      availableBytes: this.snapshot?.availableBytes ?? null,
      budgetBytes: this.d.budgetBytes,
      usedBytes: this.usedBytes(),
      loadedModels: this.loaded.map((m) => m.name),
      servingModels: (this.plan?.serving ?? []).map((m) => m.model),
      localOnlyModels: this.plan?.localOnly ?? [],
      tooBigModels: this.plan?.tooBig ?? [],
      contextWindow: s.contextWindow,
      parallel: s.slots,
    };
  }
}
