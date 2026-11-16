// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Target profiles (scripts/stress/targets/*.json): where a run points and what it may do there.
 *
 * - `local`: the docker cluster from scripts/stress/up.sh. Direct Postgres and docker access are
 *   allowed (DB slowdown, coordinator kill, SQL invariants).
 * - `remote-local`: the same cluster reached by URL only, from inside the docker network, exactly
 *   as a load-generator VM would reach the live network. Proves the remote path end to end.
 * - `live-regtest`: the deployed regtest network. URLs only; no DB, no machine control; scenarios
 *   that would need either are refused before anything is sent.
 *
 * Credentials live in a separate file (path in the profile, or STRESS_CREDENTIALS) that is read,
 * never printed and never copied into results.
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export interface CoordinatorTarget {
  id: string;
  url: string;
  /** Docker container name (local only): what the coordinator-kill scenario stops and starts. */
  container?: string;
  /** Fly app name (live): printed in the operator commands, never called. */
  flyApp?: string;
}

export interface TargetProfile {
  name: string;
  kind: "local" | "remote";
  coordinators: CoordinatorTarget[];
  portalUrl: string;
  /** Path to the credentials file (relative to the profile file). STRESS_CREDENTIALS overrides it. */
  credentialsFile: string;
  /** Optional stack settings (earnings hold, payout caps) the invariant checker compares against. */
  settingsFile?: string;
  /** Scenario names this target accepts. */
  allowedScenarios: string[];
  /** Direct Postgres (SQL invariants, DB chaos). Remote targets: false. */
  allowDatabase: boolean;
  /** Local docker control (coordinator kill, DB pause). Remote targets: false. */
  allowDocker: boolean;
  /** May call operator endpoints that change shared state (payout pause/resume). */
  allowAdminWrites: boolean;
  /** Upper bounds the run refuses to exceed on this target. */
  limits: { maxAgents: number; maxBuyers: number; maxDurationSec: number; maxTopupSats: number };
  /** The simulated agents' model name for inference work (must parse a size: "<name>:<n>b"). */
  inferenceModel: string;
  /** TLS name of the payee LND REST endpoint when it is dialled by IP. */
  lndServername?: string;
  /** Live only: operator notes printed with scenarios that need manual steps. */
  operatorNotes?: string[];
}

export interface AccountCred {
  role: "provider" | "buyer";
  accountId: string;
  apiKey: string;
  email?: string;
  userId?: string;
}

export interface LndCred {
  restUrl: string;
  macaroonHex: string;
  tlsCertBase64: string;
}

export interface Credentials {
  accounts: AccountCred[];
  tokens?: { admin?: string; portalService?: string; mesh?: string; metrics?: string };
  lnd?: { payee?: LndCred; hub?: LndCred };
  postgresUrl?: string;
}

export interface Settings {
  earningsHoldMs?: number;
  payoutMinSats?: number;
  payoutMaxSingleSats?: number;
  payoutMaxAccountDailySats?: number;
  payoutMaxGlobalDailySats?: number;
  verificationRate?: number;
}

export interface LoadedTarget {
  profile: TargetProfile;
  creds: Credentials;
  settings: Settings;
  profilePath: string;
}

function resolveFrom(base: string, p: string): string {
  return isAbsolute(p) ? p : resolve(dirname(base), p);
}

export function validateProfile(p: TargetProfile): string[] {
  const errs: string[] = [];
  if (!p.name) errs.push("name is required");
  if (p.kind !== "local" && p.kind !== "remote") errs.push("kind must be local or remote");
  if (!Array.isArray(p.coordinators) || p.coordinators.length === 0) errs.push("at least one coordinator");
  for (const c of p.coordinators ?? []) if (!/^https?:\/\//.test(c.url)) errs.push(`coordinator ${c.id}: url must be http(s)`);
  if (!/^https?:\/\//.test(p.portalUrl ?? "")) errs.push("portalUrl must be http(s)");
  if (p.kind === "remote" && (p.allowDatabase || p.allowDocker)) errs.push("a remote target may not allow database or docker access");
  if (!/[:\-_]\d+(?:\.\d+)?b$/i.test(p.inferenceModel ?? "")) errs.push("inferenceModel must end in a size such as :1b");
  return errs;
}

export function loadTarget(profilePath: string, env: NodeJS.ProcessEnv = process.env): LoadedTarget {
  const abs = resolve(profilePath);
  const profile = JSON.parse(readFileSync(abs, "utf8")) as TargetProfile;
  const errs = validateProfile(profile);
  if (errs.length) throw new Error(`target ${abs}: ${errs.join("; ")}`);
  // URL overrides for running the same profile from another network position (e.g. inside docker).
  if (env.STRESS_PORTAL_URL) profile.portalUrl = env.STRESS_PORTAL_URL;
  if (env.STRESS_COORDINATOR_URLS) {
    const urls = env.STRESS_COORDINATOR_URLS.split(",").map((s) => s.trim()).filter(Boolean);
    profile.coordinators = urls.map((url, i) => ({ ...(profile.coordinators[i] ?? { id: `coord-${i}` }), url }));
  }
  const credPath = env.STRESS_CREDENTIALS ? resolve(env.STRESS_CREDENTIALS) : resolveFrom(abs, profile.credentialsFile);
  let creds: Credentials;
  try {
    creds = JSON.parse(readFileSync(credPath, "utf8")) as Credentials;
  } catch (err) {
    throw new Error(`cannot read credentials file ${credPath}: ${(err as Error).message}`);
  }
  if (!Array.isArray(creds.accounts) || creds.accounts.length === 0) throw new Error(`credentials ${credPath}: no accounts`);
  if (profile.kind === "remote") delete creds.postgresUrl; // a remote run never touches the database
  if (env.STRESS_PAYEE_LND_URL && creds.lnd?.payee) creds.lnd.payee.restUrl = env.STRESS_PAYEE_LND_URL;
  let settings: Settings = {};
  if (profile.settingsFile) {
    try {
      settings = JSON.parse(readFileSync(resolveFrom(abs, profile.settingsFile), "utf8")) as Settings;
    } catch {
      settings = {};
    }
  }
  return { profile, creds, settings, profilePath: abs };
}

export function providers(t: LoadedTarget): AccountCred[] {
  return t.creds.accounts.filter((a) => a.role === "provider");
}

export function buyers(t: LoadedTarget): AccountCred[] {
  return t.creds.accounts.filter((a) => a.role === "buyer");
}
