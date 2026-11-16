// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Who may use a frontier key, and the backends built on it, in the IDE provider (the only process
 * that ever builds a frontier backend; docs/frontier-keys.md).
 *
 * The rule: a key is usable only for requests of the EdgeCoder account that added it, while that
 * account is the one signed in on this computer. Concretely, a frontier backend is built only when
 *   - an account is signed in here (`account()`),
 *   - the key belongs to that account,
 *   - the request is that account's own: the requester (a remote client's authenticated account;
 *     this computer's own clients act for the account signed in here) and, for a session, the
 *     session's owner are that same account.
 * Anything else is refused; a session falls back to its worker model with a note. The network,
 * bots and other accounts' requests never reach a frontier backend.
 */

import { ANTHROPIC_MODELS, frontierDisplayName, frontierModelId, parseFrontierModelId } from "../../inference-api/frontier-models.js";
import { FrontierKeyError, type FrontierKeyStore, type FrontierProvider } from "../../inference-api/frontier-keys.js";
import { frontierBackend, testFrontierKey, withSpendControls, type FrontierTarget } from "../../inference-api/frontier.js";
import type { FrontierSpend } from "../../inference-api/frontier-usage.js";
import { estimateComplexity } from "../../inference-api/job-complexity.js";
import { ChatBackendError, type ChatBackend } from "../../inference-api/types.js";
import { backendChat, type ChatFn } from "./agent-loop.js";
import type { IdeStreamEvent } from "./tool-types.js";

export interface FrontierAccessDeps {
  store: FrontierKeyStore;
  spend: FrontierSpend;
  /** The EdgeCoder account signed in on this computer (`acct-...`), or null when none is. */
  account: () => Promise<string | null>;
  /** Tests: fake provider timings. */
  target?: Partial<Pick<FrontierTarget, "maxRetries" | "baseDelayMs" | "sleep">>;
}

export interface FrontierRequest {
  /** The authenticated account of a remote requester; undefined = this computer's own client. */
  requester?: string | null;
  /** For a session: its owner (the account signed in when it was created). */
  owner?: string;
  /** Key for the per-session spend cap ("session:<id>", "chat:<turn>"). */
  sessionKey: string;
  onWarn?: (message: string) => void;
  onCost?: (usd: number, totals: { sessionUsd: number; dayUsd: number }) => void;
}

export type FrontierResolution =
  | { ok: true; backend: ChatBackend; label: string; provider: FrontierProvider; model: string }
  | { ok: false; status: number; message: string; reason: "not_signed_in" | "other_account" | "no_key" | "bad_id" };

export class FrontierAccess {
  constructor(private readonly d: FrontierAccessDeps) {}

  get store(): FrontierKeyStore {
    return this.d.store;
  }

  get spend(): FrontierSpend {
    return this.d.spend;
  }

  /** `frontier/...` ids the signed-in account can use here (none for anyone else). */
  async modelIds(): Promise<string[]> {
    const account = await this.d.account().catch(() => null);
    const ids: string[] = [];
    for (const p of this.d.store.list(account)) {
      if (!p.usable) continue;
      const models = p.kind === "anthropic" ? ANTHROPIC_MODELS.map((m) => m.id) : p.models ?? [];
      for (const m of models) ids.push(frontierModelId(p.id, m));
    }
    return ids;
  }

  /** Settings, providers (never keys) and spend, for Settings and `edgecoder keys list`. */
  async status() {
    const account = await this.d.account().catch(() => null);
    return {
      account,
      storage: this.d.store.storageLabel,
      fallbackFile: this.d.store.fallback,
      providers: this.d.store.list(account),
      models: await this.modelIds(),
      settings: this.d.store.settings(),
      spend: this.d.spend.summary(),
    };
  }

  /** A backend for `id`, only for the signed-in account's own request. */
  async resolve(id: string, req: FrontierRequest): Promise<FrontierResolution> {
    const parsed = parseFrontierModelId(id);
    if (!parsed) return { ok: false, status: 400, reason: "bad_id", message: `${id} isn't a frontier model id (frontier/<provider>/<model>).` };
    const account = await this.d.account().catch(() => null);
    if (!account) return { ok: false, status: 409, reason: "not_signed_in", message: "Sign in to EdgeCoder on this computer to use your frontier keys." };
    const requester = req.requester === undefined ? account : req.requester;
    const owner = req.owner ?? account;
    if (requester !== account || owner !== account) {
      return { ok: false, status: 403, reason: "other_account", message: `Frontier lead is limited to ${owner}'s own requests.` };
    }
    const provider = this.d.store.usable(parsed.provider, account);
    if (!provider) {
      const other = this.d.store.list(account).some((p) => p.id === parsed.provider);
      return other
        ? { ok: false, status: 403, reason: "other_account", message: `The ${parsed.provider} key on this computer belongs to another account; add your own in Settings → Frontier models.` }
        : { ok: false, status: 404, reason: "no_key", message: `No ${parsed.provider} key for your account on this computer. Add one in Settings → Frontier models (or \`edgecoder keys add ${parsed.provider}\`).` };
    }
    const settings = this.d.store.settings();
    const store = this.d.store;
    const backend = frontierBackend({
      provider,
      model: parsed.model,
      // Read per call, and only while the same account is still signed in.
      apiKey: async () => {
        const now = await this.d.account().catch(() => null);
        try {
          return await store.key(provider.id, now);
        } catch (err) {
          throw new ChatBackendError((err as Error).message, err instanceof FrontierKeyError ? err.status : 500);
        }
      },
      effort: settings.effort,
      prices: settings.prices,
      ...this.d.target,
    });
    return {
      ok: true,
      provider,
      model: parsed.model,
      label: `${frontierDisplayName(provider.id, parsed.model)} · your key`,
      backend: withSpendControls(backend, {
        spend: this.d.spend,
        sessionKey: req.sessionKey,
        model: `${provider.id}/${parsed.model}`,
        caps: () => this.d.store.settings(),
        onWarn: req.onWarn,
        onCost: req.onCost,
      }),
    };
  }

  /** Test a key without storing it: the provider's model list. */
  async test(input: { id: string; kind?: FrontierProvider["kind"]; baseUrl?: string; key: string }): Promise<{ models: string[] }> {
    const kind = input.id === "anthropic" ? "anthropic" : input.kind ?? "openai-compatible";
    return testFrontierKey({ id: input.id, kind, baseUrl: input.baseUrl }, input.key);
  }

  /** Test, then store a key for the signed-in account. */
  async add(input: { id: string; kind?: FrontierProvider["kind"]; baseUrl?: string; key: string; skipTest?: boolean }) {
    const account = await this.d.account().catch(() => null);
    if (!account) throw new FrontierKeyError("Sign in to EdgeCoder on this computer before adding a key: it is bound to your account.", 409);
    const id = input.id.trim().toLowerCase();
    const models = input.skipTest ? [] : (await this.test({ ...input, id })).models;
    const saved = await this.d.store.add({ id, kind: input.kind, baseUrl: input.baseUrl, key: input.key, accountId: account, models: id === "anthropic" ? undefined : models });
    return { provider: saved, models };
  }

  /** Re-test a stored key (the signed-in account's own). */
  async retest(id: string): Promise<{ models: string[] }> {
    const account = await this.d.account().catch(() => null);
    const p = this.d.store.usable(id, account);
    if (!p) throw new FrontierKeyError(`No usable ${id} key for your account on this computer.`, 404);
    const r = await testFrontierKey(p, await this.d.store.key(id, account));
    if (p.kind !== "anthropic") this.d.store.setModels(id, p.accountId, r.models);
    return r;
  }

  /** Remove the signed-in account's key, or another account's (`ownerAccount`): removable, never usable. */
  async remove(id: string, ownerAccount?: string): Promise<boolean> {
    const account = await this.d.account().catch(() => null);
    const owner = ownerAccount ?? account;
    if (!owner) throw new FrontierKeyError("Say which account's key to remove (ownerAccount): nobody is signed in here.", 409);
    return this.d.store.remove(id, owner);
  }
}

/**
 * Auto, with "use my frontier key for Auto" on: high-complexity jobs go to the default lead on the
 * user's own key (when this account may use it); everything else, and any refusal, stays on Auto.
 */
export function autoWithFrontier(o: { auto: ChatBackend; access: FrontierAccess; request: () => FrontierRequest; onPick?: (label: string) => void }): ChatBackend {
  return async function* (req, signal) {
    const settings = o.access.store.settings();
    if (settings.useForAuto) {
      const c = estimateComplexity({ messages: req.messages, tools: req.tools, maxTokens: req.maxTokens }, req.hints?.complexity);
      if (c.level === "high" || c.level === "very_high") {
        const r = await o.access.resolve(settings.defaultLead, o.request()).catch(() => null);
        if (r?.ok) {
          o.onPick?.(r.label);
          return yield* r.backend(req, signal);
        }
      }
    }
    return yield* o.auto(req, signal);
  };
}

/**
 * A frontier model call in the agent's ChatFn shape: spend shows as USD (never cSats), cap warnings
 * as status events. When the request isn't the key owner's own (another account's client in a
 * session), `fallback` (the session's worker model) runs it instead, with a note; without a
 * fallback, or for any other refusal, the call fails with the reason.
 */
export function frontierChat(o: { access: FrontierAccess; id: string; request: Omit<FrontierRequest, "onWarn" | "onCost">; sendEvent: (e: IdeStreamEvent) => void; signal?: AbortSignal; fallback?: () => ChatFn }): ChatFn {
  let label = o.id;
  let resolved: Promise<ChatFn> | null = null;
  const pick = async (): Promise<ChatFn> => {
    const r = await o.access.resolve(o.id, {
      ...o.request,
      onWarn: (message) => o.sendEvent({ type: "status", message }),
    });
    if (r.ok) {
      label = r.label;
      // One usage event per call, with a served line (provider · your key · tokens · USD).
      return backendChat(r.backend, (_cSats, served) => o.sendEvent({ type: "usage", cSats: 0, where: label, model: o.id, ...(served ? { served } : {}), ...(served?.usd !== undefined ? { usd: served.usd } : {}) }), o.signal);
    }
    if (r.reason === "other_account" && o.fallback) {
      o.sendEvent({ type: "status", message: `${r.message} Using the worker model for this turn.` });
      return o.fallback();
    }
    throw new ChatBackendError(r.message, r.status);
  };
  return async (input, onDelta) => (await (resolved ??= pick()))(input, onDelta);
}
