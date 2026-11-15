// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Dogfood work-queue runner: the EdgeCoder network doing EdgeCoder's own backlog.
 *
 * Reads job specs from scripts/dogfood/jobs/*.json, gives each one to the
 * IDE agent loop with a coding model on the network, checks the result, and on a pass commits it
 * to branch dogfood/<id> in this repository (never pushed). A failed job is retried once on a
 * stronger tier, then marked failed with the reason.
 *
 * A job spec: { id, title, job: tests|code_edit|docs|summarize|review, complexity?: small|medium|large,
 * tier?: cpu|mac|gpu, hints?: [..], files?: ["path" | "path#L10-L80"] (pasted into the prompt),
 * context?: [{ label, cmd: ["gh", ...] } | { label, builtin: "failed-ci-logs", limit }] (read-only),
 * instructions, acceptance: { kind: vitest|tsc|grep|none, args } or a list of them,
 * allowedPaths: ["exact/path", "dir/**"], commit?: false (summaries), output?: path to keep }.
 *
 *   npx tsx scripts/dogfood/runner.mts [--jobs a,b] [--max-parallel 3] [--via auto|provider|inproc]
 *                                      [--account st9] [--no-commit] [--dry-run]
 *
 * Two ways to drive the agent (--via, default auto = provider when it answers, else inproc):
 *   provider  the desktop IDE provider on this machine (POST /v1/ide/chat on 127.0.0.1:4304 with
 *             projectRoot in the body, autoApprove "edits", commands approved through
 *             /v1/ide/tool-approval). Never calls POST /v1/ide/project (that would switch the
 *             owner's open project). Model calls go out through the desktop's own agent.
 *   inproc    the same pieces /v1/ide/chat assembles (runAgentLoop, makeToolRunner, ToolExecutor,
 *             the IDE system prompt, checkpoints) in this process, with model calls to the public
 *             API (https://edgecoder.io/v1, a test account's API key). Used when the desktop
 *             app is not running.
 *
 * Tiers (one job per tier at a time, so jobs do not queue behind each other on one slot):
 *   gpu  qwen3-coder:30b on the datacenter GPU (1 slot): tests, code_edit, review
 *   mac  qwen2.5-coder:7b on the Macs: small edits, docs
 *   cpu  qwen2.5-coder:1.5b on the CPU fleet: summarize / classify
 * Escalation: cpu -> mac -> gpu -> gpu (one more attempt). DOGFOOD_AUTO=1 sends model "auto"
 * with the job's hints instead (for when coordinator-side best-fit Auto is deployed).
 *
 * Safety and pacing: every job works in its own git worktree of a throwaway --depth 1 clone in
 * DOGFOOD_DIR (default $TMPDIR/edgecoder-dogfood) with no remote; the clone is deleted at the end.
 * Acceptance checks run one at a time under nice -n 10 with --maxWorkers=2. The queue stops
 * starting jobs when the 1-minute load average passes 30 or free disk drops under 10 GB. Commands
 * the model asks for are allowlisted (targeted vitest, one tsc, read-only shell); gh is used only
 * read-only, by the runner, for summarize jobs' context. Keys and tokens are never printed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { homedir, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// The agent loop's code: this checkout's, or DOGFOOD_SRC (e.g. a branch with an agent-loop fix).
const SRC = process.env.DOGFOOD_SRC ?? join(REPO, "src");
const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1] === undefined || argv[i + 1].startsWith("--") ? "true" : argv[i + 1]; };
const DIR = process.env.DOGFOOD_DIR ?? join(tmpdir(), "edgecoder-dogfood");
const RUN = flag("run", `dq-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`)!;
const MAX_PARALLEL = Math.min(3, Number(flag("max-parallel", "3")));
const ACCOUNT = flag("account", "st9")!;
const COMMIT = flag("no-commit") !== "true";
const DRY = flag("dry-run") === "true";
const TASK_TIMEOUT_MS = Number(flag("timeout-min", "25")) * 60_000;
const API = process.env.DOGFOOD_API ?? "https://edgecoder.io";
const PROVIDER = process.env.DOGFOOD_PROVIDER ?? "http://127.0.0.1:4304";
const LOAD_LIMIT = Number(process.env.DOGFOOD_MAX_LOAD ?? 30);
const MIN_FREE_GB = Number(process.env.DOGFOOD_MIN_FREE_GB ?? 10);
const UPSTREAM = process.env.DOGFOOD_UPSTREAM ?? "https://github.com/codyrs82/Edgecoder.git";

// ---------------------------------------------------------------------------- jobs and tiers
type Acceptance = { kind: "vitest" | "tsc" | "grep" | "none"; args?: any };
interface Job {
  id: string; title: string; job: "tests" | "code_edit" | "docs" | "summarize" | "review";
  complexity?: "small" | "medium" | "large"; tier?: TierName; hints?: string[];
  files?: string[]; instructions: string; acceptance: Acceptance | Acceptance[]; allowedPaths: string[];
  context?: Array<{ label: string; cmd?: string[]; builtin?: "failed-ci-logs"; limit?: number }>; commit?: boolean; output?: string;
  /** "chat": one model call without the agent's tools; the runner writes the reply to `output` (summaries on small models). */
  mode?: "agent" | "chat";
}
type TierName = "cpu" | "mac" | "gpu";
const TIERS: Record<TierName, { model: string; ideModel: string; cls: string; label: string; maxTokens?: number }> = {
  cpu: { model: "network/qwen2.5-coder:1.5b@cpu", ideModel: "qwen2.5-coder:1.5b", cls: "cpu", label: "CPU fleet, qwen2.5-coder:1.5b", maxTokens: 1024 },
  mac: { model: "network/qwen2.5-coder:7b", ideModel: "qwen2.5-coder:7b", cls: "any", label: "Mac, qwen2.5-coder:7b" },
  gpu: { model: "network/qwen3-coder:30b@gpu.dc", ideModel: "qwen3-coder:30b", cls: "gpu.dc", label: "datacenter GPU, qwen3-coder:30b" },
};
const STRONGER: Record<TierName, TierName> = { cpu: "mac", mac: "gpu", gpu: "gpu" };
export function tierFor(j: Pick<Job, "job" | "complexity" | "tier">): TierName {
  if (j.tier) return j.tier;
  if (j.job === "summarize") return "cpu";
  if (j.job === "docs" || (j.job === "code_edit" && j.complexity === "small")) return "mac";
  return "gpu";
}

/** "tests/foo/**" matches below tests/foo; anything else matches exactly. */
export function pathAllowed(p: string, allowed: string[]): boolean {
  const n = p.replace(/^\.\//, "");
  return allowed.some((a) => (a.endsWith("/**") ? n.startsWith(a.slice(0, -2)) : n === a));
}

/** gh only, read-only subcommands. */
export function contextCommandAllowed(cmd: string[]): boolean {
  if (cmd[0] !== "gh") return false;
  if ((cmd[1] === "pr" || cmd[1] === "run") && (cmd[2] === "list" || cmd[2] === "view" || cmd[2] === "checks")) return true;
  return cmd[1] === "api" && !cmd.some((a) => /^(-X|--method|-f|-F|--field|--raw-field|--input)$/.test(a));
}

// ---------------------------------------------------------------------------- helpers
const sh = (cmd: string, args: string[], cwd: string, timeoutMs = 300_000) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 50e6, env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" } });
  return { code: r.status ?? (r.signal ? 124 : 1), out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 50e6 }).trim();
const log = (tag: string, o: object) => console.log(`${tag} ${JSON.stringify({ run: RUN, ...o })}`);
function machineBusy(): string | null {
  const l = loadavg()[0];
  if (l > LOAD_LIMIT) return `load average ${l.toFixed(1)} > ${LOAD_LIMIT}`;
  try {
    const s = statfsSync(DIR);
    const freeGb = (s.bavail * s.bsize) / 1e9;
    if (freeGb < MIN_FREE_GB) return `free disk ${freeGb.toFixed(1)} GB < ${MIN_FREE_GB} GB`;
  } catch {}
  return null;
}
let acceptanceLock: Promise<void> = Promise.resolve();
async function exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
  const prev = acceptanceLock;
  let release!: () => void;
  acceptanceLock = new Promise((r) => (release = r));
  await prev;
  try { return await fn(); } finally { release(); }
}

// ---------------------------------------------------------------------------- approvals
type Approval = { tool: string; detail: string; approved: boolean; rewritten?: string };
/** Models often prefix a command with `cd <project root> &&`; commands already run there, so that prefix is dropped. */
export function stripCdPrefix(cmd: string, root: string): string {
  const m = /^cd\s+("?)([^"&;|]+)\1\s*&&\s*/.exec(cmd);
  if (!m) return cmd;
  const dir = m[2].trim().replace(/\/$/, "");
  return dir === root.replace(/\/$/, "") || dir === "." ? cmd.slice(m[0].length) : cmd;
}

function decide(tool: string, args: any, job: Job, approvals: Approval[], st: { tsc: number }, canRewrite: boolean, root = ""): { ok: boolean; args?: any } {
  if (tool === "run_shell") {
    const original = String(args.command ?? "").trim();
    const cmd = canRewrite ? stripCdPrefix(original, root) : original;
    if (cmd !== original) args = { ...args, command: cmd };
    const vitest = /^(?:npx\s+)?vitest(?:\s+run)?\s+(\S+\.test\.ts)(?:\s+--?[\w=-]+)*\s*$/.exec(cmd);
    if (vitest && pathAllowed(vitest[1], job.allowedPaths)) {
      const rw = `nice -n 10 npx vitest run ${vitest[1]} --maxWorkers=2`;
      approvals.push({ tool, detail: cmd, approved: true, ...(canRewrite ? { rewritten: rw } : {}) });
      return { ok: true, ...(canRewrite ? { args: { ...args, command: rw } } : {}) };
    }
    if (canRewrite && /^(?:npx\s+)?tsc\b[^;&|`$<>]*$/.test(cmd) && st.tsc++ < 1) {
      const rw = "nice -n 10 npx tsc --noEmit -p tsconfig.json";
      approvals.push({ tool, detail: cmd, approved: true, rewritten: rw });
      return { ok: true, args: { ...args, command: rw } };
    }
    if (/^(ls|cat|head|tail|grep|rg|wc|sed -n|git (status|diff|log|show))\b[^;&|`$<>]*$/.test(cmd)) { approvals.push({ tool, detail: original, approved: true, ...(cmd !== original ? { rewritten: cmd } : {}) }); return { ok: true, ...(cmd !== original ? { args } : {}) }; }
    approvals.push({ tool, detail: cmd, approved: false });
    return { ok: false };
  }
  if (tool === "write_file" || tool === "edit_file") {
    const ok = pathAllowed(String(args.path ?? ""), job.allowedPaths);
    approvals.push({ tool, detail: String(args.path), approved: ok });
    return { ok };
  }
  approvals.push({ tool, detail: JSON.stringify(args).slice(0, 120), approved: false });
  return { ok: false };
}

// ---------------------------------------------------------------------------- the agent
type Call = { ttftMs: number | null; totalMs: number; promptTokens: number; outputTokens: number; cSats: number; where?: string; error?: string; retries?: number };
interface AgentRun { calls: Call[]; toolCalls: Record<string, number>; sigs: Record<string, number>; approvals: Approval[]; text: string; toolErrors: string[]; timedOut: boolean; via: string; trace?: string[] }

const KEY = (() => { try { return JSON.parse(readFileSync(join(homedir(), ".config/edgecoder/e2e/accounts", `${ACCOUNT}.json`), "utf8")).apiKey as string; } catch { return ""; } })();
const IDE_TOKEN = (() => { try { return readFileSync(join(homedir(), ".edgecoder/ide-token"), "utf8").trim(); } catch { return ""; } })();

/**
 * maxTokens: a reply cap. The CPU agents serve an 8192-token window and the coordinator sizes a
 * call as prompt + reply cap (default 4096): the IDE system prompt and tool list alone are ~4.5K
 * tokens, so CPU-tier calls must cap the reply or no CPU agent can take them.
 */
function publicApiBackend(model: string, calls: Call[], hints?: string[], maxTokens?: number) {
  return async function* (req: any, signal?: AbortSignal) {
    const msgs: any[] = [];
    let pending: string[] = [];
    let n = 0;
    for (const m of req.messages) {
      if (m.role === "assistant" && m.tool_calls?.length) {
        pending = m.tool_calls.map(() => `call_${++n}`);
        msgs.push({ role: "assistant", content: m.content ?? "", tool_calls: m.tool_calls.map((c: any, i: number) => ({ id: pending[i], type: "function", function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments ?? {}) } })) });
      } else if (m.role === "tool") msgs.push({ role: "tool", tool_call_id: pending.shift() ?? `call_${++n}`, name: m.tool_name, content: m.content });
      else msgs.push({ role: m.role, content: m.content });
    }
    const t0 = performance.now();
    const call: Call = { ttftMs: null, totalMs: 0, promptTokens: 0, outputTokens: 0, cSats: 0 };
    calls.push(call);
    try {
      for (let tries = 1; ; tries++) {
      call.retries = tries - 1;
      let busy = false;
      const res = await fetch(`${API}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", "user-agent": "edgecoder-dogfood/1.0" },
        body: JSON.stringify({ model, stream: true, messages: msgs, ...(req.tools ? { tools: req.tools } : {}), ...(req.temperature !== undefined ? { temperature: req.temperature } : {}), ...(maxTokens ? { max_tokens: maxTokens } : {}), ...(model === "auto" && hints?.length ? { edgecoder: { hints } } : {}) }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000),
      });
      if (!res.ok || !res.body) {
        const text = (await res.text().catch(() => "")).slice(0, 300);
        let msg = text;
        try { msg = JSON.parse(text).error?.message ?? text; } catch {}
        // Busy (503), rate limited (429), or the edge in front of the API failing (502/504): wait, ask again.
        if ([429, 502, 503, 504].includes(res.status) && tries < 3) { await new Promise((r) => setTimeout(r, 15_000)); continue; }
        if (/^\s*</.test(msg)) msg = `(an HTML error page from the edge, ${text.length} bytes)`;
        throw new Error(`HTTP ${res.status}: ${msg}`);
      }
      const dec = new TextDecoder();
      let buf = "", done: any = { done: true };
      for await (const chunk of res.body as any) {
        buf += dec.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
          let j: any;
          try { j = JSON.parse(line.slice(6)); } catch { continue; }
          if (j.error) {
            const msg = `stream: ${j.error.message ?? j.error.type ?? JSON.stringify(j.error)}`;
            // "Every machine ... is busy; try again in 15 s" before any output: wait and ask again (3 tries).
            if (/no_capacity|is busy and none could start/i.test(msg) && call.ttftMs === null && tries < 3) { busy = true; break; }
            throw new Error(msg);
          }
          const d = j.choices?.[0]?.delta;
          if (d?.content) { call.ttftMs ??= Math.round(performance.now() - t0); yield { delta: d.content }; }
          if (d?.tool_calls?.length) {
            call.ttftMs ??= Math.round(performance.now() - t0);
            yield { toolCalls: d.tool_calls.map((c: any) => { let a: any = {}; try { a = JSON.parse(c.function?.arguments || "{}"); } catch { a = { __unparsable: String(c.function?.arguments).slice(0, 200) }; } return { function: { name: c.function?.name, arguments: a } }; }) };
          }
          if (j.usage) { call.promptTokens = j.usage.prompt_tokens ?? 0; call.outputTokens = j.usage.completion_tokens ?? 0; }
          if (j.edgecoder) { call.cSats = Number(j.edgecoder.cSatsSpent ?? 0); call.where = j.edgecoder.where; done = { done: true, cSatsSpent: call.cSats, where: call.where }; }
        }
        if (busy) break;
      }
      if (busy) { await new Promise((r) => setTimeout(r, 15_000)); continue; }
      yield done;
      return;
      }
    } catch (e) {
      call.error = String((e as Error).message ?? e).slice(0, 300);
      throw e;
    } finally {
      call.totalMs = Math.round(performance.now() - t0);
    }
  };
}

async function runInproc(job: Job, model: string, wt: string, prompt: string, maxTokens?: number): Promise<AgentRun> {
  const { runAgentLoop, makeToolRunner, toolSchemas, backendChat } = await import(`${SRC}/apps/ide/agent-loop.ts`);
  const { ToolExecutor } = await import(`${SRC}/apps/ide/tool-executor.ts`);
  const { readProjectRules } = await import(`${SRC}/apps/ide/project-fs.ts`);
  const { CheckpointStore } = await import(`${SRC}/apps/ide/checkpoints.ts`);
  const { buildIdeAgentSystemPrompt } = await import(`${SRC}/model/system-prompt.ts`);
  const r: AgentRun = { calls: [], toolCalls: {}, sigs: {}, approvals: [], text: "", toolErrors: [], timedOut: false, via: "inproc" };
  const st = { tsc: 0 };
  const turnId = randomUUID();
  const checkpoints = new CheckpointStore();
  checkpoints.begin(turnId, wt);
  const executor = new ToolExecutor(wt, undefined, undefined);
  const abort = new AbortController();
  const timer = setTimeout(() => { r.timedOut = true; abort.abort(); }, TASK_TIMEOUT_MS);
  const rewrites = new Map<string, any>();
  r.trace = [];
  const sendEvent = (e: any) => {
    if (e.type === "text") r.text += e.content;
    // A compact trace of tool calls and results, for reading what the model tried.
    if (e.type === "tool_call") r.trace!.push(`call ${e.tool} ${JSON.stringify(e.args).slice(0, 300)}`);
    if (e.type === "tool_result" || e.type === "shell_output") r.trace!.push(`result ${e.error ? `ERROR ${String(e.error).slice(0, 200)}` : String(e.result ?? e.stdout ?? "").slice(0, 120).replace(/\n/g, " ")}`);
    if (e.type === "tool_call") {
      r.toolCalls[e.tool] = (r.toolCalls[e.tool] ?? 0) + 1;
      const sig = `${e.tool}:${JSON.stringify(e.args)}`;
      r.sigs[sig] = (r.sigs[sig] ?? 0) + 1;
    }
    if (e.type === "tool_result" && e.error) r.toolErrors.push(String(e.error).slice(0, 200));
  };
  const runTool = makeToolRunner({
    execute: (tool: string, args: any, opts: any) => executor.execute(tool, rewrites.get(JSON.stringify([tool, args])) ?? args, opts),
    sendEvent,
    waitForApproval: async (_id: string, tool: string, args: any) => {
      const d = decide(tool, args, job, r.approvals, st, true, wt);
      if (d.ok && d.args) rewrites.set(JSON.stringify([tool, args]), d.args);
      return d.ok;
    },
    captureBeforeWrite: (p: string) => checkpoints.capture(turnId, p),
    turnId,
    autoApproveEdits: true,
  });
  const promptCtx = { activeModel: model, activeModelParamSize: 0, installedModels: [], swarmModels: [], ollamaHealthy: true, queueDepth: 0, connectedAgents: 0 };
  const rules = readProjectRules(wt);
  try {
    await runAgentLoop({
      chat: backendChat(publicApiBackend(model, r.calls, job.hints, maxTokens), undefined, abort.signal),
      systemPrompt: (format: "native" | "text") => buildIdeAgentSystemPrompt(promptCtx, wt, rules, format),
      messages: [{ role: "user", content: prompt }],
      sendEvent,
      isCancelled: () => abort.signal.aborted,
      tools: toolSchemas().filter((t: any) => t.function.name !== "open_pull_request"),
      runTool,
    });
  } finally { clearTimeout(timer); }
  return r;
}

/** One plain chat call (no tools, no IDE system prompt); the reply goes to job.output. */
async function runChat(job: Job, model: string, wt: string, prompt: string, maxTokens?: number): Promise<AgentRun> {
  const r: AgentRun = { calls: [], toolCalls: {}, sigs: {}, approvals: [], text: "", toolErrors: [], timedOut: false, via: "chat" };
  const backend = publicApiBackend(model, r.calls, job.hints, maxTokens);
  try {
    for await (const p of backend({ messages: [{ role: "system", content: "You write short, accurate Markdown for a software team. Output only the requested Markdown file's content." }, { role: "user", content: prompt }], temperature: 0.2 }, AbortSignal.timeout(TASK_TIMEOUT_MS)) as AsyncGenerator<any>) {
      if (p.delta) r.text += p.delta;
    }
    const body = r.text.replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```\s*$/m, "$1").trim();
    if (job.output && body) {
      mkdirSync(dirname(join(wt, job.output)), { recursive: true });
      writeFileSync(join(wt, job.output), body + "\n");
    }
  } catch (e) {
    r.text += `\nError contacting model: ${(e as Error).message}`;
  }
  return r;
}

async function runProvider(job: Job, tier: TierName, wt: string, prompt: string): Promise<AgentRun> {
  const r: AgentRun = { calls: [], toolCalls: {}, sigs: {}, approvals: [], text: "", toolErrors: [], timedOut: false, via: "provider" };
  const st = { tsc: 0 };
  const t = TIERS[tier];
  const auth = { authorization: `Bearer ${IDE_TOKEN}` };
  const abort = new AbortController();
  const timer = setTimeout(() => { r.timedOut = true; abort.abort(); }, TASK_TIMEOUT_MS);
  let last = performance.now();
  let callStart = last;
  let current: Call | null = null;
  const openCall = () => { current = { ttftMs: null, totalMs: 0, promptTokens: 0, outputTokens: 0, cSats: 0 }; callStart = performance.now(); r.calls.push(current); };
  try {
    const res = await fetch(`${PROVIDER}/v1/ide/chat`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      // projectRoot in the body: never POST /v1/ide/project (the owner's open project).
      body: JSON.stringify({ messages: [{ role: "user", content: prompt }], projectRoot: wt, model: process.env.DOGFOOD_AUTO === "1" ? undefined : t.ideModel, compute: process.env.DOGFOOD_AUTO === "1" ? { target: "auto" } : { target: "network", computeClass: t.cls }, autoApprove: "edits" }),
      signal: abort.signal,
    });
    if (!res.ok || !res.body) throw new Error(`provider HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    openCall();
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as any) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 2);
        if (!raw.startsWith("data: ")) continue;
        let e: any;
        try { e = JSON.parse(raw.slice(6)); } catch { continue; }
        last = performance.now();
        if ((e.type === "text" || e.type === "tool_call") && current && (current as Call).ttftMs === null) (current as Call).ttftMs = Math.round(last - callStart);
        if (e.type === "text") r.text += e.content;
        if (e.type === "usage" && current) { (current as Call).cSats = e.cSats; (current as Call).where = e.where; (current as Call).totalMs = Math.round(last - callStart); }
        if (e.type === "tool_call") {
          r.toolCalls[e.tool] = (r.toolCalls[e.tool] ?? 0) + 1;
          const sig = `${e.tool}:${JSON.stringify(e.args)}`;
          r.sigs[sig] = (r.sigs[sig] ?? 0) + 1;
          if (e.requires_approval) {
            const d = decide(e.tool, e.args, job, r.approvals, st, false);
            await fetch(`${PROVIDER}/v1/ide/tool-approval`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ id: e.id, approved: d.ok }) });
          }
        }
        if (e.type === "tool_result" || e.type === "shell_output") { if (e.error) r.toolErrors.push(String(e.error).slice(0, 200)); openCall(); }
      }
    }
    if (current && (current as Call).ttftMs === null) r.calls.pop();
  } catch (err) {
    if (!r.timedOut) r.text += `\nError contacting model: ${(err as Error).message}`;
  } finally { clearTimeout(timer); }
  return r;
}

// ---------------------------------------------------------------------------- acceptance
/** Paths changed in a worktree (porcelain v1 -z: "XY path", not trimmed: a leading space is the X column). */
export function parsePorcelainZ(out: string): string[] {
  const parts = out.split("\0").filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    files.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i++; // a rename's second path (the source) follows
  }
  return files;
}
function changedFiles(wt: string): string[] {
  return parsePorcelainZ(execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: wt, encoding: "utf8" }));
}

async function accept(job: Job, wt: string): Promise<{ passed: boolean; changed: string[]; checks: any[]; reason?: string }> {
  return exclusive(() => {
    const changed = changedFiles(wt);
    const checks: any[] = [];
    const outside = changed.filter((f) => !pathAllowed(f, job.allowedPaths));
    if (outside.length) return { passed: false, changed, checks, reason: `changed files outside allowedPaths: ${outside.join(", ")}` };
    if (!changed.length) return { passed: false, changed, checks, reason: "no file changed" };
    for (const a of [job.acceptance].flat()) {
      if (a.kind === "vitest") {
        const files: string[] = a.args?.files ?? [];
        const v = sh("nice", ["-n", "10", "npx", "vitest", "run", ...files, "--maxWorkers=2"], wt);
        const passedN = Number(/Tests\s+(\d+) passed/.exec(v.out)?.[1] ?? 0);
        const ok = v.code === 0 && passedN >= (a.args?.minTests ?? 3);
        checks.push({ kind: "vitest", files, exit: v.code, testsPassed: passedN, failed: /(\d+) failed/.exec(v.out)?.[1] ?? null, ok, tail: ok ? undefined : v.out.slice(-1500) });
        if (!ok) return { passed: false, changed, checks, reason: v.code === 0 ? `only ${passedN} tests` : "tests fail" };
      } else if (a.kind === "tsc") {
        // tsconfig.json includes src/ only: with no src/ file changed the project check cannot change.
        if (changed.some((f) => f.startsWith("src/"))) {
          const p = sh("nice", ["-n", "10", "npx", "tsc", "--noEmit", "-p", "tsconfig.json"], wt, 900_000);
          checks.push({ kind: "tsc", project: true, exit: p.code, errors: p.out.split("\n").filter((l) => l.includes("error TS")).slice(0, 10) });
          if (p.code !== 0) return { passed: false, changed, checks, reason: "tsc errors (project)" };
        } else checks.push({ kind: "tsc", project: true, skipped: "no src/ file changed" });
        // tsconfig.json covers src/ only: changed test files get their own strict check.
        const tests = changed.filter((f) => f.startsWith("tests/") && f.endsWith(".ts"));
        if (tests.length) {
          const t = sh("nice", ["-n", "10", "npx", "tsc", "--noEmit", "--strict", "--skipLibCheck", "--target", "es2022", "--module", "nodenext", "--moduleResolution", "nodenext", "--types", "node", ...tests], wt, 900_000);
          checks.push({ kind: "tsc", files: tests, exit: t.code, errors: t.out.split("\n").filter((l) => l.includes("error TS")).slice(0, 10) });
          if (t.code !== 0) return { passed: false, changed, checks, reason: "tsc errors (test file)" };
        }
      } else if (a.kind === "grep") {
        for (const g of a.args ?? []) {
          const f = join(wt, g.file);
          const ok = existsSync(f) && new RegExp(g.pattern, g.flags ?? "m").test(readFileSync(f, "utf8")) === (g.absent !== true);
          checks.push({ kind: "grep", file: g.file, pattern: g.pattern, absent: g.absent ?? false, ok });
          if (!ok) return { passed: false, changed, checks, reason: `grep ${g.absent ? "found" : "missing"} /${g.pattern}/ in ${g.file}` };
        }
      }
    }
    return { passed: true, changed, checks };
  });
}

// ---------------------------------------------------------------------------- one job attempt
function promptFor(job: Job, wt: string, contextBlocks: string[]): string {
  const files = (job.files ?? []).map((spec) => {
    const [f, range] = spec.split("#");
    const p = join(wt, f);
    if (!existsSync(p)) return `--- ${f} (does not exist yet)`;
    let body = readFileSync(p, "utf8");
    const r = range && /^L(\d+)-L(\d+)$/.exec(range);
    if (r) body = body.split("\n").slice(Number(r[1]) - 1, Number(r[2])).join("\n");
    const label = r ? `${f} lines ${r[1]}-${r[2]}` : f;
    return `--- ${label}${body.length > 12_000 ? " (first 12000 characters)" : ""}\n${body.slice(0, 12_000)}`;
  });
  const checks = [job.acceptance].flat().map((a) => a.kind === "vitest" ? `- The check: \`npx vitest run ${(a.args?.files ?? []).join(" ")}\` must pass (run it yourself and fix failures).` : a.kind === "tsc" ? "- The check: TypeScript must compile (`npx tsc --noEmit -p tsconfig.json`)." : a.kind === "grep" ? `- The check: ${(a.args ?? []).map((g: any) => `${g.file} ${g.absent ? "must not contain" : "must contain"} /${g.pattern}/`).join("; ")}.` : "").filter(Boolean);
  if (job.mode === "chat") {
    return [`# ${job.title}`, "", job.instructions, "Reply with only the Markdown, nothing before or after it.", ...(files.length ? ["", "Material:", ...files] : []), ...(contextBlocks.length ? ["", "Context:", ...contextBlocks] : [])].join("\n");
  }
  return [
    `# ${job.title}`,
    "",
    job.instructions,
    "",
    `- You may only create or change: ${job.allowedPaths.map((p) => `\`${p}\``).join(", ")}. Do not change any other file.`,
    ...checks,
    "- When you are done, answer with a short summary of what you changed.",
    ...(files.length ? ["", "Relevant files:", ...files] : []),
    ...(contextBlocks.length ? ["", "Context:", ...contextBlocks] : []),
  ].join("\n");
}

function failureModes(r: AgentRun, acc: { passed: boolean; reason?: string; changed: string[] }): string[] {
  const m: string[] = [];
  const errs = r.calls.map((c) => c.error).filter(Boolean) as string[];
  if (r.timedOut) m.push("timeout");
  if (errs.some((e) => /no_capacity|busy and none could start|503/i.test(e))) m.push("no_capacity");
  if (errs.some((e) => /context_too_long|too long|413/i.test(e))) m.push("context_overflow");
  if (errs.length && !m.length) m.push("model_call_error");
  if (r.toolErrors.some((e) => /unknown tool|__unparsable|required|invalid/i.test(e))) m.push("bad_tool_call");
  if (/<function=|<tool_call>|```tool_call/.test(r.text)) m.push("tool_call_as_text");
  if (Object.values(r.sigs).some((n) => n >= 3)) m.push("loop");
  if (r.calls.length >= 20) m.push("max_iterations");
  if (/\b(I can(?:'|no)t|I'm unable|I am unable|I won't)\b/i.test(r.text) && !acc.changed.length) m.push("refusal");
  if (!acc.passed && acc.reason) m.push(acc.reason);
  return m;
}

const VIA = flag("via", "auto")!;
async function providerUp(): Promise<boolean> {
  try { return (await fetch(`${PROVIDER}/health`, { signal: AbortSignal.timeout(3_000) })).ok && !!IDE_TOKEN; } catch { return false; }
}

async function attempt(job: Job, tier: TierName, n: number, base: string, contextBlocks: string[]) {
  const wt = join(DIR, "wt", `${job.id}-${n}`);
  const branch = `job/${job.id}-${n}`;
  rmSync(wt, { recursive: true, force: true });
  git(base, "worktree", "add", "-q", "-b", branch, wt);
  execFileSync("ln", ["-s", join(REPO, "node_modules"), join(wt, "node_modules")]);
  const model = process.env.DOGFOOD_AUTO === "1" ? "auto" : TIERS[tier].model;
  const t0 = Date.now();
  const card: any = { job: job.id, attempt: n, tier, model, startedAt: new Date(t0).toISOString() };
  try {
    const prompt = promptFor(job, wt, contextBlocks);
    const via = VIA === "auto" ? ((await providerUp()) ? "provider" : "inproc") : VIA;
    const r = job.mode === "chat" ? await runChat(job, model, wt, prompt, TIERS[tier].maxTokens) : via === "provider" ? await runProvider(job, tier, wt, prompt) : await runInproc(job, model, wt, prompt, TIERS[tier].maxTokens);
    card.via = r.via;
    card.agentMs = Date.now() - t0;
    const acc = await accept(job, wt);
    card.passed = acc.passed;
    card.reason = acc.reason;
    card.changed = acc.changed;
    card.checks = acc.checks;
    card.modelCalls = r.calls.length;
    card.toolCalls = r.toolCalls;
    card.approvals = { approved: r.approvals.filter((a) => a.approved).length, rejected: r.approvals.filter((a) => !a.approved).length, list: r.approvals };
    card.tokens = { prompt: r.calls.reduce((a, c) => a + c.promptTokens, 0), output: r.calls.reduce((a, c) => a + c.outputTokens, 0), maxPrompt: Math.max(0, ...r.calls.map((c) => c.promptTokens)) };
    card.cSats = Math.round(1000 * r.calls.reduce((a, c) => a + c.cSats, 0)) / 1000;
    card.where = [...new Set(r.calls.map((c) => c.where).filter(Boolean))];
    const ttfts = r.calls.map((c) => c.ttftMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
    card.ttftMs = { first: r.calls[0]?.ttftMs ?? null, p50: ttfts[Math.floor(ttfts.length / 2)] ?? null, max: ttfts.at(-1) ?? null };
    card.callErrors = r.calls.map((c) => c.error).filter(Boolean);
    card.toolErrors = r.toolErrors.slice(0, 20);
    card.trace = r.trace?.slice(-40);
    card.failureModes = acc.passed ? [] : failureModes(r, acc);
    card.finalText = r.text.slice(-800);
    const outDir = join(DIR, "runs", RUN);
    mkdirSync(outDir, { recursive: true });
    if (acc.changed.length) {
      git(wt, "add", "-A", "--", ...acc.changed);
      writeFileSync(join(outDir, `${job.id}-${n}.diff`), git(wt, "diff", "--cached"));
    }
    if (acc.passed && job.output && existsSync(join(wt, job.output))) copyFileSync(join(wt, job.output), join(outDir, `${job.id}-${job.output.split("/").pop()}`));
    if (acc.passed && COMMIT && job.commit !== false) {
      const where = card.where.length ? card.where.join(", ") : TIERS[tier].label;
      const checks = acc.checks.map((c) => c.kind === "vitest" ? `vitest ${c.testsPassed} passed` : c.kind === "tsc" ? `tsc clean${c.files ? " (test file)" : ""}` : c.kind === "grep" ? `grep ${c.file}` : c.kind).join(", ");
      const msg = `${job.title}\n\nDone by the EdgeCoder network: model ${model} (tier ${tier}, ran on ${where}),\ndriven by the IDE agent loop (${r.via}), dogfood job ${job.id}, attempt ${n}.\nPassed the acceptance checks: ${checks || "diff limited to allowed paths"}.\nReviewed by nobody yet: check before merging.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01MUkD5bLaq2ZfyAYXZLm2ne\n`;
      execFileSync("git", ["-c", "user.name=EdgeCoder dogfood", "-c", "user.email=dogfood@edgecoder.invalid", "commit", "-q", "-F", "-"], { cwd: wt, input: msg });
      let target = `dogfood/${job.id}`;
      for (let i = 2; sh("git", ["rev-parse", "--verify", "-q", target], REPO).code === 0; i++) target = `dogfood/${job.id}-${i}`;
      git(REPO, "fetch", "-q", base, `${branch}:${target}`);
      card.branch = target;
      card.commit = git(REPO, "rev-parse", "--short", target);
    }
  } catch (e) {
    card.passed = false;
    card.failureModes = ["runner_error"];
    card.runnerError = String((e as Error).message ?? e).slice(0, 400);
  } finally {
    card.wallMs = Date.now() - t0;
    try { git(base, "worktree", "remove", "--force", wt); } catch { rmSync(wt, { recursive: true, force: true }); }
    try { git(base, "branch", "-D", branch); } catch {}
  }
  return card;
}

/** The newest failed CI run of each open PR (read-only gh), the failed steps' log tails. */
function failedCiLogs(label: string, limit: number): string {
  const prs = JSON.parse(sh("gh", ["pr", "list", "--state", "open", "--limit", "20", "--json", "number,title,headRefName"], REPO, 60_000).out || "[]") as Array<{ number: number; title: string; headRefName: string }>;
  const parts: string[] = [];
  for (const pr of prs) {
    if (parts.length >= limit) break;
    const runs = JSON.parse(sh("gh", ["run", "list", "--branch", pr.headRefName, "--status", "failure", "--limit", "1", "--json", "databaseId,name,createdAt"], REPO, 60_000).out || "[]") as Array<{ databaseId: number; name: string; createdAt: string }>;
    if (!runs.length) continue;
    const logText = sh("gh", ["run", "view", String(runs[0].databaseId), "--log-failed"], REPO, 120_000).out;
    const lines = logText.split("\n").map((l) => l.replace(/^[^\t]*\t[^\t]*\t\S+\s/, "")).filter((l) => /error|fail|✗|×|expected|Error/i.test(l)).slice(-40);
    parts.push(`PR #${pr.number} "${pr.title}" (branch ${pr.headRefName}), failed run "${runs[0].name}" at ${runs[0].createdAt}:\n${lines.join("\n").slice(-2_500)}`);
  }
  return `--- ${label}\n${parts.length ? parts.join("\n\n") : "(no open PR has a failed run)"}`;
}

// ---------------------------------------------------------------------------- capacity
/** Slots per model: the coordinators' /admin/network (admin token on this host), else /v1/models (present or not). */
let capCache: { atMs: number; models: Record<string, { slots: number; freeSlots: number }> | null } = { atMs: 0, models: null };
async function capacity(): Promise<Record<string, { slots: number; freeSlots: number }> | null> {
  if (Date.now() - capCache.atMs < 60_000) return capCache.models;
  let models: Record<string, { slots: number; freeSlots: number }> | null = null;
  try {
    const { fetchCapacity } = await import(join(REPO, "scripts/loadgen/capacity.mjs"));
    models = (await fetchCapacity())?.models ?? null;
  } catch {}
  if (!models) {
    try {
      const r = await fetch(`${API}/v1/models`, { headers: { authorization: `Bearer ${KEY}`, "user-agent": "edgecoder-dogfood/1.0" }, signal: AbortSignal.timeout(20_000) });
      const ids: string[] = ((await r.json()).data ?? []).map((m: any) => String(m.id));
      models = Object.fromEntries(ids.filter((id) => id.startsWith("network/")).map((id) => [id.slice(8).split("@")[0], { slots: 1, freeSlots: 1 }]));
    } catch {}
  }
  capCache = { atMs: Date.now(), models };
  return models;
}
const tierKey = (t: TierName) => TIERS[t].ideModel;
/** How many jobs a tier may run at once: its model's slots, at most 2; 0 when nobody holds it. */
export function tierLimit(t: TierName, models: Record<string, { slots: number }> | null): number {
  if (!models) return 1;
  return Math.min(2, models[tierKey(t)]?.slots ?? 0);
}

// ---------------------------------------------------------------------------- queue
async function main() {
  const jobsDir = join(REPO, "scripts/dogfood/jobs");
  const only = flag("jobs")?.split(",");
  const jobs: Job[] = readdirSync(jobsDir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(jobsDir, f), "utf8"))).filter((j: Job) => !only || only.includes(j.id));
  for (const j of jobs) for (const k of ["id", "title", "job", "instructions", "acceptance", "allowedPaths"]) if (!(k in j)) throw new Error(`job ${j.id ?? "?"}: missing ${k}`);
  log("DOGFOOD_START", { jobs: jobs.map((j) => ({ id: j.id, tier: tierFor(j) })), maxParallel: MAX_PARALLEL, via: VIA, dir: DIR, commit: COMMIT });
  if (DRY) return;
  mkdirSync(join(DIR, "runs", RUN), { recursive: true });
  const base = join(DIR, `base-${RUN}`);
  rmSync(base, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", "--depth", "1", UPSTREAM, base], { stdio: "ignore", timeout: 600_000 });
  execFileSync("git", ["remote", "remove", "origin"], { cwd: base });
  appendFileSync(join(base, ".git/info/exclude"), "\nnode_modules\n");
  // The commits land in this repository, so its object store needs the base commit.
  const baseCommit = git(base, "rev-parse", "HEAD");
  if (sh("git", ["cat-file", "-e", `${baseCommit}^{commit}`], REPO).code !== 0) sh("git", ["fetch", "-q", "origin"], REPO, 300_000);

  const summaryFile = join(DIR, "runs", RUN, "summary.json");
  const results: any[] = [];
  const writeSummary = () => {
    const done = results.filter((r) => r.final);
    writeFileSync(summaryFile, JSON.stringify({ run: RUN, updatedAt: new Date().toISOString(), jobs: jobs.length, done: done.length, passed: done.filter((r) => r.passed).length, results }, null, 2));
  };
  type Item = { job: Job; tier: TierName; n: number };
  const queue: Item[] = jobs.map((j) => ({ job: j, tier: tierFor(j), n: 1 }));
  const busyTiers = new Map<TierName, number>();
  const running = new Set<Promise<void>>();
  let stopped: string | null = null;
  const contextCache = new Map<string, string[]>();
  const contextFor = (job: Job) => {
    if (!contextCache.has(job.id)) {
      const blocks = (job.context ?? []).map((c) => {
        if (c.builtin === "failed-ci-logs") return failedCiLogs(c.label, c.limit ?? 3);
        if (!c.cmd || !contextCommandAllowed(c.cmd)) return `--- ${c.label}: (command not allowed: read-only gh only)`;
        const out = sh(c.cmd[0], c.cmd.slice(1), REPO, 120_000).out;
        return `--- ${c.label}${out.length > 8_000 ? " (last 8000 characters)" : ""}\n${out.slice(-8_000)}`;
      });
      contextCache.set(job.id, blocks);
    }
    return contextCache.get(job.id)!;
  };
  while (queue.length || running.size) {
    const busy = machineBusy();
    if (busy && !stopped) { stopped = busy; log("DOGFOOD_STOP", { reason: busy, queued: queue.map((q) => q.job.id) }); }
    const caps = await capacity();
    // A tier nobody serves right now: move its jobs up (not an attempt); none above: fail them.
    for (const q of [...queue]) {
      if (tierLimit(q.tier, caps) > 0 || process.env.DOGFOOD_AUTO === "1") continue;
      const up = STRONGER[q.tier];
      if (up !== q.tier) { log("DOGFOOD_REROUTE", { job: q.job.id, from: q.tier, to: up, reason: `no machine has ${tierKey(q.tier)}` }); q.tier = up; }
    }
    const i = stopped ? -1 : queue.findIndex((q) => (busyTiers.get(q.tier) ?? 0) < Math.max(1, tierLimit(q.tier, caps)));
    if (i >= 0 && running.size < MAX_PARALLEL) {
      const [item] = queue.splice(i, 1);
      busyTiers.set(item.tier, (busyTiers.get(item.tier) ?? 0) + 1);
      log("DOGFOOD_JOB_START", { job: item.job.id, tier: item.tier, attempt: item.n });
      const p = (async () => {
        const card = await attempt(item.job, item.tier, item.n, base, contextFor(item.job));
        busyTiers.set(item.tier, (busyTiers.get(item.tier) ?? 1) - 1);
        const final = card.passed || item.n >= 2;
        card.final = final;
        if (!final) {
          // Escalation: once more on a stronger tier.
          queue.push({ job: item.job, tier: STRONGER[item.tier], n: item.n + 1 });
        }
        results.push(card);
        appendFileSync(join(DIR, "runs", RUN, "scorecard.jsonl"), JSON.stringify(card) + "\n");
        writeSummary();
        const { list: _l, ...appr } = card.approvals ?? {};
        log("DOGFOOD_JOB", { job: card.job, attempt: card.attempt, tier: card.tier, model: card.model, via: card.via, passed: card.passed, final, branch: card.branch, reason: card.reason, failureModes: card.failureModes, modelCalls: card.modelCalls, toolCalls: card.toolCalls, approvals: appr, tokens: card.tokens, cSats: card.cSats, wallSec: Math.round(card.wallMs / 1000), ttftMs: card.ttftMs, where: card.where, runnerError: card.runnerError });
      })();
      running.add(p);
      void p.finally(() => running.delete(p));
      continue;
    }
    if (stopped && !running.size) break;
    if (running.size) await Promise.race(running);
    else if (queue.length) await new Promise((r) => setTimeout(r, 5_000));
  }
  writeSummary();
  rmSync(base, { recursive: true, force: true });
  const done = results.filter((r) => r.final);
  log("DOGFOOD_DONE", { jobs: jobs.length, finished: done.length, passed: done.filter((r) => r.passed).length, stopped, branches: done.filter((r) => r.branch).map((r) => r.branch), summary: summaryFile });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
