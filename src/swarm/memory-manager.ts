// Copyright (c) 2025 EdgeCoder
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
 *  - The owner's own calls ("My machines", the coordinator's onlyAccountId matching this agent's
 *    account) may also run an installed model that is not served on the network (too big for the
 *    budget, or past the model limit): `admit(model, { own: true })` skips the budget refusal
 *    (idle network models are still unloaded to make room) but refuses under critical pressure,
 *    and the model is the owner's, so network work never unloads it.
 *  - Pressure: on warning the agent takes no new network work and unloads its idle models; on
 *    critical it also cancels its running network calls and hands its claims back (onCritical),
 *    and unloads everything but the owner's active model. It resumes once the pressure has been
 *    lower for a while (PressureGuard's hysteresis).
 *  - vLLM / MLX (`engine`): the engine loads its one model at start and holds its memory (vLLM
 *    preallocates --gpu-memory-utilization of the VRAM for weights and KV cache), so there is
 *    nothing to load, fit or unload. The served model is reported as loaded, filling the budget:
 *    the coordinator sends calls for it up to the engine's slots (from its reported KV cache,
 *    engine-probe.ts) and never sends another model on the strength of free-looking headroom.
 *    The pressure guard applies as with Ollama.
 */

import { estimateModelBytes, fmtGb, learnModelFacts, modelFactsFromModelInfo, planLoad, planServing, type InstalledModel, type LoadedModel, type MemoryTelemetry, type PressureLevel, type ServingPlan } from "./memory-budget.js";
import { PressureGuard, type MemorySnapshot } from "./memory-pressure.js";

export interface MemoryOllama {
  list(): Promise<Array<{ name: string; sizeBytes: number }>>;
  loaded(): Promise<Array<{ name: string; sizeBytes: number; expiresAt?: string }>>;
  unload(model: string): Promise<void>;
  /** /api/show model_info: the model's KV-cache geometry and context length (memory-budget.ts learnModelFacts). */
  show?(model: string): Promise<{ modelInfo?: Record<string, unknown> }>;
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

/** The model a vLLM / MLX engine serves now; undefined while it is down or loading. */
export interface EngineServed {
  model: string;
  /** Memory the engine holds for it (the whole budget for vLLM: it preallocates the GPUs). */
  bytes: number;
}

export interface MemoryManagerDeps {
  ollama: MemoryOllama;
  /** Set when an OpenAI-compatible engine (vLLM / MLX) serves the model instead of Ollama. */
  engine?: () => EngineServed | undefined;
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
  /**
   * Called (synchronously, before the serving plan is redone) when Ollama taught the agent
   * something new about an installed model (its size, KV cache per token, context length): the
   * agent re-sizes its context window from it (worker-runner.ts).
   */
  onModelFacts?: () => void;
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
  /** Installed but not served on the network: run only for the owner (with estimated bytes). */
  ownerModels: Array<{ name: string; bytes: number; reason: "too_big" | "model_limit" }>;
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
  private refreshing: Promise<void> | undefined;
  /** Models whose /api/show has been read. */
  private readonly shown = new Set<string>();

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
    // A refresh already running: wait for it (the agent's startup needs its result before loading).
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshNow();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }

  private async refreshNow(): Promise<void> {
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
  }

  private async readOllama(nowMs: number): Promise<void> {
    if (this.d.engine) {
      const e = this.d.engine();
      this.loaded = e ? [{ name: e.model, sizeBytes: e.bytes }] : [];
      this.installed = e ? [{ name: e.model, sizeBytes: e.bytes }] : [];
      return;
    }
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
    await this.learnFacts();
  }

  /**
   * Learn each installed model's size and (Ollama /api/show) KV-cache geometry and context length,
   * the configured model first, a few per refresh. A failed /api/show is retried on a later refresh.
   */
  private async learnFacts(): Promise<void> {
    let changed = false;
    for (const m of this.installed) if (m.sizeBytes && m.sizeBytes > 0) changed = learnModelFacts(m.name, { sizeBytes: m.sizeBytes }) || changed;
    const show = this.d.ollama.show?.bind(this.d.ollama);
    if (show) {
      const primary = this.d.settings().primary;
      const todo = this.installed.map((m) => m.name).filter((n) => !this.shown.has(n)).sort((a, b) => Number(b === primary) - Number(a === primary)).slice(0, 4);
      for (const name of todo) {
        try {
          const facts = modelFactsFromModelInfo((await show(name)).modelInfo);
          this.shown.add(name);
          changed = learnModelFacts(name, facts) || changed;
        } catch {
          break; // Ollama busy or down: next refresh
        }
      }
    }
    if (changed) {
      try {
        this.d.onModelFacts?.();
      } catch (e) {
        this.log(`re-sizing from model facts failed: ${String(e).slice(0, 160)}`);
      }
    }
  }

  private replan(): void {
    if (this.d.engine) {
      const e = this.loaded[0];
      this.plan = e ? { serving: [{ model: e.name, bytes: e.sizeBytes, loaded: true }], localOnly: [], tooBig: [], ownerOnly: [] } : undefined;
      return;
    }
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

  /**
   * The installed models only the owner's own calls may run here (not served on the network);
   * none before the first plan. Reported apart from the served list (register / heartbeat
   * `ownerModels`), so the coordinator never routes another account's work to them.
   */
  ownerOnlyModels(installed: string[]): string[] {
    if (!this.plan) return [];
    const owner = new Set(this.plan.ownerOnly.map((m) => m.model));
    return installed.filter((m) => owner.has(m));
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
    if (this.d.engine) return; // the engine's model stays: it is managed on the host, not by the agent
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
  admit(model: string, opts: { own?: boolean } = {}): Promise<Admission> {
    const run = this.lock.then(() => (opts.own && this.isOwnerOnly(model) ? this.admitOwnerNow(model) : this.admitNow(model)));
    this.lock = run.catch(() => undefined);
    return run;
  }

  private isOwnerOnly(model: string): boolean {
    return !this.d.engine && !!this.plan && this.plan.ownerOnly.some((m) => m.model === model);
  }

  /**
   * The owner's own call on a model this host does not serve on the network: no budget refusal
   * (the owner chose to run it here), but none under critical pressure. Idle network models are
   * unloaded first when they stand in its way; the owner's other models are not.
   */
  private async admitOwnerNow(model: string): Promise<Admission> {
    if (this.pressure() === "critical") return { ok: false, error: `memory_pressure: this host is critically low on memory; not starting ${model}` };
    try {
      this.loaded = (await this.d.ollama.loaded()).map((m) => ({ name: m.name, sizeBytes: m.sizeBytes, expiresAt: m.expiresAt }));
    } catch {
      // Ollama unreachable: the last view
    }
    if (!this.loaded.some((m) => m.name === model)) {
      const need = this.estimate(model);
      const busy = this.busy();
      const plan = planLoad({ model, needBytes: need, budgetBytes: this.d.budgetBytes, loaded: this.loaded, busy, protectedModels: this.ownerModels() });
      // Fits after unloading some idle network models: just those. Otherwise every idle network model goes.
      const unload = plan.ok ? plan.unload : this.loaded.filter((m) => this.networkUsed.has(m.name) && !busy.has(m.name)).map((m) => m.name);
      for (const m of unload) await this.unload(m, `to make room for the owner's ${model}: needs ${fmtGb(need)}`);
    }
    return this.track(model, true);
  }

  private estimate(name: string): number {
    const s = this.d.settings();
    return estimateModelBytes(name, { sizeBytes: this.installed.find((m) => m.name === name)?.sizeBytes, numCtx: s.contextWindow, slots: s.kvSlots }).totalBytes;
  }

  private async admitNow(model: string): Promise<Admission> {
    const level = this.pressure();
    if (level !== "normal") return { ok: false, error: `memory_pressure: this host is low on memory (${level}); not starting network work` };
    if (this.plan && !this.plan.serving.some((m) => m.model === model)) {
      const serving = this.plan.serving.map((m) => m.model).join(", ") || "none";
      return { ok: false, error: `memory_model_not_served: ${model} is not served on the network from this host (its memory budget serves: ${serving})` };
    }
    if (this.d.engine) {
      // One model, resident: it may take calls up to the engine's slots, nothing else loads.
      const e = this.d.engine();
      if (!e || e.model !== model) return { ok: false, error: `memory_model_not_served: ${model} is not served by this host's engine (it serves ${e?.model ?? "nothing yet"})` };
      return this.track(model);
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
    return this.track(model);
  }

  /** `owner`: the owner's own call; the model stays the owner's (network work never unloads it). */
  private track(model: string, owner = false): Admission {
    this.inflight.set(model, (this.inflight.get(model) ?? 0) + 1);
    if (owner) this.networkUsed.delete(model);
    else this.networkUsed.set(model, this.now());
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.inflight.set(model, Math.max(0, (this.inflight.get(model) ?? 1) - 1));
        if (!owner) this.networkUsed.set(model, this.now());
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
      ...(this.plan?.ownerOnly.length ? { ownerModels: this.plan.ownerOnly.slice(0, 32).map((m) => ({ name: m.model, bytes: m.bytes })) } : {}),
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
      ownerModels: (this.plan?.ownerOnly ?? []).map((m) => ({ name: m.model, bytes: m.bytes, reason: m.reason })),
      localOnlyModels: this.plan?.localOnly ?? [],
      tooBigModels: this.plan?.tooBig ?? [],
      contextWindow: s.contextWindow,
      parallel: s.slots,
    };
  }
}
