// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Getting started (src/common/onboarding.ts): the wizard's progress per account, and the real
 * account state its checklists read. The desktop app and /portal/welcome share both.
 *
 *   GET  /portal/api/onboarding   { state, signals, show }   state is null before the first save
 *   POST /portal/api/onboarding   a partial state ({ goal, current, done, skipped, routing,
 *                                 dismissed, completed, firstTask, reset }); answers like GET
 *
 * The account is always the session's. Signals come from the portal's own tables (machines,
 * API keys, GitHub, conversations, host requests) and the coordinators (balance); a lookup that
 * fails reads as null (unknown), never as done.
 */

import type { FastifyInstance } from "fastify";
import { fetchAccountBalances } from "../account-admin.js";
import { z } from "zod";
import {
  GOAL_IDS,
  NEW_ACCOUNT_DAYS,
  ROUTING_IDS,
  STEP_IDS,
  emptyOnboardingState,
  normalizeOnboardingState,
  shouldShowOnboarding,
  type OnboardingSignals,
  type OnboardingState,
  type StepId
} from "../../common/onboarding.js";

type User = { userId: string; email?: string; createdAtMs?: number };

export interface OnboardingStore {
  getOnboardingState(userId: string): Promise<unknown | null>;
  saveOnboardingState(userId: string, state: unknown, nowMs: number): Promise<void>;
  listNodesByOwner(userId: string): Promise<Array<{ nodeKind: string; active?: boolean; lastSeenMs?: number }>>;
  countApiKeys(userId: string): Promise<number>;
  getGitHubToken(userId: string): Promise<unknown | null>;
  listConversations(userId: string, limit?: number): Promise<unknown[]>;
  hasHostRequestFrom?(email: string): Promise<boolean>;
}

export interface OnboardingRouteDeps {
  store: OnboardingStore | null | undefined;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<User | null>;
  /** The account's cSats (null when no coordinator answered); defaults to asking the coordinators with `balances`. */
  balanceCSats?: (userId: string) => Promise<number | null>;
  balances?: Parameters<typeof fetchAccountBalances>[0];
  hostApproved: (email: string | undefined) => Promise<boolean>;
  now?: () => number;
}

/** A machine counts as online when it was seen in the last 10 minutes. */
export const MACHINE_ONLINE_MS = 10 * 60_000;

const stepId = z.enum(STEP_IDS as [StepId, ...StepId[]]);
export const onboardingPatchSchema = z
  .object({
    goal: z.enum(GOAL_IDS as [string, ...string[]]).nullable().optional(),
    current: stepId.optional(),
    done: z.array(stepId).max(STEP_IDS.length).optional(),
    skipped: z.array(stepId).max(STEP_IDS.length).optional(),
    routing: z.enum(ROUTING_IDS as [string, ...string[]]).nullable().optional(),
    dismissed: z.boolean().optional(),
    completed: z.boolean().optional(),
    firstTask: z.literal(true).optional(),
    reset: z.literal(true).optional()
  })
  .strict();
export type OnboardingPatch = z.infer<typeof onboardingPatchSchema>;

/** The saved state after a patch (pure). Seen once anything is saved. */
export function applyOnboardingPatch(prev: OnboardingState | null, patch: OnboardingPatch, nowMs: number): OnboardingState {
  if (patch.reset) return { ...emptyOnboardingState(nowMs), firstSeenAtMs: prev?.firstSeenAtMs ?? nowMs, firstTaskAtMs: prev?.firstTaskAtMs ?? null };
  const s: OnboardingState = prev ? { ...prev } : emptyOnboardingState(nowMs);
  if (patch.goal !== undefined) s.goal = (patch.goal as OnboardingState["goal"]) ?? null;
  if (patch.current !== undefined) s.current = patch.current;
  if (patch.done) s.done = STEP_IDS.filter((id) => patch.done!.includes(id));
  if (patch.skipped) s.skipped = STEP_IDS.filter((id) => patch.skipped!.includes(id));
  if (patch.routing !== undefined) s.routing = (patch.routing as OnboardingState["routing"]) ?? null;
  if (patch.dismissed !== undefined) s.dismissed = patch.dismissed;
  if (patch.completed !== undefined) s.completedAtMs = patch.completed ? s.completedAtMs ?? nowMs : null;
  if (patch.firstTask) s.firstTaskAtMs = s.firstTaskAtMs ?? nowMs;
  s.firstSeenAtMs = s.firstSeenAtMs ?? nowMs;
  s.updatedAtMs = nowMs;
  return s;
}

async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

/** The account's cSats from the coordinators; null when none answered. */
async function balanceOf(deps: OnboardingRouteDeps, userId: string): Promise<number | null> {
  if (deps.balanceCSats) return deps.balanceCSats(userId);
  if (!deps.balances) return null;
  const b = await fetchAccountBalances(deps.balances, userId);
  return b.coordinators.some((c) => c.ok) ? b.cSats : null;
}

export async function onboardingSignals(deps: OnboardingRouteDeps, user: User, nowMs: number): Promise<OnboardingSignals> {
  const store = deps.store!;
  const [nodes, balance, keys, github, conversations, approved, requested] = await Promise.all([
    orNull(store.listNodesByOwner(user.userId)),
    orNull(balanceOf(deps, user.userId)),
    orNull(store.countApiKeys(user.userId)),
    orNull(store.getGitHubToken(user.userId).then((t) => t !== null)),
    orNull(store.listConversations(user.userId, 1)),
    orNull(deps.hostApproved(user.email)),
    user.email && store.hasHostRequestFrom ? orNull(store.hasHostRequestFrom(user.email)) : Promise.resolve(null)
  ]);
  const agents = nodes ? nodes.filter((n) => n.nodeKind === "agent") : null;
  return {
    machines: agents ? agents.length : null,
    machinesOnline: agents ? agents.filter((n) => n.active !== false && typeof n.lastSeenMs === "number" && nowMs - n.lastSeenMs < MACHINE_ONLINE_MS).length : null,
    balanceCSats: balance,
    apiKeys: keys,
    github,
    firstTask: conversations ? conversations.length > 0 : null,
    hostApproved: approved,
    hostRequested: requested,
    newAccount: typeof user.createdAtMs === "number" ? nowMs - user.createdAtMs < NEW_ACCOUNT_DAYS * 86_400_000 : null,
    localModels: null,
    cliInstalled: null
  };
}

export function registerOnboardingRoutes(app: FastifyInstance, deps: OnboardingRouteDeps): void {
  const now = deps.now ?? Date.now;
  async function answer(user: User, state: OnboardingState | null) {
    const signals = await onboardingSignals(deps, user, now());
    return { state, signals, show: shouldShowOnboarding(state, signals) };
  }
  async function load(userId: string): Promise<OnboardingState | null> {
    const raw = await deps.store!.getOnboardingState(userId);
    return raw ? normalizeOnboardingState(raw, now()) : null;
  }

  app.get("/portal/api/onboarding", async (req, reply) => {
    const user = await deps.getCurrentUser(req as never);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    if (!deps.store) return reply.code(503).send({ error: "portal_database_not_configured" });
    return reply.send(await answer(user, await load(user.userId)));
  });

  app.post("/portal/api/onboarding", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = await deps.getCurrentUser(req as never);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    if (!deps.store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const parsed = onboardingPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_onboarding_state" });
    const nowMs = now();
    const next = applyOnboardingPatch(await load(user.userId), parsed.data, nowMs);
    await deps.store.saveOnboardingState(user.userId, next, nowMs);
    return reply.send(await answer(user, next));
  });
}
