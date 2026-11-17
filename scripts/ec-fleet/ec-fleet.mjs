#!/usr/bin/env node
// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * ec-fleet: run EdgeCoder's own coding agent as a fleet of workers, driven from a supervising
 * session (e.g. Claude Code). Each worker is a published EdgeCoder session in its own git worktree
 * on its own ec/<slug> branch; it implements a task, commits, pushes its branch and opens a draft PR.
 *
 * Talks to the desktop app's local provider (sessions API, src/apps/ide/session-routes.ts) with the
 * IDE token, exactly like `edgecoder code` (src/terminal/client.ts): `Authorization: Bearer <token>`
 * from $IDE_PROVIDER_TOKEN or ~/.edgecoder/ide-token. The token is never printed or written anywhere.
 *
 * State: <repo>/.claude/ec-fleet/<slug>.json (git-ignored). See USAGE in args.mjs.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROVIDER, USAGE, UsageError, buildPrompt, parseCli } from "./args.mjs";
import { classifyApproval, describeCall } from "./policy.mjs";

// ---------------------------------------------------------------------------
// Provider client
// ---------------------------------------------------------------------------

export function readToken(env = process.env) {
  const fromEnv = (env.IDE_PROVIDER_TOKEN ?? "").trim();
  if (fromEnv) return fromEnv;
  const path = join(homedir(), ".edgecoder", "ide-token");
  if (!existsSync(path)) throw new Error("No IDE token: ~/.edgecoder/ide-token is missing. Open the EdgeCoder desktop app once (it creates the token), or set IDE_PROVIDER_TOKEN.");
  const t = readFileSync(path, "utf8").trim();
  if (!t) throw new Error("~/.edgecoder/ide-token is empty.");
  return t;
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class Provider {
  constructor(baseUrl, token, client) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.#token = token;
    this.client = client;
  }
  #token;

  async req(method, path, body) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.#token}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        ...(method === "POST" ? { body: JSON.stringify({ ...this.client, ...(body ?? {}) }) } : {}),
      });
    } catch (err) {
      throw new ApiError(0, "unreachable", `Couldn't reach the EdgeCoder provider at ${this.baseUrl} (is the desktop app running?): ${err.message}`);
    }
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { message: text.slice(0, 300) };
    }
    if (!res.ok) {
      const msg = typeof json.message === "string" ? json.message : res.status === 401 ? "The provider refused the IDE token (~/.edgecoder/ide-token)." : `${method} ${path} failed (${res.status})`;
      throw new ApiError(res.status, json.error ?? `http_${res.status}`, msg);
    }
    return json;
  }

  list() {
    return this.req("GET", "/v1/ide/sessions").then((r) => r.sessions);
  }
  snapshot(id) {
    return this.req("GET", `/v1/ide/sessions/${id}`);
  }
  create(input) {
    return this.req("POST", "/v1/ide/sessions", input);
  }
  send(id, text) {
    return this.req("POST", `/v1/ide/sessions/${id}/messages`, { text });
  }
  approve(id, callId, approved) {
    return this.req("POST", `/v1/ide/sessions/${id}/approve`, { callId, approved, always: false });
  }
  trust(id) {
    return this.req("POST", `/v1/ide/sessions/${id}/trust`, { trusted: true });
  }
  cancel(id) {
    return this.req("POST", `/v1/ide/sessions/${id}/cancel`, {});
  }
  remove(id) {
    return this.req("POST", `/v1/ide/sessions/${id}/delete`, {});
  }

  /** Server-sent events after `since`; calls onEvent(ev) until it returns "stop" or the signal aborts. Reconnects. */
  async stream(id, since, onEvent, signal) {
    let last = since;
    for (let attempt = 0; !signal.aborted; attempt++) {
      const q = new URLSearchParams({ since: String(last), clientId: this.client.clientId, kind: this.client.kind, label: this.client.label });
      let res;
      try {
        res = await fetch(`${this.baseUrl}/v1/ide/sessions/${id}/events?${q}`, { headers: { authorization: `Bearer ${this.#token}`, accept: "text/event-stream" }, signal });
      } catch (err) {
        if (signal.aborted) return last;
        if (attempt > 20) throw err;
        await sleep(Math.min(5000, 500 * (attempt + 1)));
        continue;
      }
      if (!res.ok || !res.body) throw new ApiError(res.status, `http_${res.status}`, `event stream failed (${res.status})`);
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
            if (!data) continue;
            let ev;
            try {
              ev = JSON.parse(data);
            } catch {
              continue;
            }
            if (typeof ev.seq === "number") last = Math.max(last, ev.seq);
            if ((await onEvent(ev)) === "stop") return last;
          }
        }
      } catch (err) {
        if (signal.aborted) return last;
        if (attempt > 20) throw err;
      }
      await sleep(500);
    }
    return last;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Repo, worktrees, state
// ---------------------------------------------------------------------------

function git(cwd, args, opts = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: opts.timeout ?? 60_000 }).trim();
}

/** The main checkout's root (state lives there, worktrees go under it), from any worktree of the repo. */
export function repoRoot(start) {
  const dir = resolve(start ?? process.cwd());
  const common = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return basename(common) === ".git" ? dirname(common) : git(dir, ["rev-parse", "--show-toplevel"]);
}

const stateDir = (root) => join(root, ".claude", "ec-fleet");
const statePath = (root, slug) => join(stateDir(root), `${slug}.json`);

function loadState(root, slug) {
  const p = statePath(root, slug);
  if (!existsSync(p)) throw new Error(`No fleet session "${slug}" (${p} doesn't exist). Start one with ec-fleet start.`);
  return JSON.parse(readFileSync(p, "utf8"));
}

function saveState(root, st) {
  mkdirSync(stateDir(root), { recursive: true });
  writeFileSync(statePath(root, st.slug), `${JSON.stringify({ ...st, updatedAt: Date.now() }, null, 2)}\n`);
}

function allStates(root) {
  if (!existsSync(stateDir(root))) return [];
  return readdirSync(stateDir(root))
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(stateDir(root), f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter((s) => s && s.slug);
}

/** Keep fleet files out of `git status`: the state dir and worktree node_modules symlinks. */
function ensureExcludes(root) {
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const p = join(common, "info", "exclude");
  mkdirSync(dirname(p), { recursive: true });
  const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
  const want = ["/.claude/ec-fleet/", "/node_modules"].filter((l) => !cur.split("\n").includes(l));
  if (want.length) appendFileSync(p, `${cur && !cur.endsWith("\n") ? "\n" : ""}# ec-fleet\n${want.join("\n")}\n`);
}

function clientFor(slug) {
  return { clientId: `ec-fleet-${slug ?? "cli"}`.slice(0, 100), kind: "api", label: "ec-fleet (supervisor)" };
}

function provider(slug) {
  return new Provider(process.env.EC_FLEET_PROVIDER || DEFAULT_PROVIDER, readToken(), clientFor(slug));
}

function currentBranch(worktree) {
  try {
    const b = git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return b === "HEAD" ? undefined : b;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

function short(s, n = 160) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function callLine(e) {
  return `${e.requires_approval ? "?" : "→"} ${describeCall({ tool: e.tool, args: e.args })}`;
}

export function usageLine(e) {
  const where = e.where ?? "?";
  const served = e.served ? ` · ${e.served.label}${e.served.region ? ` (${e.served.region})` : ""}${e.served.outputTokens ? ` · ${e.served.promptTokens ?? "?"}→${e.served.outputTokens} tok` : ""}` : "";
  return `$ ${Number(e.cSats ?? 0).toFixed(3)} cSats @ ${where}${e.model ? ` · ${e.model}` : ""}${e.usd ? ` · ~$${e.usd.toFixed(4)} own key` : ""}${served}`;
}

/** Where a session's model calls ran: { "network": n, "frontier": n, ... } from its transcript. */
export function placements(session) {
  const out = {};
  for (const t of session.transcript ?? []) {
    for (const c of t.usage?.calls ?? []) {
      const k = c.served?.computeClass === "frontier" ? "frontier" : (c.where ?? "?");
      out[k] = (out[k] ?? 0) + 1;
    }
  }
  return out;
}

function elapsed(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

/** Mark a PR as a draft when it isn't one (open_pull_request / github_create_pr can't open drafts). */
function ensureDraft(url, cwd) {
  try {
    const isDraft = execFileSync("gh", ["pr", "view", url, "--json", "isDraft", "-q", ".isDraft"], { cwd, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (isDraft === "false") {
      execFileSync("gh", ["pr", "ready", "--undo", url], { cwd, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
      return "converted to draft";
    }
    return isDraft === "true" ? "draft" : "unknown";
  } catch (err) {
    return `couldn't check draft state: ${short(err.stderr || err.message, 120)}`;
  }
}

function findPr(branch, cwd) {
  try {
    const out = execFileSync("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "url", "-q", ".[0].url"], { cwd, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    return PR_URL.test(out) ? out : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/**
 * Answer pending approvals by policy. apply=false only reports. Returns the calls left for a human.
 */
async function handlePending(p, st, snap, { apply, log }) {
  const ctx = { worktree: st.worktree, branch: st.branch, currentBranch: currentBranch(st.worktree) };
  const left = [];
  for (const call of snap.pending ?? []) {
    const v = classifyApproval(call, ctx);
    const what = describeCall(call);
    if (apply && v.decision === "approve") {
      const r = await p.approve(st.sessionId, call.id, true);
      log(`  approved  ${what}  (${v.reason})${r.applied === false ? " [already answered]" : ""}`);
    } else if (apply && v.decision === "refuse") {
      const r = await p.approve(st.sessionId, call.id, false);
      log(`  REFUSED   ${what}  (${v.reason})${r.applied === false ? " [already answered]" : ""}`);
    } else {
      left.push({ call, verdict: v });
      log(`  ${v.decision === "refuse" ? "would refuse" : v.decision === "approve" ? "would approve" : "PENDING  "} [${call.id}] ${what}  (${v.reason})`);
    }
  }
  return left;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdStart(o, log) {
  const root = repoRoot(o.repo);
  const taskText = existsSync(o.task) && statSync(o.task).isFile() ? readFileSync(o.task, "utf8") : o.task;
  const worktree = join(root, ".claude", "worktrees", `ec-${o.slug}`);
  const trailersFile = join(stateDir(root), "trailers.txt");
  const trailers = o.trailers.length ? o.trailers : existsSync(trailersFile) ? readFileSync(trailersFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : [];
  const prompt = buildPrompt({ task: taskText, branch: o.branch, worktree, trailers });
  if (o.dryRun) {
    log(`dry run: worktree ${worktree} on ${o.branch} from ${o.base}; lead ${o.lead}, worker ${o.worker}, mode ${o.mode}\n--- prompt ---\n${prompt}`);
    return 0;
  }
  if (existsSync(statePath(root, o.slug))) throw new Error(`Fleet session "${o.slug}" already exists (${statePath(root, o.slug)}). Use send, or stop --cleanup it first.`);
  if (existsSync(worktree)) throw new Error(`${worktree} already exists.`);
  const p = provider(o.slug);
  // At most N fleet sessions working at once on this computer.
  const sessions = await p.list();
  const mine = new Set(allStates(root).filter((s) => s.status !== "stopped").map((s) => s.sessionId));
  const busy = sessions.filter((s) => mine.has(s.id) && (s.running || s.pending > 0));
  if (busy.length >= o.maxConcurrent) throw new Error(`${busy.length} fleet session(s) are already working (max ${o.maxConcurrent}): ${busy.map((s) => s.title).join(", ")}. Wait for one to go idle.`);

  log(`fetching origin…`);
  git(root, ["fetch", "-q", "origin"], { timeout: 120_000 });
  try {
    git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${o.branch}`]);
    throw new Error(`Branch ${o.branch} already exists locally; pick another slug.`);
  } catch (err) {
    if (err.message.startsWith("Branch ")) throw err;
  }
  git(root, ["worktree", "add", "--no-track", "-b", o.branch, worktree, o.base]);
  ensureExcludes(root);
  const nm = o.nodeModules ? resolve(o.nodeModules) : join(root, "node_modules");
  if (existsSync(nm)) symlinkSync(nm, join(worktree, "node_modules"));
  log(`worktree ${worktree} on ${o.branch} (${git(worktree, ["rev-parse", "--short", "HEAD"])})${existsSync(nm) ? `, node_modules -> ${nm}` : ""}`);

  const st = { slug: o.slug, branch: o.branch, worktree, repo: root, lead: o.lead, worker: o.worker, mode: o.mode, title: o.title, createdAt: Date.now(), status: "starting", lastSeq: 0, prUrl: null, task: short(taskText, 400) };
  saveState(root, st);
  const snap = await p.create({ projectRoot: worktree, model: o.lead, workerModel: o.worker, title: o.title, mode: o.mode, published: true });
  st.sessionId = snap.session.id;
  saveState(root, st);
  if (!snap.trusted) await p.trust(st.sessionId);
  const sent = await p.send(st.sessionId, prompt);
  st.status = "running";
  st.turns = 1;
  saveState(root, st);
  log(`session ${st.sessionId} (published; watch it in the app) · lead ${snap.session.compute?.target === "frontier" ? o.lead : `${o.lead} -> ${snap.session.compute?.target}`} · worker ${o.worker} · turn ${sent.turnId ?? "queued"}`);
  log(`next: ec-fleet watch ${o.slug} --approve`);
  return 0;
}

async function cmdWatch(o, log) {
  const root = repoRoot(o.repo);
  const st = loadState(root, o.slug);
  const p = provider(o.slug);
  const since = o.since ?? st.lastSeq ?? 0;
  const ctl = new AbortController();
  let exitCode = 0;
  const timer = setTimeout(() => {
    exitCode = 4;
    log(`timeout after ${o.timeoutMin}m (session keeps running)`);
    ctl.abort();
  }, o.timeoutMin * 60_000);
  let text = "";
  let checking = false;
  const flushText = (final) => {
    const t = text.trim();
    text = "";
    if (!t) return;
    log(final || o.verbose ? `\n${t.length > 6000 ? `${t.slice(0, 6000)}…` : t}\n` : `  “${short(t, 200)}”`);
  };
  const notePr = (s) => {
    const m = PR_URL.exec(String(s ?? ""));
    if (m && st.prUrl !== m[0]) {
      st.prUrl = m[0];
      log(`PR ${st.prUrl} (${ensureDraft(st.prUrl, st.worktree)})`);
      saveState(root, st);
    }
  };
  const checkPending = async () => {
    if (checking) return null;
    checking = true;
    try {
      await sleep(600); // the provider answers "always" calls itself first
      const snap = await p.snapshot(st.sessionId);
      if (!snap.pending?.length) return null;
      const left = await handlePending(p, st, snap, { apply: o.approve, log });
      if (left.length) {
        log(`needs a human: ec-fleet approve ${o.slug} --call <id> [--deny]`);
        exitCode = 3;
        return "stop";
      }
      return null;
    } finally {
      checking = false;
    }
  };

  const first = await p.snapshot(st.sessionId);
  log(`watching ${o.slug} (${first.session.title}) from #${since}; running: ${first.running ? "yes" : "no"}, pending: ${first.pending.length}`);
  if (first.pending.length && (await checkPending()) === "stop") {
    clearTimeout(timer);
    return exitCode;
  }
  if (!first.running && !first.queue.length && first.seq <= since) {
    clearTimeout(timer);
    log(`idle · ${Number(first.session.cSats).toFixed(3)} cSats`);
    return 0;
  }

  const last = await p.stream(
    st.sessionId,
    since,
    async (ev) => {
      if (ev.type === "agent") {
        const e = ev.event ?? {};
        if (e.type === "text") {
          text += e.content;
          return;
        }
        if (e.type === "turn") return log(`── turn ${String(e.id).slice(0, 8)}`);
        flushText(false);
        if (e.type === "tool_call") {
          log(`  ${callLine(e)}`);
          if (e.requires_approval) return checkPending();
        } else if (e.type === "tool_result") {
          notePr(e.result);
          if (e.error) log(`    ✗ ${short(e.error, 240)}`);
          else if (o.verbose) log(`    ✓ ${short(e.result, 240)}`);
        } else if (e.type === "shell_output") {
          notePr(`${e.stdout}\n${e.stderr}`);
          log(`    exit ${e.exit_code}${e.exit_code !== 0 ? `: ${short(e.stderr || e.stdout, 240)}` : o.verbose ? `: ${short(e.stdout, 160)}` : ""}`);
        } else if (e.type === "file_change") log(`    ✎ ${e.path}`);
        else if (e.type === "status") log(`  · ${e.route ? `${e.route.label} (${e.route.reason})` : short(e.message, 200)}`);
        else if (e.type === "usage") log(`  ${usageLine(e)}`);
        return;
      }
      if (ev.type === "approval") return log(`  ${ev.approved ? "✓ approved" : "✗ denied"} [${ev.id}] by ${ev.by}${ev.label ? ` (${ev.label})` : ""}`);
      if (ev.type === "message") return log(`» ${ev.entry?.by ?? "?"}: ${short(ev.entry?.content, 160)}`);
      if (ev.type === "note") return log(`  note: ${short(ev.entry?.content, 200)}`);
      if (ev.type === "stopping") return log(`stopping (by ${ev.by})`);
      if (ev.type === "deleted") {
        exitCode = 5;
        return "stop";
      }
      if (ev.type === "turn_end") {
        flushText(true);
        const u = ev.entry?.usage;
        log(`── turn end${ev.stopped ? " (stopped)" : ""} · this turn ${Number(u?.cSats ?? 0).toFixed(3)} cSats @ ${u?.where ?? "?"} · session ${Number(ev.cSats ?? 0).toFixed(3)} cSats · branch ${ev.branch ?? "?"}${ev.entry?.changedFiles?.length ? ` · changed ${ev.entry.changedFiles.join(", ")}` : ""}`);
        notePr(ev.entry?.content);
        // A failed model call ends the turn with an error as its text (no key, no balance, no route).
        const err = /(?:^|\n)\s*Error(?: contacting model)?: ([^\n]+)\s*$/.exec(String(ev.entry?.content ?? ""));
        if (err && !ev.entry?.changedFiles?.length && !(ev.entry?.usage?.calls ?? []).length) {
          log(`model error: ${short(err[1], 300)}`);
          exitCode = 6;
        }
        const snap = await p.snapshot(st.sessionId);
        if (!snap.running && !snap.queue.length) return "stop";
      }
    },
    ctl.signal,
  );
  clearTimeout(timer);
  const snap = await p.snapshot(st.sessionId).catch(() => null);
  st.lastSeq = last;
  if (snap) {
    st.status = snap.running ? (snap.pending.length ? "needs-approval" : "running") : "idle";
    st.turns = (snap.session.transcript ?? []).filter((t) => t.role === "assistant").length;
    if (!st.prUrl) st.prUrl = findPr(st.branch, st.worktree);
  }
  saveState(root, st);
  return exitCode;
}

async function cmdApprove(o, log) {
  const root = repoRoot(o.repo);
  const st = loadState(root, o.slug);
  const p = provider(o.slug);
  const snap = await p.snapshot(st.sessionId);
  if (!snap.pending.length) {
    log("nothing pending");
    return 0;
  }
  if (o.call) {
    const call = snap.pending.find((c) => c.id === o.call);
    if (!call) throw new Error(`No pending call ${o.call}. Pending: ${snap.pending.map((c) => c.id).join(", ")}`);
    const v = classifyApproval(call, { worktree: st.worktree, branch: st.branch, currentBranch: currentBranch(st.worktree) });
    if (!o.deny && v.decision === "refuse") throw new Error(`Policy refuses this call (${v.reason}); ec-fleet won't approve it. Approve it in the app yourself if you really mean it.`);
    await p.approve(st.sessionId, call.id, !o.deny);
    log(`${o.deny ? "denied" : "approved"} ${describeCall(call)}`);
    return 0;
  }
  const left = await handlePending(p, st, snap, { apply: o.allSafe, log });
  if (!o.allSafe) log("(report only: --all-safe applies the policy, --call <id> answers one)");
  return left.length ? 3 : 0;
}

async function cmdSend(o, log) {
  const root = repoRoot(o.repo);
  const st = loadState(root, o.slug);
  const r = await provider(o.slug).send(st.sessionId, o.text);
  st.status = "running";
  saveState(root, st);
  log(r.turnId ? `sent; turn ${r.turnId}` : `queued (a turn is running): ${r.queued?.id ?? ""}`);
  return 0;
}

async function cmdStatus(o, log) {
  const root = repoRoot(o.repo);
  const states = allStates(root).filter((s) => !o.slug || s.slug === o.slug);
  if (!states.length) {
    log("no fleet sessions");
    return 0;
  }
  const p = provider();
  const rows = [];
  for (const st of states) {
    let snap = null;
    try {
      snap = await p.snapshot(st.sessionId);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    const s = snap?.session;
    const state = !snap ? (st.status === "stopped" ? "stopped" : "gone") : snap.pending.length ? `needs-approval(${snap.pending.length})` : snap.running ? "running" : st.status === "stopped" ? "stopped" : "idle";
    const pr = st.prUrl ?? findPr(st.branch, st.worktree);
    const end = snap && !snap.running ? s.updatedAt : Date.now();
    rows.push({
      slug: st.slug,
      state,
      branch: st.branch,
      pr: pr ?? null,
      cSats: s ? s.cSats : null,
      frontierUsd: s?.frontierUsd ?? 0,
      where: s ? placements(s) : {},
      turns: s ? s.transcript.filter((t) => t.role === "assistant").length : st.turns ?? 0,
      elapsed: elapsed(end - st.createdAt),
      lead: st.lead,
      sessionId: st.sessionId,
    });
  }
  if (o.json) log(JSON.stringify(rows, null, 2));
  else
    for (const r of rows) {
      const where = Object.entries(r.where).map(([k, n]) => `${k}×${n}`).join(" ") || "-";
      log(`${r.slug.padEnd(24)} ${r.state.padEnd(20)} ${r.branch.padEnd(30)} ${r.cSats === null ? "-" : `${r.cSats.toFixed(3)} cSats`}${r.frontierUsd ? ` +$${r.frontierUsd.toFixed(3)} own key` : ""}  [${where}]  ${r.turns} turns  ${r.elapsed}  ${r.pr ?? "no PR"}`);
    }
  return 0;
}

async function cmdStop(o, log) {
  const root = repoRoot(o.repo);
  const st = loadState(root, o.slug);
  const p = provider(o.slug);
  try {
    const r = await p.cancel(st.sessionId);
    log(r.stopped ? "stopped the running turn" : "no turn was running");
    if (o.cleanup) {
      await p.remove(st.sessionId);
      log("deleted the session");
    }
  } catch (err) {
    if (err.status !== 404) throw err;
    log("session already gone");
  }
  st.status = "stopped";
  if (o.cleanup && existsSync(st.worktree)) {
    try {
      git(root, ["worktree", "remove", st.worktree]);
      log(`removed worktree ${st.worktree} (branch ${st.branch} kept)`);
    } catch (err) {
      log(`kept worktree ${st.worktree}: ${short(err.stderr || err.message, 200)}`);
    }
  }
  saveState(root, st);
  return 0;
}

export async function main(argv, log = (s) => process.stdout.write(`${s}\n`)) {
  let o;
  try {
    o = parseCli(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    throw err;
  }
  if (o.command === "help") {
    log(USAGE);
    return 0;
  }
  if (o.repo && !isAbsolute(o.repo)) o.repo = resolve(o.repo);
  const run = { start: cmdStart, watch: cmdWatch, approve: cmdApprove, send: cmdSend, status: cmdStatus, stop: cmdStop }[o.command];
  try {
    return await run(o, log);
  } catch (err) {
    process.stderr.write(`ec-fleet ${o.command}: ${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
