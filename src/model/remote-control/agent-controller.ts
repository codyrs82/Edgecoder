// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The agent's side of remote model control: checks a coordinator's signed command
 * (protocol.ts), applies the host's policy (policy.ts), acts on the local Ollama, persists setting
 * changes to the agent-owned override file (overrides.ts), and reports the result and the new state
 * back to the coordinator (a signed agent request, done by the caller's `report`).
 */

import { verifyModelControlFrame, CommandReplayGuard, MODEL_CONTROL_FEATURES, type ModelControlCommand, type ModelControlRequest, type ModelControlResult, type ModelControlState, type SettingSource } from "./protocol.js";
import { SETTINGS_BOUNDS, allowedModel, fitCheck, normalizeModelTag, settingsProblem, type ModelAllowlist } from "./policy.js";
import { saveOverrides, withOverride, withoutKeys, type EnvModelSettings, type ModelOverridesFile } from "./overrides.js";
import type { OllamaAdmin } from "./ollama-admin.js";

/** The model settings the agent runs with now. */
export interface CurrentModelSettings {
  model: string;
  contextWindow: number;
  parallel: number;
  keepAlive: string;
  sources: { model: SettingSource; contextWindow: SettingSource; parallel: SettingSource; keepAlive: SettingSource };
}

export interface ModelControlAgentDeps {
  agentId: string;
  /** AGENT_REMOTE_CONTROL (off = view only). */
  enabled: boolean;
  allowlist: ModelAllowlist;
  ollama: OllamaAdmin;
  overridesFile: string;
  /** The env file's own values (what overrides are recorded against). */
  env: EnvModelSettings;
  overrides: ModelOverridesFile;
  current(): CurrentModelSettings;
  /** Puts changed settings into effect (the worker re-sizes and reloads its model). */
  apply(change: Partial<Pick<CurrentModelSettings, "model" | "contextWindow" | "parallel" | "keepAlive">>): Promise<void>;
  hardware: { ramBytes: number; vramBytes?: number; gpu?: { vendor?: string; model?: string; count?: number } };
  modelsDir: string;
  diskSpace(path: string): { freeBytes: number; totalBytes: number } | undefined;
  /** Download size of an allowlisted model the catalog does not size (registry manifest). */
  sizeOf(model: string): Promise<number | undefined>;
  report(body: { state?: ModelControlState; result?: ModelControlResult }): Promise<void>;
  /** A local UI (the desktop app) owns this machine's config. */
  localUi?: boolean;
  /** Ollama's server-side OLLAMA_NUM_PARALLEL, when known. */
  ollamaNumParallel?: number;
  /** Further notes for the portal (e.g. "the model is served by vLLM"). */
  extraNotes?: () => string[];
  now?: () => number;
  log?: (message: string) => void;
}

/** Commands a host takes from its coordinator per window (refresh included). */
export const AGENT_COMMANDS_PER_WINDOW = 30;
export const AGENT_COMMAND_WINDOW_MS = 10 * 60_000;
/** A pull that runs longer than this is aborted. */
export const PULL_MAX_MS = 3 * 60 * 60_000;
const PROGRESS_REPORT_MS = 2_000;

type Outcome = { status: "done" | "refused" | "failed"; error?: string; message?: string };

export class ModelControlAgent {
  private readonly replay = new CommandReplayGuard();
  private readonly recent: number[] = [];
  private overrides: ModelOverridesFile;
  private pull: { commandId: string; model: string; status: string; completedBytes?: number; totalBytes?: number; startedAtMs: number } | undefined;
  private busy = false;
  private readonly now: () => number;

  constructor(private readonly deps: ModelControlAgentDeps) {
    this.overrides = deps.overrides;
    this.now = deps.now ?? Date.now;
  }

  private log(m: string): void {
    (this.deps.log ?? ((x: string) => console.log(x)))(`[agent:${this.deps.agentId}] model control: ${m}`);
  }

  /**
   * Is a model a coordinator's (admin) orchestration may pull? The same host policy as the owner's
   * commands: remote control on and the model allowlisted. Returns the refusal, or null.
   */
  orchestrationRefusal(model: string): string | null {
    if (!this.deps.enabled) return "remote_control_off";
    if (!allowedModel(this.deps.allowlist, model)) return "model_not_allowlisted";
    return null;
  }

  /** A frame off the mesh WebSocket. Returns the command's outcome (or the frame's refusal). */
  async handleFrame(frame: unknown, coordinator: { peerId: string; publicKeyPem: string } | null): Promise<Outcome & { commandId?: string }> {
    const verdict = verifyModelControlFrame(frame, { agentId: this.deps.agentId, coordinator, replay: this.replay, nowMs: this.now() });
    if (!verdict.ok) {
      this.log(`frame refused (${verdict.reason})`);
      // Only a command our coordinator really signed for us gets an answer; forgeries and replays are dropped.
      const cmd = (frame as { command?: ModelControlCommand })?.command;
      if (["expired", "from_future", "lifetime_too_long", "invalid_request"].includes(verdict.reason) && cmd?.agentId === this.deps.agentId && typeof cmd.id === "string") {
        await this.safeReport({ result: { commandId: cmd.id, status: "refused", error: verdict.reason } });
      }
      return { status: "refused", error: verdict.reason };
    }
    const { command, request } = verdict;
    const nowMs = this.now();
    while (this.recent.length && nowMs - this.recent[0] > AGENT_COMMAND_WINDOW_MS) this.recent.shift();
    if (this.recent.length >= AGENT_COMMANDS_PER_WINDOW) {
      await this.safeReport({ result: { commandId: command.id, status: "refused", error: "agent_rate_limited" } });
      return { status: "refused", error: "agent_rate_limited", commandId: command.id };
    }
    this.recent.push(nowMs);
    this.log(`${request.action} ${JSON.stringify(request.args)} for ${command.requestedBy} (command ${command.id})`);
    const outcome = await this.execute(command, request);
    await this.safeReport({ result: { commandId: command.id, status: outcome.status, error: outcome.error, message: outcome.message }, state: await this.state() });
    if (outcome.status !== "done") this.log(`${request.action} ${outcome.status}: ${outcome.error ?? ""}`);
    return { ...outcome, commandId: command.id };
  }

  private async safeReport(body: { state?: ModelControlState; result?: ModelControlResult }): Promise<void> {
    try {
      await this.deps.report(body);
    } catch (e) {
      this.log(`report failed: ${String(e).slice(0, 160)}`);
    }
  }

  private async execute(command: ModelControlCommand, request: ModelControlRequest): Promise<Outcome> {
    if (request.action === "refresh") return { status: "done" };
    if (!this.deps.enabled) return { status: "refused", error: "remote_control_off", message: "AGENT_REMOTE_CONTROL=off on this host" };
    switch (request.action) {
      case "pull":
        return this.doPull(command, request.args.model);
      case "set_model":
        return this.doSetModel(command, request.args.model);
      case "remove":
        return this.doRemove(request.args.model);
      case "set_settings":
        return this.doSettings(command, request.args);
      case "restart_model":
        return this.doRestart();
    }
  }

  private async installed(): Promise<Array<{ name: string; sizeBytes: number }>> {
    return this.deps.ollama.list();
  }

  private async doPull(command: ModelControlCommand, model: string): Promise<Outcome> {
    const allowed = allowedModel(this.deps.allowlist, model);
    if (!allowed) return { status: "refused", error: "model_not_allowlisted" };
    if (this.pull || this.busy) return { status: "refused", error: "busy", message: this.pull ? `pulling ${this.pull.model}` : "another change is running" };
    const tag = normalizeModelTag(model);
    let installed: Array<{ name: string; sizeBytes: number }>;
    try {
      installed = await this.installed();
    } catch (e) {
      return { status: "failed", error: "ollama_unreachable", message: String(e).slice(0, 160) };
    }
    const already = installed.find((m) => normalizeModelTag(m.name) === tag);
    const sizeBytes = allowed.sizeBytes ?? (await this.deps.sizeOf(tag)) ?? already?.sizeBytes;
    if (!sizeBytes) return { status: "refused", error: "model_size_unknown", message: "add a catalog model, or check the tag exists" };
    const disk = this.deps.diskSpace(this.deps.modelsDir);
    const fit = fitCheck({
      sizeBytes,
      minMemoryGb: allowed.minMemoryGb,
      diskFreeBytes: disk?.freeBytes,
      ramBytes: this.deps.hardware.ramBytes,
      vramBytes: this.deps.hardware.vramBytes,
      alreadyInstalledBytes: already?.sizeBytes
    });
    if (!fit.ok) return { status: "refused", error: fit.reason, message: `needs ${gb(fit.needBytes)}, has ${gb(fit.haveBytes)}` };

    this.pull = { commandId: command.id, model: tag, status: "starting", startedAtMs: this.now() };
    await this.safeReport({ result: { commandId: command.id, status: "accepted", message: `pulling ${tag} (${gb(sizeBytes)})` } });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), PULL_MAX_MS);
    let lastReportMs = 0;
    try {
      await this.deps.ollama.pull(
        tag,
        (p) => {
          if (!this.pull) return;
          this.pull.status = p.status;
          if (p.totalBytes) this.pull.totalBytes = p.totalBytes;
          if (p.completedBytes !== undefined) this.pull.completedBytes = p.completedBytes;
          const t = this.now();
          if (t - lastReportMs >= PROGRESS_REPORT_MS) {
            lastReportMs = t;
            const pct = this.pull.totalBytes ? Math.min(100, Math.floor(((this.pull.completedBytes ?? 0) / this.pull.totalBytes) * 100)) : undefined;
            void this.safeReport({ result: { commandId: command.id, status: "progress", message: p.status, progressPct: pct } });
          }
        },
        abort.signal
      );
      return { status: "done", message: `pulled ${tag}` };
    } catch (e) {
      return { status: "failed", error: abort.signal.aborted ? "pull_timeout" : "pull_failed", message: String(e).slice(0, 200) };
    } finally {
      clearTimeout(timer);
      this.pull = undefined;
    }
  }

  private persist(key: "model" | "contextWindow" | "parallel" | "keepAlive", value: string | number, command: ModelControlCommand): void {
    this.overrides = withOverride(this.overrides, key, value as never, this.deps.env, { updatedBy: command.requestedBy, commandId: command.id, nowMs: this.now() });
    saveOverrides(this.deps.overridesFile, this.overrides);
  }

  private async exclusive(fn: () => Promise<Outcome>): Promise<Outcome> {
    if (this.busy || this.pull) return { status: "refused", error: "busy" };
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }

  private async doSetModel(command: ModelControlCommand, model: string): Promise<Outcome> {
    if (!allowedModel(this.deps.allowlist, model)) return { status: "refused", error: "model_not_allowlisted" };
    const tag = normalizeModelTag(model);
    let installed: Array<{ name: string; sizeBytes: number }>;
    try {
      installed = await this.installed();
    } catch (e) {
      return { status: "failed", error: "ollama_unreachable", message: String(e).slice(0, 160) };
    }
    const found = installed.find((m) => normalizeModelTag(m.name) === tag);
    if (!found) return { status: "refused", error: "model_not_installed", message: "pull it first" };
    return this.exclusive(async () => {
      try {
        this.persist("model", found.name, command);
        await this.deps.apply({ model: found.name });
        return { status: "done", message: `serving ${found.name}` };
      } catch (e) {
        return { status: "failed", error: "apply_failed", message: String(e).slice(0, 200) };
      }
    });
  }

  private async doRemove(model: string): Promise<Outcome> {
    const tag = normalizeModelTag(model);
    if (normalizeModelTag(this.deps.current().model) === tag) return { status: "refused", error: "model_in_use", message: "select another model first" };
    if (this.pull && this.pull.model === tag) return { status: "refused", error: "busy" };
    let installed: Array<{ name: string; sizeBytes: number }>;
    try {
      installed = await this.installed();
    } catch (e) {
      return { status: "failed", error: "ollama_unreachable", message: String(e).slice(0, 160) };
    }
    const found = installed.find((m) => normalizeModelTag(m.name) === tag);
    if (!found) return { status: "refused", error: "model_not_installed" };
    // A loaded model is in use (on a desktop, maybe by the app's own chat): the machine's user decides.
    const loaded = await this.deps.ollama.loaded().catch(() => []);
    if (loaded.some((m) => normalizeModelTag(m.name) === tag)) return { status: "refused", error: "model_loaded", message: "in use on this machine; unload it there first" };
    try {
      await this.deps.ollama.remove(found.name);
      return { status: "done", message: `removed ${found.name}` };
    } catch (e) {
      return { status: "failed", error: "remove_failed", message: String(e).slice(0, 200) };
    }
  }

  private async doSettings(command: ModelControlCommand, patch: { contextWindow?: number | "auto"; parallel?: number | "auto"; keepAlive?: string }): Promise<Outcome> {
    const problem = settingsProblem(patch, SETTINGS_BOUNDS);
    if (problem) return { status: "refused", error: problem };
    // "auto": drop the portal's override of that setting so the agent sizes it again. The env file's
    // own value (AGENT_CONTEXT_WINDOW / AGENT_PARALLEL_INFERENCE) is local config and still wins.
    const autoKeys = (["contextWindow", "parallel"] as const).filter((k) => patch[k] === "auto");
    return this.exclusive(async () => {
      try {
        if (typeof patch.contextWindow === "number") this.persist("contextWindow", patch.contextWindow, command);
        if (typeof patch.parallel === "number") this.persist("parallel", patch.parallel, command);
        if (patch.keepAlive !== undefined) this.persist("keepAlive", patch.keepAlive, command);
        if (autoKeys.some((k) => this.overrides[k] !== undefined)) {
          this.overrides = withoutKeys(this.overrides, autoKeys);
          saveOverrides(this.deps.overridesFile, this.overrides);
        }
        const change: Partial<Pick<CurrentModelSettings, "contextWindow" | "parallel" | "keepAlive">> = {};
        if (typeof patch.contextWindow === "number") change.contextWindow = patch.contextWindow;
        if (typeof patch.parallel === "number") change.parallel = patch.parallel;
        if (patch.keepAlive !== undefined) change.keepAlive = patch.keepAlive;
        // The worker re-reads the override file and re-sizes (a changed window reloads the model).
        await this.deps.apply(change);
        const np = this.deps.ollamaNumParallel;
        const note = typeof patch.parallel === "number" && np !== undefined && patch.parallel > np ? ` (Ollama runs ${np} at once: calls past that queue; re-run the installer with --parallel ${patch.parallel} to raise it)` : "";
        return { status: "done", message: `settings applied${note}${this.autoNote(autoKeys)}` };
      } catch (e) {
        return { status: "failed", error: "apply_failed", message: String(e).slice(0, 200) };
      }
    });
  }

  /** What "auto" came to: the newly sized value, or the machine's own config that still pins it. */
  private autoNote(keys: ReadonlyArray<"contextWindow" | "parallel">): string {
    if (keys.length === 0) return "";
    const cur = this.deps.current();
    const parts = keys.map((k) => {
      const label = k === "contextWindow" ? "context window" : "parallel slots";
      const flag = k === "contextWindow" ? "--context-window" : "--parallel";
      if (cur.sources[k] === "env") {
        return `${label} stays ${cur[k]}: this machine's own config sets it (${this.deps.localUi ? "change it in the EdgeCoder app" : `edgecoder-install apply --keep-config ${flag} auto`})`;
      }
      return `${label} automatic: ${cur[k]}`;
    });
    return `; ${parts.join("; ")}`;
  }

  private async doRestart(): Promise<Outcome> {
    return this.exclusive(async () => {
      const model = this.deps.current().model;
      try {
        await this.deps.ollama.unload(model).catch(() => undefined);
        await this.deps.apply({});
        return { status: "done", message: `reloaded ${model}` };
      } catch (e) {
        return { status: "failed", error: "restart_failed", message: String(e).slice(0, 200) };
      }
    });
  }

  /** What the portal shows for this machine. */
  async state(): Promise<ModelControlState> {
    const cur = this.deps.current();
    const notes: string[] = [];
    let version: string | undefined;
    let installed: ModelControlState["installed"] = [];
    let loaded: ModelControlState["loaded"] = [];
    let reachable = true;
    try {
      [version, installed, loaded] = await Promise.all([this.deps.ollama.version().catch(() => undefined), this.deps.ollama.list(), this.deps.ollama.loaded().catch(() => [])]);
    } catch {
      reachable = false;
      notes.push("Ollama is not reachable");
    }
    const disk = this.deps.diskSpace(this.deps.modelsDir);
    if (!this.deps.enabled) notes.push("Remote control is off on this host (AGENT_REMOTE_CONTROL=off): view only");
    if (this.deps.ollamaNumParallel === undefined) notes.push("Parallel slots above Ollama's OLLAMA_NUM_PARALLEL queue inside Ollama; that limit is a server setting (re-run the installer with --parallel N)");
    if (this.deps.localUi) notes.push("This machine's own app owns its settings: a change made there replaces a remote one");
    notes.push(...(this.deps.extraNotes?.() ?? []));
    return {
      remoteControl: this.deps.enabled ? "on" : "off",
      ollamaVersion: version,
      ollamaReachable: reachable,
      activeModel: cur.model,
      installed: installed.map((m) => ({ name: m.name, sizeBytes: m.sizeBytes, modifiedAt: m.modifiedAt })),
      loaded,
      gpu: this.deps.hardware.gpu || this.deps.hardware.vramBytes ? { ...this.deps.hardware.gpu, vramBytes: this.deps.hardware.vramBytes } : undefined,
      ramBytes: this.deps.hardware.ramBytes,
      diskFreeBytes: disk?.freeBytes,
      diskTotalBytes: disk?.totalBytes,
      settings: { contextWindow: cur.contextWindow, parallel: cur.parallel, keepAlive: cur.keepAlive },
      sources: cur.sources,
      bounds: SETTINGS_BOUNDS,
      allowlist: [...this.deps.allowlist.models.entries()].slice(0, 100).map(([name, v]) => ({ name, sizeBytes: v.sizeBytes, minMemoryGb: v.minMemoryGb })),
      ollamaNumParallel: this.deps.ollamaNumParallel,
      notes,
      features: [...MODEL_CONTROL_FEATURES],
      pull: this.pull ? { ...this.pull } : undefined,
      localUi: Boolean(this.deps.localUi),
      reportedAtMs: this.now()
    };
  }
}

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}
