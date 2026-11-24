// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * `edgecoder code`: an agent in your terminal, in the current folder (or a GitHub repository it
 * clones first), on the same agent loop and tools as the desktop app's Code view. See docs/terminal.md.
 *
 * Where the agent runs: the IDE provider on this machine. When the EdgeCoder app is running, its
 * provider (127.0.0.1:4304, ~/.edgecoder/ide-token) is used, so the session can be continued in the
 * app (/remote). Otherwise the provider starts inside this process on the same address; network
 * models then go through this machine's agent when it is enrolled, or the hosted endpoint with
 * your API key (EDGECODER_API_KEY or --api-key-file).
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import * as readline from "node:readline";
import { parseArgs } from "node:util";
import type { ClientRef } from "../apps/ide/sessions.js";
import { ProviderClient, ProviderError } from "./client.js";
import { makeStyle } from "./render.js";
import { Repl, type ReplIO } from "./repl.js";

export const USAGE = `Usage: edgecoder code [folder] [options]

Start a coding agent in [folder] (default: the current folder).

Options:
  --repo <url|owner/repo>  clone (or update) a GitHub repository into your projects folder and work there
  --model <id>             a local model tag, network/<model>[@class], mine/<model> or auto (default auto)
  --lead <id>              the lead model (runs the agent loop), e.g. frontier/anthropic/claude-opus-5-5 on your own key
  --worker <id>            the worker model for helpers and delegated work (default auto; never a frontier model)
  --compute <where>        local, network or auto (picks a default model for that place)
  --tentacles <n>          let the lead delegate to up to n helper agents at once (0 = off); docs/tentacles.md
  --tentacle-budget <c>    cSats the session's tentacles may spend in all (default 100)
  --remote                 show the session live in the EdgeCoder app from the start (same as /remote)
  --resume <session-id>    continue a saved session
  --trust                  trust the folder without asking (the project's own tooling may then run)
  --mode <mode>            ask, auto-edits, auto, plan or full (default: auto-edits in a git repository with a
                           clean working tree, else ask). Shift+Tab or /mode changes it later.
                             ask         edits and commands ask
                             auto-edits  edits apply without asking (each turn stays undoable)
                             auto        safe commands and edits apply; risky ones ask,
                                         dangerous ones are refused (docs/permission-modes.md)
                             plan        read-only until you approve the plan (/approve)
                             full        Full access: nothing asks (commands, edits, installs,
                                         pushes); only a few destructive or secret-leaking
                                         commands are still refused
                           Read-only commands (grep, ls, cat, git status/diff/log…) never ask.
  --auto-edits             same as --mode auto-edits
  --provider <url>         the IDE provider to use (default http://127.0.0.1:4304, or IDE_PROVIDER_URL)
  --standalone             always start the provider in this process
  --port <n>               port for an in-process provider (default 4304)
  --api-key-file <path>    an EdgeCoder API key (eck_...) for network models without the app
  --list                   list saved sessions and exit
  -h, --help               this help
`;

interface Args {
  folder?: string;
  repo?: string;
  model?: string;
  lead?: string;
  worker?: string;
  compute?: string;
  remote: boolean;
  resume?: string;
  trust: boolean;
  autoEdits: boolean;
  mode?: "ask" | "auto-edits" | "auto" | "plan" | "full";
  provider?: string;
  standalone: boolean;
  port?: number;
  apiKeyFile?: string;
  tentacles?: number;
  tentacleBudget?: number;
  list: boolean;
  help: boolean;
}

export function parseCodeArgs(argv: string[]): Args | { error: string } {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        repo: { type: "string" },
        model: { type: "string" },
        lead: { type: "string" },
        worker: { type: "string" },
        compute: { type: "string" },
        remote: { type: "boolean", default: false },
        resume: { type: "string" },
        trust: { type: "boolean", default: false },
        "auto-edits": { type: "boolean", default: false },
        mode: { type: "string" },
        provider: { type: "string" },
        standalone: { type: "boolean", default: false },
        port: { type: "string" },
        "api-key-file": { type: "string" },
        tentacles: { type: "string" },
        "tentacle-budget": { type: "string" },
        list: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    if (positionals.length > 1) return { error: "Give at most one folder." };
    if (values.mode && !["ask", "auto-edits", "auto", "plan", "full"].includes(values.mode)) return { error: "--mode is ask, auto-edits, auto, plan or full." };
    if (values.worker?.toLowerCase().startsWith("frontier/")) return { error: "--worker can't be a frontier model: helpers and delegated work run on auto, the network or this computer." };
    if (values.compute && !["local", "network", "auto", "mine"].includes(values.compute)) return { error: "--compute is local, network, mine or auto." };
    const port = values.port ? Number(values.port) : undefined;
    const tentacles = values.tentacles !== undefined ? Number(values.tentacles) : undefined;
    if (tentacles !== undefined && !(Number.isInteger(tentacles) && tentacles >= 0 && tentacles <= 16)) return { error: "--tentacles is 0 to 16." };
    const tentacleBudget = values["tentacle-budget"] !== undefined ? Number(values["tentacle-budget"]) : undefined;
    if (tentacleBudget !== undefined && !(Number.isFinite(tentacleBudget) && tentacleBudget >= 0)) return { error: "--tentacle-budget is a number of cSats." };
    if (values.lead && values.model && values.lead !== values.model) return { error: "Give --lead or --model, not both." };
    if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) return { error: "--port must be a port number." };
    return {
      folder: positionals[0],
      repo: values.repo,
      model: values.model,
      lead: values.lead,
      worker: values.worker,
      compute: values.compute,
      remote: values.remote ?? false,
      resume: values.resume,
      trust: values.trust ?? false,
      autoEdits: values["auto-edits"] ?? false,
      ...(values.mode ? { mode: values.mode as "ask" | "auto-edits" | "auto" | "plan" | "full" } : values["auto-edits"] ? { mode: "auto-edits" as const } : {}),
      provider: values.provider,
      standalone: values.standalone ?? false,
      port,
      apiKeyFile: values["api-key-file"],
      tentacles,
      tentacleBudget,
      list: values.list ?? false,
      help: values.help ?? false,
    };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** The model a new session starts on. */
export function initialModel(a: Pick<Args, "model" | "compute"> & { lead?: string }, env: NodeJS.ProcessEnv = process.env): string {
  if (a.lead) return a.lead;
  if (a.model) return a.model;
  if (a.compute === "local") return env.OLLAMA_MODEL || "qwen3.5:9b";
  if (a.compute === "network") return "network/qwen3-coder:30b";
  if (a.compute === "mine") return "mine/qwen3-coder:30b";
  return "auto";
}

/**
 * The tentacle settings the flags ask for, or null when none was given. Helpers run on the
 * session's worker model (--worker, set on the session; never a frontier model).
 */
export function tentacleConfigFromArgs(a: Pick<Args, "tentacles" | "tentacleBudget">): Record<string, unknown> | null {
  if (a.tentacles === undefined && a.tentacleBudget === undefined) return null;
  return {
    ...(a.tentacles !== undefined ? { enabled: a.tentacles > 0, ...(a.tentacles > 0 ? { maxParallel: a.tentacles } : {}) } : { enabled: true }),
    ...(a.tentacleBudget !== undefined ? { budgetCSats: a.tentacleBudget } : {}),
  };
}

/**
 * Lines from a terminal (readline) or a pipe. The REPL always has a line being read, so whatever
 * arrives meanwhile (the reply streaming, a tool call, the app's messages) is printed above the
 * prompt and what you were typing is redrawn below it. Esc and Shift+Tab are reported as keys.
 */
export function terminalIO(): ReplIO {
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const slash = ["/help", "/model", "/compute", "/mode", "/remote", "/stop", "/queue", "/unqueue", "/undo", "/clear", "/compact", "/status", "/cost", "/github", "/tentacles", "/exit"];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: tty,
    // Tab completes slash commands (and keeps Shift+Tab from inserting anything).
    completer: (line: string) => [line.startsWith("/") ? slash.filter((c) => c.startsWith(line)) : [], line] as [string[], string],
  });
  const lines: string[] = [];
  const waiters: Array<(l: string | null) => void> = [];
  let ended = false;
  let prompting = false;
  let held = "";
  rl.on("line", (l) => {
    prompting = false;
    const w = waiters.shift();
    if (w) w(l);
    else lines.push(l);
  });
  rl.on("close", () => {
    ended = true;
    for (const w of waiters.splice(0)) w(null);
  });
  let interrupt: (() => void) | null = null;
  let onKey: ((k: "escape" | "shift-tab") => void) | null = null;
  if (tty) {
    rl.on("SIGINT", () => interrupt?.());
    // Bracketed paste stays off: a terminal that sends its markers would leave "[200~" on screen.
    process.stdout.write("\x1b[?2004l");
    process.stdin.on("keypress", (_s: string | undefined, key: { name?: string; shift?: boolean; ctrl?: boolean; meta?: boolean } | undefined) => {
      if (!key) return;
      if (key.name === "escape" && !key.meta) onKey?.("escape");
      else if (key.name === "tab" && key.shift) onKey?.("shift-tab");
    });
  } else process.on("SIGINT", () => interrupt?.());
  const width = () => Math.max(20, process.stdout.columns || 80);
  /** Print text above the prompt and redraw the prompt with what was typed. */
  const above = (text: string) => {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(text);
    rl.prompt(true);
  };
  return {
    interactive: tty,
    readLine(prompt) {
      if (lines.length) return Promise.resolve(lines.shift()!);
      if (ended) return Promise.resolve(null);
      if (tty) {
        rl.setPrompt(prompt);
        rl.prompt(true);
        prompting = true;
      } else process.stdout.write(prompt);
      return new Promise((r) => waiters.push(r));
    },
    setPrompt(prompt) {
      if (!tty) return;
      rl.setPrompt(prompt);
      if (prompting) above("");
    },
    write(text) {
      if (!(tty && prompting)) {
        process.stdout.write(text);
        return;
      }
      // Whole lines go above the prompt; a partial line waits for its end (or for a full row,
      // so a long streamed line still shows up).
      held += text;
      const cut = held.lastIndexOf("\n");
      if (cut >= 0) {
        above(held.slice(0, cut + 1));
        held = held.slice(cut + 1);
      }
      if (held.length >= width()) {
        above(`${held}\n`);
        held = "";
      }
    },
    onInterrupt(fn) {
      interrupt = fn;
    },
    onKey(fn) {
      onKey = fn;
    },
    close() {
      rl.close();
    },
  };
}

const DEFAULT_PROVIDER = "http://127.0.0.1:4304";

/** Use the app's provider when it answers, else start one in this process. */
export async function connectProvider(a: Pick<Args, "provider" | "standalone" | "port" | "apiKeyFile">, me: ClientRef, say: (s: string) => void): Promise<{ client: ProviderClient; label: string; stop?: () => Promise<void> }> {
  const { resolveIdeToken } = await import("../apps/ide/ide-auth.js");
  const explicit = a.provider ?? process.env.IDE_PROVIDER_URL;
  if (!a.standalone) {
    const url = (explicit ?? DEFAULT_PROVIDER).replace(/\/+$/, "");
    const client = new ProviderClient(url, resolveIdeToken(), me);
    if (await client.health()) {
      if (!(await client.hasSessions())) {
        throw new Error(`The EdgeCoder provider at ${url} is an older version without shared sessions. Update the EdgeCoder app, or run with --standalone --port 4314.`);
      }
      return { client, label: explicit ? `provider at ${url}` : "the EdgeCoder app on this computer" };
    }
    if (explicit) throw new Error(`Nothing answers at ${url}.`);
  }
  // In-process provider, quiet (its logs would land in the conversation) unless LOG_LEVEL says otherwise.
  const port = a.port ?? 4304;
  process.env.IDE_PROVIDER_PORT = String(port);
  process.env.LOG_LEVEL ||= "silent";
  if (a.apiKeyFile) process.env.EDGECODER_API_KEY_FILE = resolve(a.apiKeyFile);
  // Node's warnings (library deprecations) would print into the conversation too.
  process.removeAllListeners("warning");
  say(`Starting the EdgeCoder provider in this process on 127.0.0.1:${port}…`);
  const { ideProviderServer } = await import("../apps/ide/provider-server.js");
  await ideProviderServer.listen({ host: "127.0.0.1", port });
  const client = new ProviderClient(`http://127.0.0.1:${port}`, resolveIdeToken(), me);
  return { client, label: "provider in this process", stop: () => ideProviderServer.close() };
}

export async function runCode(argv: string[]): Promise<number> {
  const a = parseCodeArgs(argv);
  if ("error" in a) {
    console.error(`${a.error}\n\n${USAGE}`);
    return 2;
  }
  if (a.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const st = makeStyle(color);
  const say = (s: string) => process.stdout.write(`${st.dim(s)}\n`);
  const me: ClientRef = { clientId: `term-${randomUUID().slice(0, 12)}`, kind: "terminal", label: `Terminal on ${hostname().replace(/\.local$/, "")}` };
  let conn: Awaited<ReturnType<typeof connectProvider>>;
  try {
    conn = await connectProvider(a, me, say);
  } catch (err) {
    console.error(st.red((err as Error).message));
    return 1;
  }
  const io = terminalIO();
  const { client } = conn;
  try {
    if (a.list) {
      for (const s of await client.listSessions()) {
        process.stdout.write(`${s.id}  ${s.live ? st.green("live ") : s.published ? "shown" : "     "}  ${s.title}  ${st.dim(s.projectRoot)}\n`);
      }
      return 0;
    }
    let sessionId: string;
    if (a.resume) {
      const snap = await client.snapshot(a.resume);
      sessionId = snap.session.id;
      if (a.mode) await client.settings(sessionId, { mode: a.mode });
    } else {
      let projectRoot: string;
      if (a.repo) {
        say(`Connecting ${a.repo}…`);
        const r = await client.connectRepo(a.repo, (line) => say(`  ${line}`));
        say(r.message);
        projectRoot = r.path;
      } else {
        projectRoot = resolve(a.folder ?? process.cwd());
        if (!existsSync(projectRoot)) {
          const ans = (await io.readLine(`${projectRoot} doesn't exist. Create it? [y/N] `))?.trim().toLowerCase();
          if (ans !== "y" && ans !== "yes") return 1;
          mkdirSync(projectRoot, { recursive: true });
        } else if (!statSync(projectRoot).isDirectory()) {
          console.error(st.red(`${projectRoot} isn't a folder.`));
          return 1;
        }
      }
      // No --mode: the provider picks (auto-edits in a clean git repository, else ask).
      const snap = await client.createSession({ projectRoot, model: initialModel(a), ...(a.worker ? { workerModel: a.worker } : {}), ...(a.mode ? { mode: a.mode } : {}) });
      sessionId = snap.session.id;
      if (!snap.trusted) {
        let trust = a.trust;
        if (!trust && process.stdin.isTTY) {
          const ans = (await io.readLine(`Trust ${projectRoot}? EdgeCoder may then run the project's own tooling (type checkers, linters) by itself. The agent's commands always ask first. [y/N] `))?.trim().toLowerCase();
          trust = ans === "y" || ans === "yes";
        }
        if (trust) await client.trust(sessionId, true);
      }
    }
    // Tentacles (docs/tentacles.md): the session's helper-agent settings.
    const tentaclePatch = tentacleConfigFromArgs(a);
    if (tentaclePatch) await client.req("POST", `/v1/ide/sessions/${sessionId}/tentacles/config`, tentaclePatch);
    return await new Repl({ client, sessionId, io, style: st, providerLabel: conn.label, remote: a.remote, defaults: { local: process.env.OLLAMA_MODEL || undefined } }).run();
  } catch (err) {
    console.error(st.red(err instanceof ProviderError ? err.message : (err as Error).message));
    return 1;
  } finally {
    io.close?.();
    await conn.stop?.().catch(() => undefined);
  }
}
