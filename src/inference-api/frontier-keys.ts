// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Frontier keys on this computer (docs/frontier-keys.md): the user's own API keys for Anthropic and
 * OpenAI-compatible providers, and the local settings that go with them (default lead, worker,
 * spend caps, prices).
 *
 * - The secret lives in the OS credential store: the macOS keychain (`security`), the Secret
 *   Service on Linux (`secret-tool`), the Windows Credential Locker (PowerShell PasswordVault).
 *   Only when none is available, or EDGECODER_FRONTIER_KEYCHAIN=off, does it go to a 0600 file
 *   (~/.edgecoder/frontier-keys.json), and the listing says so.
 * - A secret is never passed on a command line (it would show in `ps`): it goes to the tool on stdin.
 * - Each key is bound to the EdgeCoder account that added it. It is usable only while that same
 *   account is signed in on this computer; another account's keys are listed as belonging to
 *   another account and can be removed, not used.
 * - Nothing here talks to the network or to EdgeCoder's servers.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { DEFAULT_LEAD_MODEL, PROVIDER_ID_RE, isFrontierModelId, type FrontierKind, type Price } from "./frontier-models.js";

export const KEYCHAIN_SERVICE = "edgecoder-frontier";

/** Characters a provider key may contain (every major provider's keys fit; quotes and spaces never do). */
const KEY_RE = /^[A-Za-z0-9._~+/=:-]{8,512}$/;
const ACCOUNT_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

export class FrontierKeyError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// --- Credential stores ---

export interface Keychain {
  /** "macOS keychain", "Secret Service", "Windows Credential Locker", "file". */
  readonly name: string;
  set(account: string, secret: string): Promise<void>;
  get(account: string): Promise<string | null>;
  remove(account: string): Promise<void>;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a tool with `input` on stdin (never in argv). */
function run(bin: string, args: string[], input = "", timeoutMs = 15_000): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: (err as Error).message });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/** Tool output in an error message, with anything key-like removed. */
const safeErr = (s: string) => s.replace(/[A-Za-z0-9._~+/=:-]{24,}/g, "[redacted]").trim().slice(0, 200);

/** macOS: the login keychain through /usr/bin/security (`-i` reads the command, secret included, from stdin). */
export function macKeychain(bin = "/usr/bin/security"): Keychain {
  return {
    name: "macOS keychain",
    async set(account, secret) {
      const r = await run(bin, ["-i"], `add-generic-password -U -a "${account}" -s "${KEYCHAIN_SERVICE}" -l "EdgeCoder frontier key" -w "${secret}"\n`);
      if (r.code !== 0 || /error|fail/i.test(r.stderr)) throw new FrontierKeyError(`Couldn't save the key in the macOS keychain: ${safeErr(r.stderr) || `exit ${r.code}`}`, 500);
    },
    async get(account) {
      const r = await run(bin, ["find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-w"]);
      if (r.code !== 0) return null;
      return r.stdout.replace(/\r?\n$/, "") || null;
    },
    async remove(account) {
      await run(bin, ["delete-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE]);
    },
  };
}

/** Linux: the Secret Service (GNOME Keyring, KWallet) through `secret-tool`; `store` reads the secret from stdin. */
export function secretToolKeychain(bin = "secret-tool"): Keychain {
  return {
    name: "Secret Service",
    async set(account, secret) {
      const r = await run(bin, ["store", "--label=EdgeCoder frontier key", "service", KEYCHAIN_SERVICE, "account", account], secret);
      if (r.code !== 0) throw new FrontierKeyError(`Couldn't save the key with secret-tool (is a keyring unlocked?): ${safeErr(r.stderr) || `exit ${r.code}`}. Set EDGECODER_FRONTIER_KEYCHAIN=off to keep it in a 0600 file instead.`, 500);
    },
    async get(account) {
      const r = await run(bin, ["lookup", "service", KEYCHAIN_SERVICE, "account", account]);
      if (r.code !== 0) return null;
      return r.stdout.replace(/\r?\n$/, "") || null;
    },
    async remove(account) {
      await run(bin, ["clear", "service", KEYCHAIN_SERVICE, "account", account]);
    },
  };
}

/** Windows: the Credential Locker (PasswordVault) through PowerShell; the script, secret included, goes on stdin. */
export function windowsKeychain(bin = "powershell.exe"): Keychain {
  const vault = "$ErrorActionPreference='Stop'; [void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; $v = New-Object Windows.Security.Credentials.PasswordVault;";
  const ps = (script: string) => run(bin, ["-NoProfile", "-NonInteractive", "-Command", "-"], `${vault} ${script}\n`);
  return {
    name: "Windows Credential Locker",
    async set(account, secret) {
      await ps(`try { $v.Remove($v.Retrieve('${KEYCHAIN_SERVICE}','${account}')) } catch {}`);
      const r = await ps(`$v.Add((New-Object Windows.Security.Credentials.PasswordCredential('${KEYCHAIN_SERVICE}','${account}','${secret}')))`);
      if (r.code !== 0) throw new FrontierKeyError(`Couldn't save the key in the Credential Locker: ${safeErr(r.stderr) || `exit ${r.code}`}`, 500);
    },
    async get(account) {
      const r = await ps(`$c = $v.Retrieve('${KEYCHAIN_SERVICE}','${account}'); $c.RetrievePassword(); [Console]::Out.Write($c.Password)`);
      return r.code === 0 && r.stdout ? r.stdout.trim() : null;
    },
    async remove(account) {
      await ps(`$v.Remove($v.Retrieve('${KEYCHAIN_SERVICE}','${account}'))`);
    },
  };
}

/** The fallback: one JSON file, 0600, in a 0700 folder. */
export function fileKeychain(file: string): Keychain {
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const write = (data: Record<string, string>) => writePrivate(file, JSON.stringify(data));
  return {
    name: "file",
    async set(account, secret) {
      write({ ...read(), [account]: secret });
    },
    async get(account) {
      return read()[account] ?? null;
    },
    async remove(account) {
      const data = read();
      delete data[account];
      write(data);
    },
  };
}

function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  if (name.includes("/") || name.includes("\\")) return existsSync(name);
  for (const dir of (env.PATH ?? "").split(delimiter)) if (dir && existsSync(join(dir, name))) return true;
  return false;
}

export function defaultFrontierFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.EDGECODER_FRONTIER_FILE || join(homedir(), ".edgecoder", "frontier.json");
}

/** This computer's credential store, or the 0600 file (`fallback: true`) when there is none or it is turned off. */
export function detectKeychain(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { keychain: Keychain; fallback: boolean } {
  const file = join(dirname(defaultFrontierFile(env)), "frontier-keys.json");
  if ((env.EDGECODER_FRONTIER_KEYCHAIN ?? "").toLowerCase() === "off") return { keychain: fileKeychain(file), fallback: true };
  if (platform === "darwin") {
    const bin = env.EDGECODER_SECURITY_BIN || "/usr/bin/security";
    if (existsSync(bin)) return { keychain: macKeychain(bin), fallback: false };
  } else if (platform === "win32") {
    return { keychain: windowsKeychain(env.EDGECODER_POWERSHELL_BIN || "powershell.exe"), fallback: false };
  } else {
    const bin = env.EDGECODER_SECRET_TOOL_BIN || "secret-tool";
    if (onPath(bin, env)) return { keychain: secretToolKeychain(bin), fallback: false };
  }
  return { keychain: fileKeychain(file), fallback: true };
}

function writePrivate(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // no POSIX modes (Windows)
  }
}

// --- Providers and settings (no secrets) ---

export interface FrontierProvider {
  id: string;
  kind: FrontierKind;
  /** OpenAI-compatible: the API base (`https://api.openai.com/v1`); Anthropic: only to point at a test server. */
  baseUrl?: string;
  /** The EdgeCoder account (`acct-...`) that added the key; only that account can use it. */
  accountId: string;
  /** Where the secret is: the OS credential store, or the 0600 file. */
  storage: "keychain" | "file";
  addedAt: number;
  /** Models seen when the key was tested (OpenAI-compatible: what /v1/models lists). */
  models?: string[];
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface FrontierSettings {
  /** The lead model new sessions offer (`frontier/<provider>/<model>`). */
  defaultLead: string;
  /** Tentacle/default model: helpers, compaction and delegated work (default `auto`, on the network). */
  workerModel: string;
  /** USD; null = no cap. */
  sessionCapUsd: number | null;
  dailyCapUsd: number | null;
  /** Auto may pick the frontier lead for high-complexity jobs (default off). */
  useForAuto: boolean;
  /** Compaction summaries run on the frontier lead instead of the worker (default off). */
  compactWithLead: boolean;
  /** Anthropic `output_config.effort` for the lead. */
  effort: Effort;
  /** USD per million tokens by `<provider>/<model>` or `<model>`, over the built-in table. */
  prices: Record<string, Price>;
}

export const DEFAULT_SETTINGS: FrontierSettings = {
  defaultLead: DEFAULT_LEAD_MODEL,
  workerModel: "auto",
  sessionCapUsd: 5,
  dailyCapUsd: 25,
  useForAuto: false,
  compactWithLead: false,
  effort: "high",
  prices: {},
};

interface FrontierFileData {
  version: 1;
  providers: FrontierProvider[];
  settings: FrontierSettings;
}

export interface ProviderStatus extends FrontierProvider {
  /** The signed-in account here may use it. */
  usable: boolean;
  /** Why not ("belongs to another account", "sign in to EdgeCoder"). */
  reason?: string;
}

export const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";
export const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com";

/** https anywhere, or http only to this computer (a local OpenAI-compatible server). */
export function normalizeBaseUrl(raw: string): string {
  const t = raw.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw new FrontierKeyError("The base URL isn't a URL.");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new FrontierKeyError("The base URL must be https (or http on this computer).");
  if (u.username || u.password || u.search || u.hash) throw new FrontierKeyError("The base URL can't carry credentials, a query or a fragment.");
  return t;
}

const keychainAccount = (accountId: string, providerId: string) => `${accountId}:${providerId}`;

export class FrontierKeyStore {
  readonly file: string;
  private readonly keychain: Keychain;
  readonly fallback: boolean;

  constructor(opts: { file?: string; keychain?: Keychain; fallback?: boolean; env?: NodeJS.ProcessEnv } = {}) {
    const env = opts.env ?? process.env;
    this.file = opts.file ?? defaultFrontierFile(env);
    if (opts.keychain) {
      this.keychain = opts.keychain;
      this.fallback = opts.fallback ?? opts.keychain.name === "file";
    } else {
      const d = detectKeychain(env);
      this.keychain = d.keychain;
      this.fallback = d.fallback;
    }
  }

  /** "macOS keychain", or "a 0600 file (no keychain)". */
  get storageLabel(): string {
    return this.fallback ? `a private file (${join(dirname(this.file), "frontier-keys.json")}, mode 0600) because no keychain is available` : this.keychain.name;
  }

  private read(): FrontierFileData {
    try {
      const d = JSON.parse(readFileSync(this.file, "utf8")) as Partial<FrontierFileData>;
      return { version: 1, providers: Array.isArray(d.providers) ? d.providers : [], settings: { ...DEFAULT_SETTINGS, ...(d.settings ?? {}) } };
    } catch {
      return { version: 1, providers: [], settings: { ...DEFAULT_SETTINGS } };
    }
  }

  private write(d: FrontierFileData): void {
    writePrivate(this.file, JSON.stringify(d, null, 2));
  }

  settings(): FrontierSettings {
    return this.read().settings;
  }

  updateSettings(patch: Partial<FrontierSettings>): FrontierSettings {
    const d = this.read();
    const next = { ...d.settings };
    if (patch.defaultLead !== undefined) {
      if (!isFrontierModelId(patch.defaultLead)) throw new FrontierKeyError("The default lead must be a frontier/<provider>/<model> id.");
      next.defaultLead = patch.defaultLead;
    }
    if (patch.workerModel !== undefined) {
      if (isFrontierModelId(patch.workerModel)) throw new FrontierKeyError("The worker model runs helpers and delegated work; use auto or a network/local model, not a frontier one.");
      next.workerModel = patch.workerModel || "auto";
    }
    const cap = (v: number | null | undefined, name: string) => {
      if (v === null) return null;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100_000) throw new FrontierKeyError(`${name} must be a dollar amount (or null for no cap).`);
      return v;
    };
    if (patch.sessionCapUsd !== undefined) next.sessionCapUsd = cap(patch.sessionCapUsd, "The session cap");
    if (patch.dailyCapUsd !== undefined) next.dailyCapUsd = cap(patch.dailyCapUsd, "The daily cap");
    if (patch.useForAuto !== undefined) next.useForAuto = patch.useForAuto === true;
    if (patch.compactWithLead !== undefined) next.compactWithLead = patch.compactWithLead === true;
    if (patch.effort !== undefined) {
      if (!["low", "medium", "high", "xhigh", "max"].includes(patch.effort)) throw new FrontierKeyError("effort is low, medium, high, xhigh or max.");
      next.effort = patch.effort;
    }
    if (patch.prices !== undefined) {
      for (const [k, p] of Object.entries(patch.prices)) {
        if (!k || k.length > 200 || !p || !(p.input >= 0) || !(p.output >= 0)) throw new FrontierKeyError(`Bad price for ${k}: give input and output USD per million tokens.`);
      }
      next.prices = patch.prices;
    }
    d.settings = next;
    this.write(d);
    return next;
  }

  /** Every stored provider, marked usable or not for `account` (the account signed in here, or null). */
  list(account: string | null): ProviderStatus[] {
    return this.read().providers.map((p) => {
      if (!account) return { ...p, usable: false, reason: "Sign in to EdgeCoder on this computer to use your keys." };
      if (p.accountId !== account) return { ...p, usable: false, reason: "Belongs to another account: it can be removed here, and used only when that account signs back in." };
      return { ...p, usable: true };
    });
  }

  /** The provider `id` the signed-in `account` may use, or null. */
  usable(id: string, account: string | null): FrontierProvider | null {
    if (!account) return null;
    return this.read().providers.find((p) => p.id === id && p.accountId === account) ?? null;
  }

  async add(input: { id: string; kind?: FrontierKind; baseUrl?: string; key: string; accountId: string; models?: string[] }): Promise<ProviderStatus> {
    const id = input.id.trim().toLowerCase();
    if (!PROVIDER_ID_RE.test(id)) throw new FrontierKeyError("A provider name is lowercase letters, digits and dashes (anthropic, openai, openrouter).");
    if (!ACCOUNT_RE.test(input.accountId)) throw new FrontierKeyError("Sign in to EdgeCoder on this computer before adding a key.", 409);
    const key = input.key.trim();
    if (!KEY_RE.test(key)) throw new FrontierKeyError("That doesn't look like an API key (8-512 characters, no spaces or quotes).");
    const kind: FrontierKind = id === "anthropic" ? "anthropic" : input.kind ?? "openai-compatible";
    if (kind === "anthropic" && id !== "anthropic") throw new FrontierKeyError("The Anthropic provider is named anthropic.");
    const baseUrl = input.baseUrl ? normalizeBaseUrl(input.baseUrl) : kind === "openai-compatible" ? (id === "openai" ? OPENAI_DEFAULT_BASE : undefined) : undefined;
    if (kind === "openai-compatible" && !baseUrl) throw new FrontierKeyError("An OpenAI-compatible provider needs its base URL (for example https://api.openai.com/v1).");
    await this.keychain.set(keychainAccount(input.accountId, id), key);
    const d = this.read();
    const entry: FrontierProvider = {
      id,
      kind,
      ...(baseUrl ? { baseUrl } : {}),
      accountId: input.accountId,
      storage: this.fallback ? "file" : "keychain",
      addedAt: Date.now(),
      ...(input.models?.length ? { models: input.models.slice(0, 200) } : {}),
    };
    d.providers = [...d.providers.filter((p) => !(p.id === id && p.accountId === input.accountId)), entry];
    this.write(d);
    return { ...entry, usable: true };
  }

  /** Remember the models a test listed (OpenAI-compatible providers list only these). */
  setModels(id: string, accountId: string, models: string[]): void {
    const d = this.read();
    const p = d.providers.find((x) => x.id === id && x.accountId === accountId);
    if (!p) return;
    p.models = models.filter((m) => typeof m === "string" && m && m.length <= 200).slice(0, 200);
    this.write(d);
  }

  /** The secret for the signed-in account's provider; throws when it isn't that account's (or is gone). */
  async key(id: string, account: string | null): Promise<string> {
    const p = this.usable(id, account);
    if (!p) throw new FrontierKeyError(account ? `No ${id} key for your account on this computer.` : "Sign in to EdgeCoder on this computer to use your frontier keys.", account ? 404 : 409);
    const k = await this.keychain.get(keychainAccount(p.accountId, p.id));
    if (!k) throw new FrontierKeyError(`The ${id} key is missing from ${this.keychain.name}. Add it again in Settings → Frontier models.`, 404);
    return k;
  }

  /** Remove a key: the signed-in account's by default, or another account's (`ownerAccount`). Returns whether one was removed. */
  async remove(id: string, ownerAccount: string): Promise<boolean> {
    const d = this.read();
    const before = d.providers.length;
    d.providers = d.providers.filter((p) => !(p.id === id && p.accountId === ownerAccount));
    await this.keychain.remove(keychainAccount(ownerAccount, id)).catch(() => undefined);
    if (d.providers.length === before) return false;
    this.write(d);
    return true;
  }
}
