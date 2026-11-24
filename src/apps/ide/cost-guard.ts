// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The per-reply cost check for a paid lead (a network or cloud model in cSats, your own frontier key
 * in USD) in desktop Code and Chat turns (/v1/ide/chat) and sessions (sessions.ts).
 *
 * Every model call's spend reaches the meter (its `usage` event). Before the next model call, once
 * the reply has spent the threshold since the last answer (Settings → General → "Ask before a reply
 * spends more than …"; EDGECODER_REPLY_COST_ASK_CSATS, default 150; EDGECODER_REPLY_COST_ASK_USD,
 * default $0.50), the turn pauses and asks in the chat, as an approval-style item (pseudo tool
 * COST_CHECK_TOOL): "This reply has used 160 cSats (read 210K tokens, wrote 3K). Keep going ·
 * Switch to DeepSeek V4.1 Flash (~5× cheaper) · Stop".
 *
 *   Keep going   the turn goes on; the next ask comes after another threshold's worth.
 *   Switch       the same turn goes on with the suggested model (nothing is lost).
 *   Stop         the turn ends with a note; "continue" picks it up later.
 *
 * The phone and the web Code page see it like a tool approval: approve is Keep going, deny is Stop
 * (Switch needs the app). No answer in COST_ASK_TIMEOUT_MS stops the turn: nothing more is spent.
 * Free models (this computer, your machines, a reservation, Auto) never ask; bots keep their own
 * budgets and never get here.
 */

import { randomUUID } from "node:crypto";
import {
  DEFAULT_REPLY_ASK_CSATS, DEFAULT_REPLY_ASK_USD, clampReplyAskCSats, clampReplyAskUsd, costAskQuestion, formatSpend, switchLabel,
} from "../../common/reply-cost.js";
import type { ChatFn } from "./agent-loop.js";
import type { IdeStreamEvent, ToolName } from "./tool-types.js";

/** The pseudo tool a cost check shows under (pending lists, the phone, the web Code page). */
export const COST_CHECK_TOOL = "cost_check" as ToolName;
/** How long a cost check waits for an answer before the turn stops. */
export const COST_ASK_TIMEOUT_MS = 10 * 60_000;

export type CostUnit = "cSats" | "usd";
export type CostChoice = "continue" | "switch" | "stop";

/** The threshold in cSats: the client's setting, else EDGECODER_REPLY_COST_ASK_CSATS, else 150. */
export function replyAskCSats(setting?: unknown, env: NodeJS.ProcessEnv = process.env): number {
  return clampReplyAskCSats(setting) ?? clampReplyAskCSats(env.EDGECODER_REPLY_COST_ASK_CSATS) ?? DEFAULT_REPLY_ASK_CSATS;
}

/** The threshold in USD (frontier key): the client's setting, else EDGECODER_REPLY_COST_ASK_USD, else 0.50. */
export function replyAskUsd(setting?: unknown, env: NodeJS.ProcessEnv = process.env): number {
  return clampReplyAskUsd(setting) ?? clampReplyAskUsd(env.EDGECODER_REPLY_COST_ASK_USD) ?? DEFAULT_REPLY_ASK_USD;
}

/** One reply's spend in its unit, and the tokens its calls reported. */
export class ReplyCostMeter {
  spent = 0;
  inputTokens = 0;
  outputTokens = 0;
  /** The spend at which the next ask is due. */
  private next: number;

  constructor(readonly unit: CostUnit, readonly threshold: number) {
    this.next = threshold;
  }

  /** A turn event: a `usage` event adds its cost (cSats, or USD on a frontier key) and tokens. */
  observe(e: IdeStreamEvent): void {
    if (e.type !== "usage") return;
    const add = this.unit === "usd" ? (typeof e.usd === "number" ? e.usd : e.served?.usd) : e.cSats;
    if (typeof add === "number" && Number.isFinite(add) && add > 0) this.spent += add;
    const p = e.served?.promptTokens;
    const o = e.served?.outputTokens;
    if (typeof p === "number" && Number.isFinite(p) && p > 0) this.inputTokens += p;
    if (typeof o === "number" && Number.isFinite(o) && o > 0) this.outputTokens += o;
  }

  /** The threshold's worth was spent since the last answer. */
  due(): boolean {
    return this.threshold > 0 && this.spent >= this.next;
  }

  /** Keep going (or switched): the next ask after another threshold's worth. */
  ack(): void {
    this.next = this.spent + this.threshold;
  }
}

/** A cheaper model to offer: the chat's model id ("network/deepseek-v4.1-flash@cloud", a local tag, "auto"). */
export interface CheaperModel {
  id: string;
  /** "DeepSeek V4.1 Flash". */
  name: string;
  /** How many times cheaper, when both prices are known. */
  factor?: number | null;
}

/** What the loop tells a cost check (agent-loop.ts costCheck). */
export interface CostCheckContext {
  /** Estimated tokens the reply's calls sent and wrote (used when the backend reported none). */
  inputTokens: number;
  outputTokens: number;
  /** The turn's waste persists after acting on it (turn-waste.ts): why. */
  waste: string | null;
}

export type CostVerdict = { action: "continue" } | { action: "stop"; note: string } | { action: "switch"; chat: ChatFn; name: string };

export interface CostCheckDeps {
  meter: ReplyCostMeter;
  sendEvent: (e: IdeStreamEvent) => void;
  /** Ask the owner (the app, the phone): resolves with their answer, or "stop" on timeout or cancel. */
  ask: (callId: string, args: Record<string, unknown>) => Promise<CostChoice>;
  /** The model to offer instead (null: no Switch). Asked once per check. */
  cheaper?: () => Promise<CheaperModel | null> | CheaperModel | null;
  /** The chat function for the switched model (null: it can't run here). */
  switchTo?: (m: CheaperModel) => ChatFn | null;
  /** Whether the asker can carry a Switch answer (the app can; a phone-started session turn can't). */
  canSwitch?: boolean;
}

/**
 * The agent loop's cost check (AgentLoopDeps.costCheck), asked before each model call after the
 * first. Under the threshold it only shows a one-line suggestion when the turn's waste persists.
 */
export function makeCostCheck(d: CostCheckDeps): (ctx: CostCheckContext) => Promise<CostVerdict> {
  let suggested = false;
  let switched = false;
  return async (ctx) => {
    if (!d.meter.due()) {
      if (ctx.waste && !suggested && !switched) {
        suggested = true;
        const m = await Promise.resolve(d.cheaper?.() ?? null).catch(() => null);
        if (m) d.sendEvent({ type: "cost_note", kind: "suggest", message: `This reply ${ctx.waste}. ${switchLabel(m.name, m.factor)} may fit exploring better (pick it in the model menu).`, suggest: { id: m.id, name: m.name, ...(m.factor ? { factor: m.factor } : {}) } });
      }
      return { action: "continue" };
    }
    const cheaper = switched ? null : await Promise.resolve(d.cheaper?.() ?? null).catch(() => null);
    const offer = cheaper && d.canSwitch !== false && d.switchTo ? cheaper : null;
    const inputTokens = d.meter.inputTokens || ctx.inputTokens;
    const outputTokens = d.meter.outputTokens || ctx.outputTokens;
    const question = costAskQuestion({ spent: d.meter.spent, unit: d.meter.unit, inputTokens, outputTokens });
    const callId = `cost_${randomUUID().slice(0, 8)}`;
    const args: Record<string, unknown> = {
      question,
      spent: Number(d.meter.spent.toFixed(6)),
      unit: d.meter.unit,
      threshold: d.meter.threshold,
      inputTokens,
      outputTokens,
      ...(ctx.waste ? { waste: `This reply ${ctx.waste}.` } : {}),
      ...(offer ? { suggest: { id: offer.id, name: offer.name, ...(offer.factor ? { factor: offer.factor } : {}) }, switchLabel: switchLabel(offer.name, offer.factor) } : {}),
    };
    d.sendEvent({ type: "tool_call", id: callId, tool: COST_CHECK_TOOL, args, requires_approval: true });
    const choice = await d.ask(callId, args).catch((): CostChoice => "stop");
    if (choice === "switch" && offer) {
      const chat = d.switchTo!(offer);
      if (chat) {
        switched = true;
        d.meter.ack();
        d.sendEvent({ type: "tool_result", id: callId, result: `Switched to ${offer.name}` });
        d.sendEvent({ type: "status", message: `Switched this reply to ${offer.name} to save cost.` });
        return { action: "switch", chat, name: offer.name };
      }
    }
    if (choice === "continue" || choice === "switch") {
      d.meter.ack();
      d.sendEvent({ type: "tool_result", id: callId, result: "Kept going" });
      return { action: "continue" };
    }
    d.sendEvent({ type: "tool_result", id: callId, result: "Stopped" });
    return { action: "stop", note: `_Stopped to save cost after ${formatSpend(d.meter.spent, d.meter.unit)} on this reply. Reply "continue" to pick up where it left off, or pick a cheaper model first._` };
  };
}

/** A cost check answer from an approval: approve is Keep going, deny is Stop, `choice` wins when given. */
export function costChoiceOf(approved: boolean, choice?: unknown): CostChoice {
  if (choice === "continue" || choice === "switch" || choice === "stop") return choice;
  return approved ? "continue" : "stop";
}

/** A network model as /inference/models lists it (the parts the suggestion needs). */
export interface ListedModel {
  model: string;
  classes?: string[];
  restricted?: string;
  cSatsPerMTokens?: { input: number; output: number; cachedInput?: number };
}

/** The model the cost check offers. */
export const PREFERRED_CHEAP_MODEL = "deepseek-v4.1-flash";

/**
 * A cheaper model than `current` (the chat's model and placement): deepseek-v4.1-flash (a cloud
 * model) when the network lists it, else the network's best fit (Auto), else a model on this computer.
 * `factor` from the two prices when both are in cSats (a network lead).
 */
export function pickCheaperModel(
  current: { model: string; target: string },
  o: { networkModels?: ListedModel[] | null; localModels?: string[] | null; connected?: boolean; referenceCost?: (p: { input: number; output: number; cachedInput?: number }) => number },
): CheaperModel | null {
  const listed = (o.networkModels ?? []).filter((m) => !m.restricted);
  const price = (name: string) => listed.find((m) => m.model === name)?.cSatsPerMTokens;
  const factorTo = (name: string): number | null => {
    if (current.target !== "network" || !o.referenceCost) return null;
    const a = price(current.model);
    const b = price(name);
    if (!a || !b) return null;
    const dear = o.referenceCost(a);
    const cheap = o.referenceCost(b);
    return dear > 0 && cheap > 0 && dear / cheap >= 2 ? Math.round(dear / cheap) : null;
  };
  const flash = listed.find((m) => m.model === PREFERRED_CHEAP_MODEL);
  if (flash && current.model !== PREFERRED_CHEAP_MODEL) {
    // Class "any", as the compute picker's chip for a cloud model writes it.
    return { id: `network/${PREFERRED_CHEAP_MODEL}`, name: "DeepSeek V4.1 Flash", factor: factorTo(PREFERRED_CHEAP_MODEL) };
  }
  if (current.model === PREFERRED_CHEAP_MODEL && current.target === "network") {
    // Already the cheap cloud model: only a free model is cheaper.
    const local = (o.localModels ?? []).find((m) => !/embed/i.test(m) && !/:cloud$|-cloud$/.test(m));
    return local ? { id: local, name: `${local} on this computer (free)` } : null;
  }
  if (o.connected !== false && listed.length) return { id: "auto", name: "Auto (best fit)" };
  const local = (o.localModels ?? []).find((m) => !/embed/i.test(m) && !/:cloud$|-cloud$/.test(m));
  return local ? { id: local, name: `${local} on this computer (free)` } : null;
}

/** The phone's side of an app turn (sessions.ts DesktopTurn): approve/deny only. */
interface MirrorAsk {
  ask(callId: string, tool: ToolName, args: Record<string, unknown>): Promise<boolean>;
  answered(callId: string, approved: boolean): void;
}

/**
 * A cost check in the app's turn waits for its first answer: the app's (`register` hands over the
 * answer functions; /v1/ide/tool-approval calls them, with `choice` for Switch), the phone's through
 * the mirror (approve = Keep going, deny = Stop), or Stop after `timeoutMs`.
 */
export function firstCostAnswer(
  callId: string,
  args: Record<string, unknown>,
  mirror: MirrorAsk | null,
  register: (answer: { resolve: (approved: boolean) => void; choose: (choice: CostChoice) => void }) => void,
  unregister: () => void,
  timeoutMs = COST_ASK_TIMEOUT_MS,
): Promise<CostChoice> {
  return new Promise<CostChoice>((resolve) => {
    let settled = false;
    const settle = (choice: CostChoice, fromMirror = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unregister();
      if (!fromMirror) mirror?.answered(callId, choice !== "stop");
      resolve(choice);
    };
    const timer = setTimeout(() => settle("stop"), timeoutMs);
    register({ resolve: (approved) => settle(approved ? "continue" : "stop"), choose: (c) => settle(c) });
    void mirror?.ask(callId, COST_CHECK_TOOL, args).then((approved) => settle(approved ? "continue" : "stop", true));
  });
}
