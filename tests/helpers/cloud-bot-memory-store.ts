// An in-memory CloudBotStore with the Postgres store's rules: claims are atomic (no await inside),
// one queued and one running run per bot, at most N running per account, every read by user.
import { randomUUID } from "node:crypto";
import type { ClaimedRun, CloudBotPatch, CloudBotStore, GithubPollState, NewCloudBot } from "../../src/portal/cloud-bots/store.js";
import type { CloudBot, CloudMessage, CloudRun } from "../../src/portal/cloud-bots/types.js";

interface BotRow extends CloudBot {
  tokenSealed: string | null;
  nextPollAtMs: number | null;
  githubState: GithubPollState | null;
}
interface RunRow extends CloudRun {
  leaseUntilMs: number | null;
  cancel: boolean;
}

export class MemoryCloudBotStore implements CloudBotStore {
  bots = new Map<string, BotRow>();
  messages: CloudMessage[] = [];
  runs: RunRow[] = [];
  private seq = 0;

  private view(b: BotRow): CloudBot {
    const { tokenSealed, nextPollAtMs: _p, githubState: _g, ...rest } = b;
    return structuredClone({ ...rest, hasGithubToken: tokenSealed !== null });
  }
  private runView(r: RunRow): CloudRun {
    const { leaseUntilMs: _l, cancel: _c, ...rest } = r;
    return { ...rest };
  }

  async createBot(b: NewCloudBot) {
    const same = [...this.bots.values()].find((x) => x.userId === b.userId && x.requestId === b.requestId);
    if (same) return { bot: this.view(same), created: false };
    const row: BotRow = { id: b.id, userId: b.userId, requestId: b.requestId, name: b.name, role: b.role, instructions: b.instructions, compute: b.compute, config: structuredClone(b.config), hasGithubToken: false, paused: false, nextRunAtMs: b.nextRunAtMs, createdAtMs: b.nowMs, updatedAtMs: b.nowMs, tokenSealed: b.githubTokenSealed, nextPollAtMs: b.nextPollAtMs, githubState: null };
    this.bots.set(b.id, row);
    return { bot: this.view(row), created: true };
  }
  async countBots(userId: string) {
    return [...this.bots.values()].filter((b) => b.userId === userId).length;
  }
  async listBots(userId: string) {
    return [...this.bots.values()].filter((b) => b.userId === userId).map((b) => this.view(b));
  }
  async getBot(userId: string, botId: string) {
    const b = this.bots.get(botId);
    return b && b.userId === userId ? this.view(b) : null;
  }
  async updateBot(userId: string, botId: string, p: CloudBotPatch, nowMs: number) {
    const b = this.bots.get(botId);
    if (!b || b.userId !== userId) return null;
    if (p.name !== undefined) b.name = p.name;
    if (p.role !== undefined) b.role = p.role;
    if (p.instructions !== undefined) b.instructions = p.instructions;
    if (p.compute !== undefined) b.compute = p.compute;
    if (p.config !== undefined) b.config = structuredClone(p.config);
    if (p.paused !== undefined) b.paused = p.paused;
    if (p.githubTokenSealed !== undefined) b.tokenSealed = p.githubTokenSealed;
    if (p.nextRunAtMs !== undefined) b.nextRunAtMs = p.nextRunAtMs;
    if (p.nextPollAtMs !== undefined) b.nextPollAtMs = p.nextPollAtMs;
    if (p.resetGithubState) b.githubState = null;
    b.updatedAtMs = nowMs;
    return this.view(b);
  }
  async deleteBot(userId: string, botId: string) {
    const b = this.bots.get(botId);
    if (!b || b.userId !== userId) return false;
    this.bots.delete(botId);
    this.messages = this.messages.filter((m) => m.botId !== botId);
    this.runs = this.runs.filter((r) => r.botId !== botId);
    return true;
  }
  async getGithubTokenSealed(botId: string) {
    return this.bots.get(botId)?.tokenSealed ?? null;
  }
  async getGithubState(botId: string) {
    return structuredClone(this.bots.get(botId)?.githubState ?? null);
  }
  async saveGithubState(botId: string, state: GithubPollState) {
    const b = this.bots.get(botId);
    if (b) b.githubState = structuredClone(state);
  }
  async addMessage(m: Omit<CloudMessage, "id"> & { id?: string }) {
    const row = { ...m, id: m.id ?? `cm-${randomUUID()}` } as CloudMessage;
    this.messages.push(row);
    return row;
  }
  async listMessages(userId: string, botId: string, opts: { limit: number; beforeMs?: number; beforeId?: string }) {
    let all = this.messages.filter((m) => m.userId === userId && m.botId === botId);
    if (opts.beforeMs !== undefined) {
      const idx = all.findIndex((m) => m.id === opts.beforeId);
      all = idx >= 0 ? all.slice(0, idx) : all.filter((m) => m.createdAtMs < opts.beforeMs!);
    }
    return { items: all.slice(-opts.limit), more: all.length > opts.limit };
  }
  async countMessages(botId: string) {
    return this.messages.filter((m) => m.botId === botId).length;
  }
  async getMessage(userId: string, messageId: string) {
    return this.messages.find((m) => m.userId === userId && m.id === messageId) ?? null;
  }
  async enqueueRun(input: { userId: string; botId: string; trigger: string; source: string; nowMs: number }) {
    const q = this.runs.find((r) => r.botId === input.botId && r.status === "queued");
    if (q) return { runId: q.id, created: false };
    const id = `cr-${++this.seq}-${randomUUID().slice(0, 8)}`;
    this.runs.push({ id, botId: input.botId, userId: input.userId, trigger: input.trigger, source: input.source, status: "queued", createdAtMs: input.nowMs, startedAtMs: null, endedAtMs: null, cSats: 0, summary: "", error: null, activity: null, where: null, leaseUntilMs: null, cancel: false });
    return { runId: id, created: true };
  }
  async claimRuns(input: { nowMs: number; leaseMs: number; limit: number; maxPerAccount: number }) {
    const out: ClaimedRun[] = [];
    for (const r of this.runs) {
      if (out.length >= input.limit) break;
      if (r.status !== "queued") continue;
      if (this.runs.some((x) => x.botId === r.botId && x.status === "running")) continue;
      if (this.runs.filter((x) => x.userId === r.userId && x.status === "running").length >= input.maxPerAccount) continue;
      const bot = this.bots.get(r.botId);
      if (!bot) continue;
      r.status = "running";
      r.startedAtMs = input.nowMs;
      r.leaseUntilMs = input.nowMs + input.leaseMs;
      out.push({ run: this.runView(r), bot: this.view(bot) });
    }
    return out;
  }
  async touchRun(runId: string, input: { leaseUntilMs: number; activity?: string | null; cSats?: number; where?: string | null }) {
    const r = this.runs.find((x) => x.id === runId);
    if (r) {
      r.leaseUntilMs = input.leaseUntilMs;
      if (input.activity) r.activity = input.activity;
      if (input.cSats !== undefined) r.cSats = input.cSats;
      if (input.where) r.where = input.where;
    }
    return { cancelRequested: !!r?.cancel, botExists: !!r && this.bots.has(r.botId) };
  }
  async finishRun(runId: string, input: { status: CloudRun["status"]; endedAtMs: number; cSats: number; summary: string; error?: string | null; where?: string | null }) {
    const r = this.runs.find((x) => x.id === runId);
    if (!r) return;
    Object.assign(r, { status: input.status, endedAtMs: input.endedAtMs, cSats: input.cSats, summary: input.summary, error: input.error ?? null, activity: null, leaseUntilMs: null });
    if (input.where) r.where = input.where;
  }
  async expireRuns(nowMs: number) {
    const out: CloudRun[] = [];
    for (const r of this.runs) {
      if (r.status === "running" && (r.leaseUntilMs ?? 0) < nowMs) {
        Object.assign(r, { status: "interrupted", endedAtMs: nowMs, error: "interrupted" });
        out.push(this.runView(r));
      }
    }
    return out;
  }
  async requestCancel(userId: string, botId: string) {
    let any = false;
    for (const r of this.runs) {
      if (r.userId !== userId || r.botId !== botId) continue;
      if (r.status === "running") (r.cancel = true), (any = true);
      if (r.status === "queued") r.status = "cancelled";
    }
    return any;
  }
  async getRun(userId: string, runId: string) {
    const r = this.runs.find((x) => x.id === runId && x.userId === userId);
    return r ? this.runView(r) : null;
  }
  async listRuns(userId: string, botId: string, limit: number) {
    return this.runs.filter((r) => r.userId === userId && r.botId === botId).slice(-limit).reverse().map((r) => this.runView(r));
  }
  async activeRun(botId: string) {
    const r = this.runs.find((x) => x.botId === botId && x.status === "running") ?? this.runs.find((x) => x.botId === botId && x.status === "queued");
    return r ? this.runView(r) : null;
  }
  async usageSince(botId: string, sinceMs: number) {
    const rs = this.runs.filter((r) => r.botId === botId && r.createdAtMs >= sinceMs && r.status !== "cancelled");
    return { cSats: rs.reduce((a, r) => a + r.cSats, 0), ownRuns: rs.filter((r) => r.trigger !== "message").length, runs: rs.length };
  }
  async claimDueSchedules(nowMs: number, limit: number, next: (bot: CloudBot) => number | null) {
    const due = [...this.bots.values()].filter((b) => !b.paused && b.nextRunAtMs !== null && b.nextRunAtMs <= nowMs).slice(0, limit);
    for (const b of due) b.nextRunAtMs = next(this.view(b));
    return due.map((b) => this.view(b));
  }
  async claimDuePolls(nowMs: number, limit: number, intervalMs: number) {
    const due = [...this.bots.values()].filter((b) => !b.paused && b.tokenSealed && b.nextPollAtMs !== null && b.nextPollAtMs <= nowMs).slice(0, limit);
    for (const b of due) b.nextPollAtMs = nowMs + intervalMs;
    return due.map((b) => this.view(b));
  }
}
