// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * `edgecoder-install update`: a headless host (Linux, or macOS installed with install.sh) moves
 * itself to the newest signed agent release, so nobody has to re-run the installer for a fix.
 *
 *   1. Find the newest published, non-prerelease agent-v* release (the GitHub API, as install.sh
 *      does). Nothing newer than the installed tag: done. Never a downgrade.
 *   2. Download its tarball, SHA256SUMS and SHA256SUMS.minisig over https into a root-owned 0700
 *      staging dir next to the app, and check them with release-verify.ts against the key pinned in
 *      release-key.ts (never one fetched with the release) before anything is unpacked.
 *   3. Unpack, check the tarball is that tag and this OS/arch, make it root-owned and not writable
 *      by others, and ask it (`plan --keep-config --json`) whether it would run the same agents:
 *      if not, stop and leave the host to a person.
 *   4. Wait for the agents to be idle: SIGUSR2 makes each stop taking new work (update-drain.ts)
 *      and running work finish, for up to 10 minutes; still busy, SIGHUP resumes them and the
 *      update waits for the next run.
 *   5. Swap: <app> -> <app>.prev, staged -> <app>; run the new `apply --from-package --keep-config`
 *      (same env files, ids, tokens, engines, tuning, model and host controls), which restarts the
 *      services.
 *   6. Health: every agent service active, and each agent that was registered before registers
 *      again (its agent-status.json), within the health timeout. Otherwise roll back: swap
 *      <app>.prev back, re-apply it, and remember the failed tag so the timer does not retry it.
 * Scheduled runs come from the hourly timer, or early from an agent's nudge (update-schedule.ts):
 * they do nothing within MIN_SCHEDULED_GAP_MS of the last check or before a GitHub rate limit resets.
 * One previous version is kept (<app>.prev). The result goes to the state file, which `status`
 * shows. Everything that touches the host goes through UpdateDeps so the flow is unit-tested.
 */
import type { BinFs } from "./binaries.js";
import { nonRootWritable } from "./binaries.js";
import { parseEnvFile } from "./engine.js";
import { RELEASE_PUBKEY } from "./release-key.js";
import { verifyRelease, type VerifyResult } from "./release-verify.js";
import { AUTO_UPDATE_ENV_FILE, autoUpdateSetting } from "./update-schedule.js";

export const RELEASE_REPO = "codyrs82/Edgecoder";
export const RELEASE_API_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=100`;
export const RELEASE_BASE_URL = `https://github.com/${RELEASE_REPO}/releases/download`;
export const UPDATE_STATE_FILE = "update-state.json";
export const RELEASE_INFO_FILE = "edgecoder-release.json";
export const STAGE_PREFIX = ".edgecoder-update-";

export const IDLE_TIMEOUT_MS = 10 * 60_000;
export const HEALTH_TIMEOUT_MS = 3 * 60_000;
const POLL_MS = 10_000;
/**
 * Scheduled runs closer together than this do nothing (no GitHub call): an agent's nudge
 * (update-nudge.ts, the update-request path unit / WatchPaths) can start a run any time, so this
 * caps a host at 12 extra checks an hour even if an agent pokes nonstop. Not written to the state
 * file, so pokes cannot push the next real check away.
 */
export const MIN_SCHEDULED_GAP_MS = 5 * 60_000;
/** After GitHub says 403/429 (rate limit), scheduled runs wait at least this long, at most RATE_LIMIT_MAX_WAIT_MS. */
export const RATE_LIMIT_MIN_WAIT_MS = 15 * 60_000;
export const RATE_LIMIT_MAX_WAIT_MS = 6 * 3600_000;
const RATE_LIMIT_DEFAULT_WAIT_MS = 3600_000;
/** A status file older than this says nothing about the agent now. */
const STATUS_FRESH_MS = 2 * 60_000;

// ───────────────────────────── versions ─────────────────────────────
/**
 * Largest agent tarball the updater downloads (2 GiB). Plain arithmetic, not `2 << 30`: JavaScript
 * shifts are 32-bit signed, so `2 << 30` is -2147483648 and every download was "too large" (1.2.2).
 */
export const MAX_TARBALL_BYTES = 2 * 1024 ** 3;

const TAG_RE = /^agent-v(\d+)\.(\d+)\.(\d+)$/;

/** [major, minor, patch] of a release tag (agent-v1.2.3) or version (1.2.3); null for anything else (prereleases included). */
export function parseVersion(v: string): [number, number, number] | null {
  const m = TAG_RE.exec(v.startsWith("agent-v") ? v : `agent-v${v}`);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number];
  return parts.every((n) => Number.isSafeInteger(n)) ? parts : null;
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a release version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** The newest published, non-draft, non-prerelease agent-vX.Y.Z tag in a GitHub releases listing. */
export function pickLatestTag(listing: unknown): string | null {
  if (!Array.isArray(listing)) return null;
  const tags = listing
    .filter((r): r is { tag_name: string; draft?: boolean; prerelease?: boolean } => !!r && typeof r === "object" && typeof (r as { tag_name?: unknown }).tag_name === "string")
    .filter((r) => !r.draft && !r.prerelease && TAG_RE.test(r.tag_name))
    .map((r) => r.tag_name)
    .sort((a, b) => compareVersions(b, a));
  return tags[0] ?? null;
}

/** The release asset target for this machine; null where there is no agent tarball. */
export function releaseTarget(platform: NodeJS.Platform, arch: string): string | null {
  const os = platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : platform === "win32" ? "win" : null;
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
  if (!os || !cpu || (os === "win" && cpu !== "x64")) return null;
  return `${os}-${cpu}`;
}

export interface ReleaseInfo {
  tag: string;
  target: string;
}

/** edgecoder-release.json of a release install; null for a package or source install. */
export function parseReleaseInfo(text: string | undefined): ReleaseInfo | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text) as { tag?: unknown; target?: unknown };
    if (typeof j.tag !== "string" || !TAG_RE.test(j.tag) || typeof j.target !== "string" || !/^[a-z]+-[a-z0-9]+$/.test(j.target)) return null;
    return { tag: j.tag, target: j.target };
  } catch {
    return null;
  }
}

/** A non-200 answer, with when the server said to come back (rate limits). */
export class HttpStatusError extends Error {
  constructor(message: string, readonly status: number, readonly retryAtMs?: number) {
    super(message);
    this.name = "HttpStatusError";
  }
}

/**
 * When to come back after a GitHub 403/429 (unauthenticated: 60 requests an hour per IP): its
 * retry-after (seconds) or x-ratelimit-reset (epoch seconds), else an hour; clamped so a wrong
 * clock or header neither hammers the API nor stops updates for long. Undefined: not a rate limit.
 */
export function rateLimitRetryAt(status: number, headers: { get(name: string): string | null }, nowMs: number): number | undefined {
  if (status !== 403 && status !== 429) return undefined;
  const after = Number(headers.get("retry-after"));
  const reset = Number(headers.get("x-ratelimit-reset"));
  const at = Number.isFinite(after) && after > 0 ? nowMs + after * 1000 : Number.isFinite(reset) && reset > 0 ? reset * 1000 : nowMs + RATE_LIMIT_DEFAULT_WAIT_MS;
  return Math.min(Math.max(at, nowMs + RATE_LIMIT_MIN_WAIT_MS), nowMs + RATE_LIMIT_MAX_WAIT_MS);
}

// ───────────────────────────── state ─────────────────────────────
export type UpdateResultKind = "up-to-date" | "available" | "updated" | "rolled-back" | "skipped-busy" | "skipped" | "disabled" | "failed";

export interface UpdateState {
  lastCheckAt: string;
  lastResult: UpdateResultKind;
  message: string;
  installedTag?: string;
  latestTag?: string;
  previousTag?: string;
  /** A tag that failed its health check: scheduled runs skip it, `update` by hand tries it again. */
  failedTag?: string;
  /** GitHub rate-limited the last check: scheduled runs make no call before this (ISO time). */
  rateLimitedUntil?: string;
}

export function parseUpdateState(text: string | undefined): UpdateState | null {
  if (!text) return null;
  try {
    const s = JSON.parse(text) as UpdateState;
    return typeof s.lastCheckAt === "string" && typeof s.lastResult === "string" ? s : null;
  } catch {
    return null;
  }
}

// ───────────────────────────── host access ─────────────────────────────
export interface AgentStatus {
  pid: number;
  version: string;
  startedAtMs: number;
  updatedAtMs: number;
  registered: boolean;
  draining: boolean;
  busy: number;
  drainSignal?: string;
}

export interface UpdateDeps {
  platform: NodeJS.Platform;
  arch: string;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  /** GET over https only (redirects included), at most maxBytes; throws on anything else. */
  fetchBytes(url: string, maxBytes: number): Promise<Buffer>;
  /** The same, streamed into `dest` (created exclusively, mode 0600). */
  fetchToFile(url: string, dest: string, maxBytes: number): Promise<void>;
  /** No shell: argv only. */
  run(cmd: string, args: string[], env?: Record<string, string>): { code: number; stdout: string; stderr: string };
  readText(path: string): string | undefined;
  /** Replace a root-owned file (writeFileFresh). */
  writeText(path: string, text: string, mode: number): void;
  exists(path: string): boolean;
  listDir(path: string): string[];
  rename(from: string, to: string): void;
  removeTree(path: string): void;
  /** mkdtemp: a new directory, mode 0700, owned by the caller (root). */
  makeTempDir(prefix: string): string;
  /** agent-status.json of instance n, read without following links or blocking; null when absent or invalid. */
  readAgentStatus(n: number): AgentStatus | null;
  binFs: BinFs;
  isRoot: boolean;
}

export interface UpdatePaths {
  appDir: string;
  configDir: string;
  nodeBin: string;
}

export interface UpdateOptions {
  check: boolean;
  /** The timer's run: honours the opt-out and skips a tag that already failed. */
  scheduled: boolean;
  /** Spread scheduled runs (launchd has no RandomizedDelaySec): sleep up to this many seconds first. */
  jitterSec?: number;
  idleTimeoutMs?: number;
  healthTimeoutMs?: number;
  /** Tests only: a key other than the pinned one. The CLI never sets it. */
  pubkey?: string;
  apiUrl?: string;
  baseUrl?: string;
}

export interface UpdateOutcome {
  result: UpdateResultKind;
  message: string;
  installedTag?: string;
  latestTag?: string;
  /** Process exit code: 0 for a run that did what it should (including "busy, later"), 1 for a failure. */
  code: number;
}

const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");
const dirOf = (p: string) => p.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";

/** Indices of the agent instances this host runs (agent-<n>.env in the config dir). */
export function installedInstances(deps: Pick<UpdateDeps, "listDir">, configDir: string): number[] {
  let names: string[] = [];
  try {
    names = deps.listDir(configDir);
  } catch {
    return [];
  }
  return names.map((n) => /^agent-(\d{1,2})\.env$/.exec(n)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1])).sort((a, b) => a - b);
}

function agentUnit(platform: NodeJS.Platform, n: number): string {
  return platform === "darwin" ? `system/io.edgecoder.agent.${n}` : `edgecoder-agent-${n}.service`;
}

export function agentActive(deps: Pick<UpdateDeps, "platform" | "run">, n: number): boolean {
  if (deps.platform === "darwin") {
    const r = deps.run("launchctl", ["print", agentUnit("darwin", n)]);
    return r.code === 0 && /\bstate = running\b/.test(r.stdout);
  }
  return deps.run("systemctl", ["is-active", agentUnit("linux", n)]).stdout.trim() === "active";
}

function signalAgent(deps: Pick<UpdateDeps, "platform" | "run">, n: number, signal: "SIGUSR2" | "SIGHUP"): boolean {
  const r = deps.platform === "darwin"
    ? deps.run("launchctl", ["kill", signal, agentUnit("darwin", n)])
    : deps.run("systemctl", ["kill", "--kill-whom=main", `--signal=${signal}`, agentUnit("linux", n)]);
  return r.code === 0;
}

/** An agent that can be asked to drain: running, with a fresh status file that names the drain signal. */
function drainable(deps: UpdateDeps, n: number): AgentStatus | null {
  const s = deps.readAgentStatus(n);
  if (!s || s.drainSignal !== "SIGUSR2" || deps.now() - s.updatedAtMs > STATUS_FRESH_MS) return null;
  return s;
}

/**
 * Ask every running agent to stop taking work and wait until none has any running, up to
 * `timeoutMs`. True: idle (restart now). False: still busy; the drain has been ended.
 * An agent that is not running has nothing to interrupt; one without a status file (it predates
 * the drain, or cannot write it) cannot be asked and is restarted as before (its claims are handed
 * back on SIGTERM).
 */
export async function waitForIdle(deps: UpdateDeps, instances: number[], timeoutMs: number): Promise<boolean> {
  const asked: number[] = [];
  for (const n of instances) {
    if (!agentActive(deps, n)) continue;
    if (!drainable(deps, n)) {
      deps.log(`agent ${n}: no current agent-status.json; it cannot be asked to finish its work first`);
      continue;
    }
    if (signalAgent(deps, n, "SIGUSR2")) asked.push(n);
  }
  if (asked.length === 0) return true;
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    const busy = asked.filter((n) => {
      if (!agentActive(deps, n)) return false;
      const s = deps.readAgentStatus(n);
      // Stale or unreadable while the service runs: unknown, so not idle yet.
      return !s || deps.now() - s.updatedAtMs > STATUS_FRESH_MS || s.busy > 0;
    });
    if (busy.length === 0) return true;
    if (deps.now() >= deadline) {
      for (const n of asked) signalAgent(deps, n, "SIGHUP");
      deps.log(`agents ${busy.join(", ")} still busy after ${Math.round(timeoutMs / 60_000)} min; they take work again and the update waits for the next run`);
      return false;
    }
    await deps.sleep(POLL_MS);
  }
}

/**
 * After the services were restarted at `sinceMs`: every agent service active, and each agent in
 * `mustRegister` has written a status file from a process started after `sinceMs` that says it is
 * registered. Polls until `timeoutMs`; returns the problems (empty: healthy).
 */
export async function checkHealth(deps: UpdateDeps, instances: number[], mustRegister: Set<number>, sinceMs: number, timeoutMs: number): Promise<string[]> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    const problems: string[] = [];
    for (const n of instances) {
      if (!agentActive(deps, n)) {
        problems.push(`agent ${n} is not running`);
        continue;
      }
      if (!mustRegister.has(n)) continue;
      const s = deps.readAgentStatus(n);
      if (!s || s.startedAtMs < sinceMs) problems.push(`agent ${n} has not reported since the restart`);
      else if (!s.registered) problems.push(`agent ${n} has not registered with its coordinator`);
    }
    if (problems.length === 0) return [];
    if (deps.now() >= deadline) return problems;
    await deps.sleep(Math.min(POLL_MS, Math.max(1, deadline - deps.now())));
  }
}

/** The agent ids a plan would run (plan --json output), or null when it cannot be read. */
export function plannedAgentIds(planJson: string): string[] | null {
  try {
    const j = JSON.parse(planJson) as { plan?: { instances?: Array<{ index?: unknown; agentId?: unknown }> } };
    const inst = j.plan?.instances;
    if (!Array.isArray(inst)) return null;
    return inst.map((i) => `${String(i.index)}:${String(i.agentId)}`);
  } catch {
    return null;
  }
}

/** The agent ids the host runs now, from its env files, in the same form. */
export function currentAgentIds(deps: Pick<UpdateDeps, "readText">, configDir: string, instances: number[]): string[] {
  return instances.map((n) => `${n}:${parseEnvFile(deps.readText(join(configDir, `agent-${n}.env`)) ?? "").AGENT_ID ?? ""}`);
}

// ───────────────────────────── the update ─────────────────────────────
export async function runUpdate(opts: UpdateOptions, p: UpdatePaths, deps: UpdateDeps): Promise<UpdateOutcome> {
  const statePath = join(p.configDir, UPDATE_STATE_FILE);
  const previous = parseUpdateState(deps.readText(statePath));
  const save = (o: UpdateOutcome, extra: Partial<UpdateState> = {}): UpdateOutcome => {
    deps.log(`edgecoder-update: ${o.result}: ${o.message}`);
    if (opts.check || !deps.isRoot) return o;
    const state: UpdateState = {
      lastCheckAt: new Date(deps.now()).toISOString(),
      lastResult: o.result,
      message: o.message,
      ...(o.installedTag ? { installedTag: o.installedTag } : {}),
      ...(o.latestTag ? { latestTag: o.latestTag } : {}),
      ...(previous?.failedTag && o.result !== "updated" ? { failedTag: previous.failedTag } : {}),
      ...extra
    };
    try {
      deps.writeText(statePath, JSON.stringify(state, null, 2) + "\n", 0o644);
    } catch (e) {
      deps.log(`could not write ${statePath}: ${(e as Error).message}`);
    }
    return o;
  };

  if (deps.platform !== "linux" && deps.platform !== "darwin") {
    return save({ result: "skipped", message: "automatic updates are not supported on this platform yet; re-run install.ps1 to update", code: 1 });
  }
  if (!opts.check && !deps.isRoot) return save({ result: "failed", message: "run as root: sudo edgecoder-install update", code: 1 });
  if (opts.scheduled) {
    const setting = autoUpdateSetting(deps.readText, deps.listDir, p.configDir);
    if (!setting.enabled) return save({ result: "disabled", message: `automatic updates are off (${setting.source}); run sudo edgecoder-install update to update by hand`, code: 0 });
    // Throttles: neither is saved, so they never move the next real check.
    const limitedUntil = Date.parse(previous?.rateLimitedUntil ?? "");
    if (limitedUntil > deps.now()) {
      deps.log(`edgecoder-update: skipped: GitHub rate-limited the last check; next check after ${previous!.rateLimitedUntil}`);
      return { result: "skipped", message: `rate-limited until ${previous!.rateLimitedUntil}`, code: 0 };
    }
    const last = Date.parse(previous?.lastCheckAt ?? "");
    if (last <= deps.now() && deps.now() - last < MIN_SCHEDULED_GAP_MS) {
      deps.log(`edgecoder-update: skipped: checked at ${previous!.lastCheckAt}, less than ${MIN_SCHEDULED_GAP_MS / 60_000} minutes ago`);
      return { result: "skipped", message: `checked less than ${MIN_SCHEDULED_GAP_MS / 60_000} minutes ago`, code: 0 };
    }
  }

  // A crash between the two renames of a swap left no app dir: put the previous one back first.
  const prevDir = `${p.appDir}.prev`;
  if (!opts.check && !deps.exists(p.appDir) && deps.exists(prevDir)) {
    deps.rename(prevDir, p.appDir);
    deps.log(`restored ${p.appDir} from ${prevDir} (an earlier update stopped half way)`);
  }
  const installed = parseReleaseInfo(deps.readText(join(p.appDir, RELEASE_INFO_FILE)));
  if (!installed) {
    return save({ result: "skipped", message: `${p.appDir} is not a signed release install (a .deb/.pkg package or --from-source); update it the way it was installed`, code: 1 });
  }
  const target = releaseTarget(deps.platform, deps.arch);
  if (!target || target !== installed.target) {
    return save({ result: "failed", message: `this machine is ${target ?? `${deps.platform}-${deps.arch}`}, the installed release is for ${installed.target}`, installedTag: installed.tag, code: 1 });
  }

  // 1. The newest release.
  let latest: string | null;
  try {
    latest = pickLatestTag(JSON.parse((await deps.fetchBytes(opts.apiUrl ?? RELEASE_API_URL, 8 << 20)).toString("utf8")));
  } catch (e) {
    const retryAtMs = e instanceof HttpStatusError ? e.retryAtMs : undefined;
    if (retryAtMs !== undefined) {
      const until = new Date(retryAtMs).toISOString();
      return save({ result: "failed", message: `could not list releases: ${(e as Error).message} (rate-limited; scheduled checks wait until ${until})`, installedTag: installed.tag, code: 1 }, { rateLimitedUntil: until });
    }
    return save({ result: "failed", message: `could not list releases: ${(e as Error).message}`, installedTag: installed.tag, code: 1 });
  }
  if (!latest) return save({ result: "failed", message: "no agent-v* release found", installedTag: installed.tag, code: 1 });
  const base = { installedTag: installed.tag, latestTag: latest };
  if (compareVersions(latest, installed.tag) <= 0) {
    // Equal, or the listing shows nothing newer (never a downgrade, even if the listing is rolled back).
    return save({ ...base, result: "up-to-date", message: `${installed.tag} is the newest release${compareVersions(latest, installed.tag) < 0 ? ` (the listing's newest is ${latest}; not downgrading)` : ""}`, code: 0 });
  }
  if (opts.check) return save({ ...base, result: "available", message: `${latest} is available (installed ${installed.tag}); run sudo edgecoder-install update`, code: 0 });
  if (opts.scheduled && previous?.failedTag === latest) {
    return save({ ...base, result: "skipped", message: `${latest} failed its health check here before and was rolled back; run sudo edgecoder-install update to try it again`, code: 0 });
  }
  if (opts.scheduled && opts.jitterSec && opts.jitterSec > 0) await deps.sleep(Math.floor(Math.random() * opts.jitterSec * 1000));

  // 2. Download into a root-only staging dir beside the app (same filesystem: the swap is a rename).
  const parent = dirOf(p.appDir);
  const unsafe = nonRootWritable(deps.binFs, parent);
  if (unsafe) return save({ ...base, result: "failed", message: `refusing to stage an update under ${parent}: ${unsafe}`, code: 1 });
  for (const name of safeList(deps, parent)) if (name.startsWith(STAGE_PREFIX)) deps.removeTree(join(parent, name));
  const stage = deps.makeTempDir(join(parent, STAGE_PREFIX));
  try {
    const asset = `edgecoder-agent-${latest}-${target}.tar.gz`;
    const releaseBase = `${opts.baseUrl ?? RELEASE_BASE_URL}/${latest}`;
    let verified: VerifyResult;
    try {
      const sums = await deps.fetchBytes(`${releaseBase}/SHA256SUMS`, 64 << 10);
      const sig = (await deps.fetchBytes(`${releaseBase}/SHA256SUMS.minisig`, 4 << 10)).toString("utf8");
      await deps.fetchToFile(`${releaseBase}/${asset}`, join(stage, asset), MAX_TARBALL_BYTES);
      verified = verifyRelease(opts.pubkey ?? RELEASE_PUBKEY, sums, sig, join(stage, asset), latest);
    } catch (e) {
      return save({ ...base, result: "failed", message: `download of ${latest} failed: ${(e as Error).message}`, code: 1 });
    }
    if (!verified.ok) return save({ ...base, result: "failed", message: `${latest} did not verify: ${verified.message}`, code: 1 });
    deps.log(verified.message);

    // 3. Unpack only now; check it is what was signed for; root-owned.
    const x = join(stage, "x");
    deps.run("mkdir", ["-m", "0700", x]);
    const untar = deps.run("tar", ["-xzf", join(stage, asset), "-C", x, "--no-same-owner"]);
    const app = join(x, "edgecoder");
    const info = parseReleaseInfo(deps.readText(join(app, RELEASE_INFO_FILE)));
    if (untar.code !== 0 || !deps.exists(join(app, "dist", "install", "cli.js")) || !info || info.tag !== latest || info.target !== target) {
      return save({ ...base, result: "failed", message: `${asset} is not a usable ${latest} ${target} release${untar.code !== 0 ? ` (tar: ${untar.stderr.trim()})` : ""}`, code: 1 });
    }
    try {
      deps.binFs.secure(app);
    } catch (e) {
      return save({ ...base, result: "failed", message: `could not make ${app} root-owned: ${(e as Error).message}`, code: 1 });
    }

    const instances = installedInstances(deps, p.configDir);
    // Would the new version run the same agents? (A changed layout or naming is for a person to apply.)
    const plan = deps.run(p.nodeBin, [join(app, "dist", "install", "cli.js"), "plan", "--json", "--keep-config", "--from-package", "--app-dir", p.appDir, "--config-dir", p.configDir]);
    const planned = plan.code === 0 ? plannedAgentIds(plan.stdout) : null;
    const current = currentAgentIds(deps, p.configDir, instances);
    if (!planned || planned.join(",") !== current.join(",")) {
      return save({ ...base, result: "skipped", message: `${latest} would change this host's agents (${current.join(" ") || "none"} -> ${planned?.join(" ") ?? `plan failed: ${plan.stderr.trim().slice(0, 300)}`}); run sudo edgecoder-install update by hand after checking sudo edgecoder-install plan`, code: 1 });
    }

    // 4. Idle first.
    const wasRegistered = new Set(instances.filter((n) => deps.readAgentStatus(n)?.registered));
    if (!(await waitForIdle(deps, instances, opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS))) {
      return save({ ...base, result: "skipped-busy", message: `${latest} is ready but the agents were busy; trying again on the next run`, code: 0 });
    }

    // 5. Swap and apply.
    if (deps.exists(prevDir)) deps.removeTree(prevDir);
    deps.rename(p.appDir, prevDir);
    deps.rename(app, p.appDir);
    const restartedAt = deps.now();
    const applied = applyApp(deps, p);
    // 6. Health, else roll back.
    const problems = applied.code === 0 ? await checkHealth(deps, instances, wasRegistered, restartedAt, opts.healthTimeoutMs ?? HEALTH_TIMEOUT_MS) : [`apply failed (exit ${applied.code}): ${applied.stderr.trim().slice(-500)}`];
    if (problems.length === 0) {
      return save({ ...base, installedTag: latest, result: "updated", message: `updated ${installed.tag} -> ${latest} (signature verified, agents healthy); ${installed.tag} kept in ${prevDir}`, code: 0 }, { previousTag: installed.tag });
    }
    const failedDir = `${p.appDir}.failed`;
    if (deps.exists(failedDir)) deps.removeTree(failedDir);
    deps.rename(p.appDir, failedDir);
    deps.rename(prevDir, p.appDir);
    const back = applyApp(deps, p);
    deps.removeTree(failedDir);
    return save({
      ...base,
      result: "rolled-back",
      message: `${latest} was unhealthy (${problems.join("; ")}); rolled back to ${installed.tag}${back.code === 0 ? "" : ` but re-applying it failed (exit ${back.code}); run sudo edgecoder-install apply`}`,
      code: 1
    }, { failedTag: latest });
  } finally {
    deps.removeTree(stage);
  }
}

function safeList(deps: UpdateDeps, dir: string): string[] {
  try {
    return deps.listDir(dir);
  } catch {
    return [];
  }
}

/** The app now in place re-applies the host's own config and restarts the services. */
function applyApp(deps: UpdateDeps, p: UpdatePaths) {
  const r = deps.run(p.nodeBin, [join(p.appDir, "dist", "install", "cli.js"), "apply", "--from-package", "--keep-config", "--app-dir", p.appDir, "--config-dir", p.configDir], { EDGECODER_UPDATE_RUN: "1" });
  for (const line of r.stdout.split("\n").filter(Boolean).slice(-20)) deps.log(`  ${line}`);
  return r;
}

/** Lines for `edgecoder-install status`. */
export function updateStatusLines(read: (path: string) => string | undefined, listDir: (dir: string) => string[], p: Pick<UpdatePaths, "appDir" | "configDir">, timer: string | null): string[] {
  const info = parseReleaseInfo(read(join(p.appDir, RELEASE_INFO_FILE)));
  const setting = autoUpdateSetting(read, listDir, p.configDir);
  const state = parseUpdateState(read(join(p.configDir, UPDATE_STATE_FILE)));
  const lines = [
    info ? `version: ${info.tag.replace(/^agent-v/, "")} (${info.tag}, ${info.target})` : `version: ${p.appDir} is not a signed release install (package or source): no automatic updates`,
    `auto-update: ${!info ? "n/a" : setting.enabled ? "on" : "off"}${info ? ` (${setting.source})` : ""}${timer ? `, ${timer}` : ""}`
  ];
  if (state) {
    lines.push(`last update check: ${state.lastCheckAt}: ${state.lastResult}: ${state.message}`);
    if (state.failedTag) lines.push(`skipped by the timer: ${state.failedTag} (failed its health check; sudo edgecoder-install update tries it again)`);
  } else if (info) {
    lines.push("last update check: never");
  }
  return lines;
}

export { AUTO_UPDATE_ENV_FILE };
