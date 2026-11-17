// Permission modes as the composer's picker shows them, and how each maps to the agent engine's
// mode (src/apps/ide/permission-policy.ts; docs/permission-modes.md has the full tables).
//
//   Auto          → auto        safe things run; risky things ask; dangerous ones are refused
//   Manual        → ask         always ask before changes
//   Accept edits  → auto-edits  file edits apply (undoable); commands ask
//   Plan          → plan        read-only until you approve a plan

/** The engine's modes (the provider's API). */
export type EngineMode = "ask" | "auto-edits" | "auto" | "plan";
/** The modes as the picker names them. */
export type UiMode = "auto" | "manual" | "accept-edits" | "plan";

export interface ModeOption {
  id: UiMode;
  engine: EngineMode;
  title: string;
  desc: string;
  /** The number key that picks it while the picker is open (1–4). */
  key: string;
}

export const MODE_OPTIONS: readonly ModeOption[] = [
  { id: "auto", engine: "auto", title: "Auto", desc: "Runs safe commands and edits on its own; risky ones still ask.", key: "1" },
  { id: "manual", engine: "ask", title: "Manual", desc: "Always asks before it changes anything.", key: "2" },
  { id: "accept-edits", engine: "auto-edits", title: "Accept edits", desc: "File edits apply automatically; commands still ask.", key: "3" },
  { id: "plan", engine: "plan", title: "Plan", desc: "Proposes a plan first; no changes until you approve it.", key: "4" },
];

const BY_UI = new Map(MODE_OPTIONS.map((o) => [o.id, o]));
const BY_ENGINE = new Map(MODE_OPTIONS.map((o) => [o.engine, o]));

export function isEngineMode(v: unknown): v is EngineMode {
  return typeof v === "string" && BY_ENGINE.has(v as EngineMode);
}

/** Manual → ask, Accept edits → auto-edits, Auto → auto, Plan → plan. */
export function engineMode(ui: UiMode): EngineMode {
  return BY_UI.get(ui)?.engine ?? "ask";
}

/** The picker's mode for an engine mode (unknown values: Manual, the safest). */
export function uiMode(engine: unknown): UiMode {
  return isEngineMode(engine) ? BY_ENGINE.get(engine)!.id : "manual";
}

export function modeOption(engine: unknown): ModeOption {
  return BY_UI.get(uiMode(engine))!;
}

/** The option a number key picks (1–4), or null. */
export function optionForKey(key: string): ModeOption | null {
  return MODE_OPTIONS.find((o) => o.key === key) ?? null;
}

/** The modes an approved plan can continue in (Plan itself is not one). */
export const EXECUTION_OPTIONS: readonly ModeOption[] = MODE_OPTIONS.filter((o) => o.engine !== "plan");
/** An approved plan continues in Accept edits unless the user picks another. */
export const DEFAULT_EXECUTION_MODE: EngineMode = "auto-edits";

/** The message that carries out an approved plan (chats and bots; sessions send the provider's own). */
export const PLAN_APPROVED_MESSAGE = "The plan is approved. Carry it out now, step by step, using the tools. When you're done, reply with a short summary of what changed and how you checked it.";

const DEFAULT_KEY = "edgecoder-default-permission-mode";

/** Settings → General: the mode new chats and sessions start in (default Accept edits). */
export function defaultMode(): EngineMode {
  try {
    const v = localStorage.getItem(DEFAULT_KEY);
    if (isEngineMode(v)) return v;
  } catch {
    // storage unavailable
  }
  return "auto-edits";
}

export function setDefaultMode(mode: EngineMode): void {
  try {
    localStorage.setItem(DEFAULT_KEY, mode);
  } catch {
    // storage unavailable: lasts for this session only
  }
}

/**
 * A chat's mode: its own when it has one, else the older per-project "Auto-apply edits" switch
 * when that was set, else the default from Settings.
 */
export function chatMode(saved: unknown, legacyAutoApply: boolean | null): EngineMode {
  if (isEngineMode(saved)) return saved;
  if (legacyAutoApply === true) return "auto-edits";
  if (legacyAutoApply === false) return "ask";
  return defaultMode();
}
