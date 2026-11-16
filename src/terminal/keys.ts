// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * `edgecoder keys`: your own frontier API keys (docs/frontier-keys.md), the terminal twin of the
 * app's Settings → Frontier models. Talks to the IDE provider on this computer (the app's, or one
 * started in this process), which keeps the key in the OS keychain, bound to your account.
 *
 * The key is never taken as a command-line argument (it would land in your shell history and in
 * `ps`): it is read hidden from the terminal, from a file (--key-file) or from an environment
 * variable you name (--key-env).
 */

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { ANTHROPIC_MODELS, formatUsd, frontierLabel } from "../inference-api/frontier-models.js";
import type { ClientRef } from "../apps/ide/sessions.js";
import { ProviderClient, ProviderError } from "./client.js";
import { makeStyle, type Style } from "./render.js";

export const KEYS_USAGE = `Usage: edgecoder keys <command> [options]

Your own API keys for frontier models (Anthropic, or any OpenAI-compatible provider). Each key stays
on this computer, in the OS keychain, and is usable only by your EdgeCoder account. Calls go straight
to the provider and are billed by them; EdgeCoder charges no cSats for them.

Commands:
  list                            keys on this computer, settings and spend
  add <provider>                  add a key (anthropic, openai, or a name for another OpenAI-compatible provider)
      --base-url <url>            the provider's API base (OpenAI-compatible; openai defaults to https://api.openai.com/v1)
      --key-file <path>           read the key from a file      --key-env <VAR>  from an environment variable
      --no-test                   store without checking it first
  test <provider>                 check a stored key (lists the models it can use)
  remove <provider>               remove your key   --account <acct-...>  remove another account's key
  set                             change settings:
      --lead <id>                 default lead, e.g. frontier/anthropic/claude-opus-5-5
      --worker <id>               worker model for helpers and delegated work (default auto)
      --session-cap <usd|none>    frontier spend per session (default 5)
      --daily-cap <usd|none>      frontier spend per day (default 25)
      --auto <on|off>             let Auto use your frontier lead for high-complexity jobs (default off)
      --effort <low|medium|high|xhigh|max>   Anthropic effort for the lead (default high)
  --provider <url> / --standalone / --port <n>   which IDE provider to use (as for \`edgecoder code\`)
`;

interface FrontierStatus {
  account: string | null;
  storage: string;
  fallbackFile: boolean;
  providers: Array<{ id: string; kind: string; baseUrl?: string; accountId: string; storage: string; usable: boolean; reason?: string; models?: string[] }>;
  models: string[];
  settings: { defaultLead: string; workerModel: string; sessionCapUsd: number | null; dailyCapUsd: number | null; useForAuto: boolean; effort: string };
  spend: { today: number; last30Days: number };
}

/** A line typed with nothing echoed (a TTY), or the whole of stdin (a pipe). */
async function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = "";
    for await (const chunk of stdin) data += String(chunk);
    return data.trim();
  }
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
      if (err) reject(err);
      else resolve(value.trim());
    };
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("Cancelled."));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function capArg(v: string | undefined, name: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (/^(none|off|no)$/i.test(v)) return null;
  const n = Number(v.replace(/^\$/, ""));
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} is a dollar amount or "none".`);
  return n;
}

export function formatKeysList(s: FrontierStatus, st: Style): string {
  const out: string[] = [];
  out.push(`${st.dim("account ")} ${s.account ?? st.yellow("not signed in (keys can't be used until you sign in)")}`);
  out.push(`${st.dim("storage ")} ${s.storage}${s.fallbackFile ? st.yellow("  (no keychain found)") : ""}`);
  if (!s.providers.length) out.push(st.dim("No keys yet. Add one: edgecoder keys add anthropic"));
  for (const p of s.providers) {
    const where = p.baseUrl ? ` ${st.dim(p.baseUrl)}` : "";
    out.push(`  ${p.usable ? st.green("●") : st.yellow("○")} ${p.id}${where}  ${p.usable ? "usable" : st.yellow(p.reason ?? "not usable")}${p.usable ? "" : st.dim(` (${p.accountId})`)}`);
  }
  const set = s.settings;
  out.push(`${st.dim("lead    ")} ${frontierLabel(set.defaultLead)} ${st.dim(`(${set.defaultLead}, effort ${set.effort})`)}`);
  out.push(`${st.dim("worker  ")} ${set.workerModel}`);
  out.push(`${st.dim("caps    ")} ${set.sessionCapUsd === null ? "no session cap" : `${formatUsd(set.sessionCapUsd)} per session`}, ${set.dailyCapUsd === null ? "no daily cap" : `${formatUsd(set.dailyCapUsd)} per day`} ${st.dim("(warning at 80%)")}`);
  out.push(`${st.dim("auto    ")} ${set.useForAuto ? "may use your frontier lead for high-complexity jobs" : "never uses your key (default)"}`);
  out.push(`${st.dim("spent   ")} ${formatUsd(s.spend.today)} today, ${formatUsd(s.spend.last30Days)} in 30 days ${st.dim("(estimated; billed by the provider)")}`);
  out.push(st.dim("Your keys stay on this computer and are usable only by your account. Never for other people's requests or network work."));
  return out.join("\n");
}

export async function runKeys(argv: string[]): Promise<number> {
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const st = makeStyle(color);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "base-url": { type: "string" },
        "key-file": { type: "string" },
        "key-env": { type: "string" },
        "no-test": { type: "boolean", default: false },
        account: { type: "string" },
        lead: { type: "string" },
        worker: { type: "string" },
        "session-cap": { type: "string" },
        "daily-cap": { type: "string" },
        auto: { type: "string" },
        effort: { type: "string" },
        provider: { type: "string" },
        standalone: { type: "boolean", default: false },
        port: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${KEYS_USAGE}`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  const [cmd, name] = positionals;
  if (v.help || !cmd) {
    process.stdout.write(KEYS_USAGE);
    return v.help ? 0 : 2;
  }
  const me: ClientRef = { clientId: `keys-${randomUUID().slice(0, 12)}`, kind: "terminal", label: `Terminal on ${hostname().replace(/\.local$/, "")}` };
  const { connectProvider } = await import("./cli.js");
  let conn: { client: ProviderClient; stop?: () => Promise<void> };
  try {
    const port = v.port ? Number(v.port) : undefined;
    conn = await connectProvider({ provider: v.provider, standalone: v.standalone ?? false, port }, me, (s) => process.stderr.write(`${st.dim(s)}\n`));
  } catch (err) {
    console.error(st.red((err as Error).message));
    return 1;
  }
  const c = conn.client;
  try {
    switch (cmd) {
      case "list": {
        process.stdout.write(`${formatKeysList(await c.req<FrontierStatus>("GET", "/v1/ide/frontier"), st)}\n`);
        return 0;
      }
      case "add": {
        if (!name) throw new Error("Which provider? edgecoder keys add anthropic (or openai, or a name with --base-url).");
        let key = "";
        if (v["key-file"]) key = readFileSync(v["key-file"], "utf8").trim();
        else if (v["key-env"]) key = (process.env[v["key-env"]] ?? "").trim();
        else key = await readHidden(`Paste your ${name} API key (hidden): `);
        if (!key) throw new Error("No key given.");
        const r = await c.req<{ provider: { id: string; storage: string }; models: string[] }>(
          "POST",
          "/v1/ide/frontier/keys",
          { id: name, key, ...(v["base-url"] ? { baseUrl: v["base-url"], kind: "openai-compatible" } : {}), skipTest: v["no-test"] ?? false },
          false,
        );
        key = "";
        const models = name === "anthropic" ? ANTHROPIC_MODELS.map((m) => `frontier/anthropic/${m.id}`) : r.models.slice(0, 8).map((m) => `frontier/${name}/${m}`);
        process.stdout.write(`${st.green("✓")} ${name} key saved (${r.provider.storage === "file" ? "in a private file: no keychain here" : "in the keychain"}), usable only by your account.\n`);
        process.stdout.write(`Your key stays on this computer. Calls go straight to ${name === "anthropic" ? "Anthropic" : name} and are billed by them.\n`);
        if (models.length) process.stdout.write(`${st.dim("Models:")} ${models.join(", ")}${r.models.length > 8 ? " …" : ""}\n`);
        process.stdout.write(`${st.dim("Use it:")} edgecoder code --lead ${models[0] ?? `frontier/${name}/<model>`} --worker auto\n`);
        return 0;
      }
      case "test": {
        if (!name) throw new Error("Which provider? edgecoder keys test anthropic");
        const r = await c.req<{ models: string[] }>("POST", "/v1/ide/frontier/keys/test", { id: name }, false);
        process.stdout.write(`${st.green("✓")} The ${name} key works. ${r.models.length ? `${r.models.length} models, e.g. ${r.models.slice(0, 5).join(", ")}` : ""}\n`);
        return 0;
      }
      case "remove": {
        if (!name) throw new Error("Which provider? edgecoder keys remove anthropic");
        const r = await c.req<{ removed: boolean }>("POST", "/v1/ide/frontier/keys/remove", { id: name, ...(v.account ? { ownerAccount: v.account } : {}) }, false);
        process.stdout.write(r.removed ? `${st.green("✓")} Removed the ${name} key.\n` : `No ${name} key to remove.\n`);
        return 0;
      }
      case "set": {
        const patch: Record<string, unknown> = {};
        if (v.lead) patch.defaultLead = v.lead;
        if (v.worker) patch.workerModel = v.worker;
        const sc = capArg(v["session-cap"], "--session-cap");
        const dc = capArg(v["daily-cap"], "--daily-cap");
        if (sc !== undefined) patch.sessionCapUsd = sc;
        if (dc !== undefined) patch.dailyCapUsd = dc;
        if (v.auto) patch.useForAuto = /^(on|yes|true|1)$/i.test(v.auto);
        if (v.effort) patch.effort = v.effort;
        if (!Object.keys(patch).length) throw new Error("Nothing to set. See edgecoder keys --help.");
        await c.req("POST", "/v1/ide/frontier/settings", patch, false);
        process.stdout.write(`${formatKeysList(await c.req<FrontierStatus>("GET", "/v1/ide/frontier"), st)}\n`);
        return 0;
      }
      default:
        console.error(`Unknown command "${cmd}".\n\n${KEYS_USAGE}`);
        return 2;
    }
  } catch (err) {
    console.error(st.red(err instanceof ProviderError ? err.message : (err as Error).message));
    return 1;
  } finally {
    await conn.stop?.().catch(() => undefined);
  }
}
