// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * A desktop bot led by its owner's frontier key (docs/frontier-keys.md, "Bots and your key").
 *
 * A bot uses the key only when only its owner can start it, and only after the owner approves:
 *   1. before the first model call that would use the key, FrontierAccess.forBot checks what
 *      started the run (never GitHub), that the bot has no GitHub triggers, that the account signed
 *      in here is the bot's owner and owns the key, and that the caps have room (the bot's daily
 *      cap, the key's daily cap). Any refusal: the run stays on the bot's own compute, with a note
 *      ("Claude lead off: GitHub trigger").
 *   2. then it asks the owner in the bot's chat: "Use Claude for this run? Up to $2.00." Approve
 *      this run, approve for today (until local midnight, within the bot's daily cap), or decline.
 *      No answer in 30 minutes counts as decline. While it waits the run is paused (like a tool
 *      approval): nothing is spent anywhere.
 *   3. reaching the run cap stops the key and asks again (the same three choices; the run waits).
 *
 * The key leads (plans, tool calls); the bot's compute policy is the worker: compaction summaries
 * and every call once the key is off. With the bot on Auto and "Use my frontier key for Auto" on,
 * a bot without its own switch uses the key only for high-complexity steps (the same estimate as
 * autoWithFrontier), behind the same checks, approval and caps.
 *
 * Spend is logged under "bot:<id>" (FrontierSpend); cloud bots, other accounts and the network
 * never get here.
 */

import { complexityWeightsFromEnv, estimateComplexity } from "../../inference-api/job-complexity.js";
import { formatUsd } from "../../inference-api/frontier-models.js";
import { ChatBackendError } from "../../inference-api/types.js";
import { backendChat, type ChatFn } from "./agent-loop.js";
import {
  DEFAULT_BOT_FRONTIER_DAILY_CAP_USD, DEFAULT_BOT_FRONTIER_RUN_CAP_USD, botSpendKey, frontierLeadName, type FrontierAccess,
} from "./frontier-access.js";
import type { IdeStreamEvent } from "./tool-types.js";

/** How long the owner has to answer before the run goes on without the key. */
export const FRONTIER_ASK_TIMEOUT_MS = 30 * 60_000;

/** The owner's answer to "Use Claude for this run?". */
export type FrontierChoice = "run" | "day" | "decline";
/** What an ask resolves with: an answer, or nobody answered (timeout) or the run stopped. */
export type FrontierAnswer = FrontierChoice | "timeout" | "cancelled";

/** The pseudo tool name a frontier ask shows under in a bot's pending list (the approval path). */
export const FRONTIER_ASK_TOOL = "use_frontier";

export interface FrontierAsk {
  /** The frontier model id. */
  model: string;
  /** "Claude". */
  name: string;
  /** The run cap (USD) the approval covers. */
  capUsd: number;
  /** First ask in a run, or the run cap was reached. */
  why: "start" | "run_cap";
}

/** "Use Claude for this run? Up to $2.00." */
export function frontierAskQuestion(a: Pick<FrontierAsk, "name" | "capUsd" | "why">): string {
  return a.why === "run_cap"
    ? `This run reached its ${formatUsd(a.capUsd)} cap. Keep using ${a.name}? Up to ${formatUsd(a.capUsd)} more.`
    : `Use ${a.name} for this run? Up to ${formatUsd(a.capUsd)}.`;
}

/** What BotManager gives a run so it can ask its owner (bots.ts execute). */
export interface BotFrontierHooks {
  ask: (a: FrontierAsk) => Promise<FrontierAnswer>;
  /** The owner approved every run today (until local midnight). */
  dayApproved: () => boolean;
}

/** The bot fields this needs (BotConfig). */
export interface BotFrontierFields {
  id: string;
  ownerAccount?: string;
  frontierLead?: string | null;
  frontierRunCapUsd?: number;
  frontierDailyCapUsd?: number;
  triggers: unknown[];
  compute?: { policy: string };
}

export type LeadChatFn = ChatFn & { escalate?: () => boolean; summarize?: (text: string) => Promise<string | null> };

/** Does this bot want the key for this run at all (its switch, or Auto with the setting on)? */
export function botFrontierMode(bot: BotFrontierFields, useForAuto: boolean): "lead" | "auto" | null {
  if (bot.frontierLead) return "lead";
  if (useForAuto && (bot.compute?.policy ?? "auto") === "auto") return "auto";
  return null;
}

/**
 * The bot's model calls with its owner's key as the lead (see the header). `worker` is the bot's
 * own compute (botComputeChat): it runs every call until the key is approved, every call once the
 * key is off, Auto's ordinary steps, and compaction summaries.
 */
export function botFrontierChat(o: {
  bot: BotFrontierFields;
  trigger: string;
  access: FrontierAccess;
  worker: LeadChatFn;
  hooks: BotFrontierHooks | undefined;
  sendEvent: (e: IdeStreamEvent) => void;
  signal?: AbortSignal;
  isCancelled?: () => boolean;
}): LeadChatFn {
  const settings = o.access.store.settings();
  const mode = botFrontierMode(o.bot, settings.useForAuto);
  if (!o.hooks || !mode) return o.worker;
  const hooks = o.hooks;
  const model = o.bot.frontierLead || settings.defaultLead;
  const name = frontierLeadName(model);
  const runCap = o.bot.frontierRunCapUsd ?? DEFAULT_BOT_FRONTIER_RUN_CAP_USD;
  const dailyCap = o.bot.frontierDailyCapUsd ?? DEFAULT_BOT_FRONTIER_DAILY_CAP_USD;
  let off: string | null = null;
  let approved = false;
  /** Spent on the key since the owner last approved (against the run cap). */
  let sinceApproval = 0;
  let lead: ChatFn | null = null;
  let label = name;

  const turnOff = (note: string) => {
    off = note;
    o.sendEvent({ type: "status", message: `${note}. The bot's own compute runs the rest of this run.`, note });
  };

  const viaKey = async (): Promise<ChatFn | null> => {
    if (lead) return lead;
    const r = await o.access.resolve(model, {
      owner: o.bot.ownerAccount,
      sessionKey: botSpendKey(o.bot.id),
      // The bot's own caps are checked here (forBot); the key's daily cap still stops every call.
      caps: () => ({ sessionCapUsd: null, dailyCapUsd: o.access.store.settings().dailyCapUsd }),
      onWarn: (message) => o.sendEvent({ type: "status", message }),
      onCost: (usd) => {
        sinceApproval += usd;
      },
    });
    if (!r.ok) {
      turnOff(`${name} lead off: ${r.message.replace(/\.$/, "")}`);
      return null;
    }
    label = r.label;
    lead = backendChat(r.backend, (_cSats, served) => o.sendEvent({ type: "usage", cSats: 0, where: label, model, ...(served ? { served } : {}), ...(served?.usd !== undefined ? { usd: served.usd } : {}) }), o.signal);
    return lead;
  };

  const chat: LeadChatFn = async (input, onDelta) => {
    if (off !== null) return o.worker(input, onDelta);
    if (mode === "auto") {
      const c = estimateComplexity({ messages: input.messages as never, tools: input.tools as never }, undefined, complexityWeightsFromEnv());
      if (c.level !== "high" && c.level !== "very_high") return o.worker(input, onDelta);
    }
    const v = await o.access.forBot({
      botId: o.bot.id,
      ownerAccount: o.bot.ownerAccount,
      trigger: o.trigger,
      githubTriggers: o.bot.triggers.length,
      model,
      runSpentUsd: sinceApproval,
      runCapUsd: runCap,
      dailyCapUsd: dailyCap,
    });
    if (!v.ok) {
      turnOff(v.note);
      return o.worker(input, onDelta);
    }
    if (!approved || v.runCapReached) {
      if (!approved && !v.runCapReached && hooks.dayApproved()) {
        approved = true;
        o.sendEvent({ type: "status", message: `${name} leads this run (you approved it for today).` });
      } else {
        const answer = await hooks.ask({ model, name, capUsd: runCap, why: v.runCapReached ? "run_cap" : "start" });
        if (answer === "cancelled" || o.isCancelled?.()) throw new Error("cancelled");
        if (answer === "decline" || answer === "timeout") {
          turnOff(`${name} lead off: ${answer === "timeout" ? "no answer in 30 minutes" : "you declined"}`);
          return o.worker(input, onDelta);
        }
        approved = true;
        sinceApproval = 0;
        o.sendEvent({ type: "status", message: `${name} leads this run (${answer === "day" ? "approved for today" : "approved for this run"}, up to ${formatUsd(runCap)}).` });
      }
    }
    const fn = await viaKey();
    if (!fn) return o.worker(input, onDelta);
    try {
      return await fn(input, onDelta);
    } catch (err) {
      // The key's daily cap stopped the call before anything was sent: carry on without it.
      if (err instanceof ChatBackendError && err.status === 402) {
        turnOff(`${name} lead off: ${err.message.replace(/\.$/, "")}`);
        return o.worker(input, onDelta);
      }
      throw err;
    }
  };
  // Escalating moves along the bot's own ranking; a run led by the key has nowhere else to go.
  chat.escalate = () => (mode === "auto" || off !== null || !approved ? (o.worker.escalate?.() ?? false) : false);
  // Compaction summaries run on the worker, never on the key.
  chat.summarize = async (text) => {
    const r = await o.worker({
      messages: [
        { role: "system", content: "Summarize this coding-agent conversation for the agent itself, in at most 200 words: what was asked, what was found and changed (with exact file paths and line numbers), and what is left to do. No preamble." },
        { role: "user", content: text },
      ],
    });
    return r.content.trim() || null;
  };
  return chat;
}
