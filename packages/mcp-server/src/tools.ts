// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * The MCP tools, as plain handlers over an HTTP function (so they are testable without MCP):
 * list_models, chat, balance, topup, topup_status, usage, reserve_machine, list_reservations,
 * cancel_reservation. Each maps to one route of the portal's hosted API (/v1/...).
 */

import { z } from "zod";
import type { Http, HttpResult } from "./http.js";

export type ToolResult = {
  [extra: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Calls the API with the current key; on 401 renews the key once (agent signup) and retries. */
export function authedHttp(http: Http, key: { current: () => Promise<string>; renew?: () => Promise<string> }) {
  return async (method: "GET" | "POST", path: string, body?: unknown): Promise<HttpResult> => {
    const r = await http(method, path, body, await key.current());
    if (r.status !== 401 || !key.renew) return r;
    return http(method, path, body, await key.renew());
  };
}
export type Api = ReturnType<typeof authedHttp>;

const ok = (data: Record<string, unknown>, text?: string): ToolResult => ({
  content: [{ type: "text", text: text ?? JSON.stringify(data, null, 2) }],
  structuredContent: data,
});
const fail = (r: HttpResult): ToolResult => {
  const e = r.json?.error;
  const msg = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : JSON.stringify(r.json);
  const hint = r.status === 402 ? " (balance too low: use topup to get a Lightning invoice and pay it)" : "";
  return { content: [{ type: "text", text: `EdgeCoder error ${r.status}: ${msg}${hint}` }], isError: true };
};
const good = (r: HttpResult) => r.status >= 200 && r.status < 300;

const message = z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() });
const classes = z.enum(["cpu", "apple", "gpu", "gpu.dc"]);

export const toolShapes = {
  list_models: {},
  chat: {
    prompt: z.string().optional().describe("The user message (or pass messages)."),
    messages: z.array(message).optional().describe("A whole conversation, OpenAI style."),
    system: z.string().optional().describe("System prompt."),
    model: z.string().optional().describe('Model id from list_models. Default "auto": the cheapest place that fits.'),
    max_tokens: z.number().int().min(1).max(32_768).optional(),
    temperature: z.number().min(0).max(2).optional(),
  },
  balance: {},
  topup: { amountSats: z.number().int().min(100).max(1_000_000).describe("Sats to add (100 to 1,000,000).") },
  topup_status: { intentId: z.string().min(1).max(100).describe("intentId returned by topup.") },
  usage: { days: z.number().int().min(1).max(90).optional().describe("Days back (default 30).") },
  reserve_machine: {
    computeClass: classes.describe("cpu, apple, gpu or gpu.dc"),
    minutes: z.number().int().min(1).max(24 * 60),
    model: z.string().min(1).max(200).optional().describe("Model the machine must have."),
  },
  list_reservations: {},
  cancel_reservation: { reservationId: z.string().min(1).max(100) },
} as const;

export type ToolName = keyof typeof toolShapes;
type Args<N extends ToolName> = z.infer<z.ZodObject<(typeof toolShapes)[N]>>;

export const toolDescriptions: Record<ToolName, string> = {
  list_models: 'Models you can run on EdgeCoder, including "auto" (picks the cheapest place that fits).',
  chat: "Run a chat completion on EdgeCoder compute. Returns the reply, what it cost (cSats) and where it ran.",
  balance: "Your EdgeCoder balance in cSats (1 cSat is 1 sat of compute) and recent ledger entries.",
  topup: "Get a Lightning invoice (bolt11) that adds sats to your balance once paid from your own wallet.",
  topup_status: "Whether a top-up invoice has been paid and credited.",
  usage: "Requests, cost and tokens by day and model.",
  reserve_machine: "Reserve one machine of a class for some minutes (paid up front, unused time refunded).",
  list_reservations: "Your reservations, and what can be reserved now per class.",
  cancel_reservation: "Cancel a reservation (unused time is refunded).",
};

export type Handlers = { [N in ToolName]: (args: Args<N>) => Promise<ToolResult> };

export function makeHandlers(api: Api): Handlers {
  return {
    async list_models() {
      const r = await api("GET", "/v1/models");
      if (!good(r)) return fail(r);
      const models = ((r.json?.data ?? []) as Array<{ id: string }>).map((m) => m.id);
      return ok({ models }, models.join("\n"));
    },

    async chat(a) {
      const messages = [...(a.system ? [{ role: "system", content: a.system }] : []), ...(a.messages ?? []), ...(a.prompt ? [{ role: "user", content: a.prompt }] : [])];
      if (!messages.some((m) => m.role === "user")) return { content: [{ type: "text", text: "chat needs a prompt or messages with a user turn" }], isError: true };
      const model = a.model || "auto";
      const r = await api("POST", "/v1/chat/completions", {
        model,
        messages,
        stream: false,
        ...(a.max_tokens ? { max_tokens: a.max_tokens } : {}),
        ...(a.temperature !== undefined ? { temperature: a.temperature } : {}),
      });
      if (!good(r)) return fail(r);
      const text = String(r.json?.choices?.[0]?.message?.content ?? "");
      const ec = r.json?.edgecoder ?? {};
      const data = { text, model: r.json?.model ?? model, cSats: ec.cSatsSpent ?? null, where: ec.where ?? null, usage: r.json?.usage ?? null };
      const footer = [data.cSats !== null ? `${data.cSats} cSats` : null, data.where ? `ran on ${data.where}` : null].filter(Boolean).join(" · ");
      return ok(data, footer ? `${text}\n\n[${footer}]` : text);
    },

    async balance() {
      const r = await api("GET", "/v1/account");
      if (!good(r)) return fail(r);
      const data = { accountId: r.json.accountId, cSats: r.json.cSats, earnedSats: r.json.earnedSats ?? null, recent: (r.json.recent ?? []).slice(0, 10) };
      return ok(data);
    },

    async topup(a) {
      const r = await api("POST", "/v1/account/topup", { amountSats: a.amountSats });
      if (!good(r)) return fail(r);
      const j = r.json;
      const data = { invoice: j.invoice, amountSats: j.amountSats, cSats: j.cSats, feeSats: j.feeSats, intentId: j.intentId, network: j.network, expiresInSeconds: j.expiresInSeconds };
      return ok(
        data,
        `Pay this Lightning invoice (${j.amountSats} sats${j.feeSats ? `, ${j.feeSats} sats fee` : ""}) from your wallet; it credits ${j.cSats} cSats and expires in ${j.expiresInSeconds}s.\n\n${j.invoice}\n\nintentId: ${j.intentId} (check with topup_status)`,
      );
    },

    async topup_status(a) {
      const r = await api("GET", `/v1/account/topup/${encodeURIComponent(a.intentId)}`);
      return good(r) ? ok(r.json) : fail(r);
    },

    async usage(a) {
      const r = await api("GET", `/v1/account/usage?days=${a.days ?? 30}`);
      if (!good(r)) return fail(r);
      const j = r.json;
      return ok({ totals: j.totals, byDay: j.byDay, byModel: j.byModel, recent: (j.records ?? []).slice(0, 20) });
    },

    async reserve_machine(a) {
      const r = await api("POST", "/v1/account/reservations", { computeClass: a.computeClass, minutes: a.minutes, ...(a.model ? { model: a.model } : {}) });
      return good(r) ? ok(r.json) : fail(r);
    },

    async list_reservations() {
      const r = await api("GET", "/v1/account/reservations");
      return good(r) ? ok(r.json) : fail(r);
    },

    async cancel_reservation(a) {
      const r = await api("POST", "/v1/account/reservations/cancel", { reservationId: a.reservationId });
      return good(r) ? ok(r.json) : fail(r);
    },
  };
}
