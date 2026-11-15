// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * The wallet for a signed-in portal user (web, desktop and iOS all read it):
 *
 * - GET /portal/api/wallet/overview: one read-only view of everything the Wallet screens show:
 *   cSats balance and recent ledger rows, the network (regtest / testnet / signet / bitcoin) so
 *   test sats are never mistaken for real ones, the BTC/USD rate from the rate oracle, both fees
 *   (purchase fee and network fee, in basis points, as the coordinator applies them), prices per
 *   compute class and per model, and the payout balance, policy, limits and pause state.
 * - POST /portal/api/wallet/topup and GET /portal/api/wallet/topup/:intentId: a Lightning invoice
 *   that credits this account, and whether it was paid. The session twin of /v1/account/topup
 *   (hosted.ts, API key); both call the coordinator's existing /account/buy and /account/intent,
 *   which price the purchase (docs/economy-math.md section 2). Nothing here computes money. A
 *   created invoice also carries `qrSvg`, its QR code (invoice-qr.ts).
 * - `launch`: the coordinator's soft-launch caps in LAUNCH_MODE=invite (null otherwise), which
 *   the Wallet shows as "Early access: up to N sats per day".
 * - GET /portal/api/wallet/onchain and POST /portal/api/wallet/onchain/address: Fund with Bitcoin
 *   (ONCHAIN_ENABLED on the coordinator). The account's deposit address (with `qrSvg` for its
 *   bitcoin: URI) and its deposits with their confirmations; the coordinator credits a deposit
 *   once it has enough confirmations (/account/onchain/*).
 *
 * Every coordinator call goes through portalCoordinatorTransport, which binds the account to the
 * session (acct-<userId>); the client never names an account.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { computeOverview } from "../../apps/ide/network-inference.js";
import { withAddressQr, withInvoiceQr } from "../invoice-qr.js";
import { accountIdFor, portalCoordinatorTransport, portalNetworkDeps, type ComputeRoutesDeps } from "./compute.js";

export interface WalletApiDeps extends ComputeRoutesDeps {
  /** The portal's configured network (WALLET_DEFAULT_NETWORK), used only when the coordinator does not say. */
  fallbackNetwork: string;
}

/** The limits /account/buy enforces (whole sats). */
export const TOPUP_MIN_SATS = 100;
export const TOPUP_MAX_SATS = 1_000_000;

type Json = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The response of GET /portal/api/wallet/overview (pure, so the shape is tested without a coordinator). */
export function walletOverviewView(input: {
  fallbackNetwork: string;
  overview: { connected: boolean; account?: Json; classes?: unknown; models?: unknown } | null;
  rates: Json | null;
  book: Json | null;
  payouts: Json | null;
}) {
  const acct = input.overview?.account ?? null;
  const epoch = (input.rates?.epoch ?? null) as Json | null;
  const policy = (input.payouts?.policy ?? null) as Json | null;
  const coordinatorNetwork = typeof policy?.network === "string" ? policy.network : null;
  // Soft launch (src/economy/launch-gate.ts): the coordinator's caps, shown as "Early access".
  const launchRaw = (policy?.launch ?? null) as Json | null;
  const launch =
    launchRaw && launchRaw.mode === "invite"
      ? {
          mode: "invite" as const,
          maxBuySatsPerDay: num(launchRaw.maxBuySatsPerDay) ?? 0,
          maxBalanceSats: num(launchRaw.maxBalanceSats) ?? 0,
          maxPayoutSatsPerDay: num(launchRaw.maxPayoutSatsPerDay) ?? 0,
          boughtWindowSats: num(launchRaw.boughtWindowSats) ?? 0
        }
      : null;
  return {
    connected: Boolean(input.overview?.connected && acct),
    network: coordinatorNetwork ?? input.fallbackNetwork,
    networkSource: coordinatorNetwork ? ("coordinator" as const) : ("portal" as const),
    accountId: typeof acct?.accountId === "string" ? acct.accountId : null,
    cSats: num(acct?.cSats),
    earnedSats: num(acct?.earnedSats),
    recent: Array.isArray(acct?.recent) ? acct!.recent : [],
    btcUsd: num(epoch?.btcUsd),
    rateAsOfMs: num(epoch?.createdAtMs),
    rateStale: input.rates?.stale === true,
    fees: { purchaseFeeBps: num(input.book?.purchaseFeeBps), networkFeeBps: num(input.book?.networkFeeBps) },
    topup: { minSats: TOPUP_MIN_SATS, maxSats: TOPUP_MAX_SATS },
    launch,
    classes: (input.overview?.classes as Json | undefined) ?? {},
    models: Array.isArray(input.overview?.models) ? input.overview!.models : [],
    payouts: input.payouts ? { balance: input.payouts.balance ?? null, policy, payouts: Array.isArray(input.payouts.payouts) ? input.payouts.payouts : [] } : null
  };
}

export function registerWalletApiRoutes(app: FastifyInstance, deps: WalletApiDeps): void {
  const userOf = async (req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (!deps.store) {
      reply.code(503).send({ error: "portal_database_not_configured" });
      return null;
    }
    const user = await deps.getCurrentUser(req as { headers: Record<string, unknown> });
    if (!user) reply.code(401).send({ error: "not_authenticated" });
    return user;
  };
  const unreachable = { status: 502, json: { error: "coordinator_unreachable" } as Json };

  app.get("/portal/api/wallet/overview", async (req, reply) => {
    const user = await userOf(req, reply);
    if (!user) return reply;
    const accountId = accountIdFor(user.userId);
    const t = portalCoordinatorTransport(deps, accountId);
    const ok = (r: { status: number; json: unknown }) => (r.status === 200 ? (r.json as Json) : null);
    const [overview, rates, book, payouts] = await Promise.all([
      computeOverview(portalNetworkDeps(deps, accountId)).catch(() => null),
      t("GET", "/economy/rates/current").then(ok).catch(() => null),
      t("GET", "/economy/market/book").then(ok).catch(() => null),
      t("GET", `/economy/payouts/${encodeURIComponent(accountId)}`).then(ok).catch(() => null)
    ]);
    return reply.send(walletOverviewView({ fallbackNetwork: deps.fallbackNetwork, overview: overview as never, rates, book, payouts }));
  });

  app.post("/portal/api/wallet/topup", async (req, reply) => {
    const user = await userOf(req, reply);
    if (!user) return reply;
    const parsed = z.object({ amountSats: z.number().int().min(TOPUP_MIN_SATS).max(TOPUP_MAX_SATS) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_amount", detail: `amountSats: whole sats, ${TOPUP_MIN_SATS} to ${TOPUP_MAX_SATS.toLocaleString("en-US")}` });
    const r = await portalCoordinatorTransport(deps, accountIdFor(user.userId))("POST", "/account/buy", { amountSats: parsed.data.amountSats }).catch(() => unreachable);
    // qrSvg: the invoice as a QR code (invoice-qr.ts), drawn from the BOLT11 string only.
    return reply.code(r.status === 0 ? 502 : r.status).send(withInvoiceQr(r.status, r.json));
  });

  app.get("/portal/api/wallet/onchain", async (req, reply) => {
    const user = await userOf(req, reply);
    if (!user) return reply;
    const r = await portalCoordinatorTransport(deps, accountIdFor(user.userId))("POST", "/account/onchain/deposits", {}).catch(() => unreachable);
    return reply.code(r.status === 0 ? 502 : r.status).send(withAddressQr(r.status, r.json));
  });

  app.post("/portal/api/wallet/onchain/address", async (req, reply) => {
    const user = await userOf(req, reply);
    if (!user) return reply;
    const r = await portalCoordinatorTransport(deps, accountIdFor(user.userId))("POST", "/account/onchain/address", {}).catch(() => unreachable);
    return reply.code(r.status === 0 ? 502 : r.status).send(withAddressQr(r.status, r.json));
  });

  app.get("/portal/api/wallet/topup/:intentId", async (req, reply) => {
    const user = await userOf(req, reply);
    if (!user) return reply;
    const parsed = z.object({ intentId: z.string().min(1).max(100) }).safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_intent" });
    const r = await portalCoordinatorTransport(deps, accountIdFor(user.userId))("POST", "/account/intent", { intentId: parsed.data.intentId }).catch(() => unreachable);
    return reply.code(r.status === 0 ? 502 : r.status).send(r.json);
  });
}
