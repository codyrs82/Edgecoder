// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The `edgecoder code` REPL: a client of one shared session on the IDE provider, co-edited with the
 * desktop app. You can type at any time: a message sent while a reply runs is queued (the next
 * turn starts with it), Esc stops the reply, Shift+Tab cycles the permission mode. Approvals ask
 * inline (Enter = yes) and close themselves when the app answers first. Slash commands work at
 * any prompt, an approval prompt included.
 */

import { nextMode, type PermissionMode } from "../apps/ide/permissions.js";
import type { ClientRef, QueuedMessage, SessionEvent, TranscriptEntry } from "../apps/ide/sessions.js";
import type { IdeStreamEvent } from "../apps/ide/tool-types.js";
import { ProviderError, type ProviderClient, type Snapshot } from "./client.js";
import { formatUsd, frontierLabel, isFrontierModelId } from "../inference-api/frontier-models.js";
import { clean, formatCSats, formatDiff, outputTail, proposedDiff, resultSummary, servedDetail, toolSummary, usageLine, type CallUsage, type Style } from "./render.js";
import { TentacleTracker, TENTACLES_HELP } from "./tentacles.js";

export interface ReplIO {
  /** One line of input after showing `prompt`; null at the end of input. */
  readLine(prompt: string): Promise<string | null>;
  /** Change the prompt shown while a line is being read (what was typed stays). */
  setPrompt?(prompt: string): void;
  write(text: string): void;
  /** Ctrl+C. */
  onInterrupt?(fn: () => void): void;
  /** Esc (stop the reply) and Shift+Tab (next permission mode). */
  onKey?(fn: (key: "escape" | "shift-tab") => void): void;
  close?(): void;
}

export interface ReplOptions {
  client: ProviderClient;
  sessionId: string;
  io: ReplIO;
  style: Style;
  /** Where the provider is ("the EdgeCoder app", "in this process"). */
  providerLabel: string;
  /** Publish to the desktop app at start (`--remote`). */
  remote?: boolean;
  /** Default model per placement for /compute. */
  defaults?: { local?: string; network?: string };
}

export const HELP = `Commands (they work at any prompt, an approval included):
  /model [name]                 show or set the model (a local tag, network/<model>[@class], auto)
  /lead [id]                    show or set the lead model, e.g. frontier/anthropic/claude-opus-5-5 (your own key)
  /worker [id]                  show or set the worker model for helpers and delegated work (default auto)
  /compute [local|network|mine|auto]   where the model runs
  /mode [ask|auto-edits|auto|plan|full]   how much to ask first (Shift+Tab cycles; full only by name)
  /approve [ask|auto-edits|auto]     approve the plan and carry it out (default auto-edits)
  /remote [off]                 show this session live in the EdgeCoder app (Code view), or stop
  /stop                         stop the reply (Esc does the same); queued messages run next
  /queue                        list queued messages; /unqueue [n] removes one (default: the last)
  /undo                         undo the files the last reply changed
  /clear                        start the conversation over
  /status                       session, project, model, mode, where the last call ran, who is connected
  /cost                         what this session has spent (cSats, and USD on your own frontier key)
  /github                       sign in to GitHub (device code)
${TENTACLES_HELP}
  /help                         this list
  /exit                         leave (the session stays; reopen it in the app or with --resume)
Modes: ask (edits and commands ask), auto-edits (edits apply, undoable; commands ask),
       auto (safe commands and edits apply; risky ones ask; dangerous ones are refused),
       plan (read-only until you approve the plan with /approve),
       full (Full access: nothing asks; only a few destructive or secret-leaking commands are
       still refused). Read-only commands never ask.
Approvals: Enter or y = yes, n = no, a = always (edits: this project; a command: a rule such as
           \`npm test:*\` for this project).
Type while a reply runs: Enter queues the message for the next turn.`;

interface Pending {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

const MODE_LABEL: Record<PermissionMode, string> = { ask: "ask", "auto-edits": "auto-edits", auto: "auto", plan: "plan", full: "full access" };
const KIND_LABEL: Record<string, string> = { terminal: "the terminal", desktop: "the EdgeCoder app", api: "a script" };

export class Repl {
  private readonly c: ProviderClient;
  private readonly io: ReplIO;
  private readonly st: Style;
  private readonly me: ClientRef;
  private snap!: Snapshot;
  private follower: { close: () => void } | null = null;
  private running = false;
  /** Approvals waiting, oldest first (any client may answer; the first answer wins). */
  private approvals: Pending[] = [];
  private answered = new Set<string>();
  private queue: QueuedMessage[] = [];
  /** Texts this terminal sent that haven't come back as a transcript message yet. */
  private mine: string[] = [];
  private atLineStart = true;
  private turnCalls: CallUsage[] = [];
  private lastCall: CallUsage | undefined;
  private cSats = 0;
  private model = "";
  private mode: PermissionMode = "ask";
  private worker = "auto";
  private usd = 0;
  private published = false;
  private clients: ClientRef[] = [];
  private exiting = false;
  private interrupts = 0;
  private badAnswerShown: string | null = null;
  /** Tentacles hook: the session's helper agents (tentacles.ts). */
  private readonly tentacles: TentacleTracker;

  constructor(private readonly o: ReplOptions) {
    this.c = o.client;
    this.io = o.io;
    this.st = o.style;
    this.me = o.client.client;
    this.tentacles = new TentacleTracker(o.style);
  }

  private out(text: string): void {
    if (!text) return;
    this.io.write(text);
    this.atLineStart = text.endsWith("\n");
  }

  private line(text: string): void {
    if (!this.atLineStart) this.out("\n");
    this.out(`${text}\n`);
  }

  private refreshPrompt(): void {
    this.io.setPrompt?.(this.prompt());
  }

  async run(): Promise<number> {
    this.snap = await this.c.snapshot(this.o.sessionId);
    this.applySnapshot(this.snap);
    this.header();
    this.follower = this.c.follow(this.o.sessionId, this.snap.seq, (e) => this.onEvent(e), {
      onDisconnect: (err) => {
        if (!this.exiting) this.line(this.st.yellow(`▸ Lost the connection to the provider (${err.message}); reconnecting…`));
      },
    });
    this.io.onInterrupt?.(() => void this.interrupt());
    this.io.onKey?.((k) => void this.key(k));
    void this.tentacles.refresh(this.c, this.o.sessionId); // tentacles hook
    if (this.o.remote) await this.command("/remote");
    // A turn already running (resuming, or one the app started): follow it, and its approvals.
    if (this.snap.running) {
      this.running = true;
      for (const p of this.snap.pending) this.addApproval(p, false);
    }
    try {
      for (;;) {
        const input = await this.io.readLine(this.prompt());
        if (input === null) break;
        if ((await this.handle(input)) === "exit") break;
      }
    } finally {
      await this.leave();
    }
    return 0;
  }

  /** One line typed at the prompt. */
  async handle(input: string): Promise<"exit" | void> {
    this.interrupts = 0;
    const text = input.trim();
    // Slash commands work at any prompt; an approval that is waiting stays waiting.
    if (text.startsWith("/")) {
      const r = await this.command(text);
      this.refreshPrompt();
      return r;
    }
    const p = this.currentApproval();
    if (p) {
      await this.answer(p, text);
      return;
    }
    if (!text) return;
    await this.say(input);
  }

  private currentApproval(): Pending | undefined {
    while (this.approvals.length && this.answered.has(this.approvals[0].id)) this.approvals.shift();
    return this.approvals[0];
  }

  prompt(): string {
    const p = this.currentApproval();
    if (p) return this.st.yellow(`  Allow ${toolSummary(p.tool, p.args)}? [Y/n/a] › `);
    const state = this.running ? this.st.dim(` · running${this.queue.length ? `, ${this.queue.length} queued` : ""} (Esc stops)`) : "";
    const tag = `[${MODE_LABEL[this.mode]}]`;
    return `${this.mode === "full" ? this.st.yellow(tag) : this.st.dim(tag)}${state} ${this.st.bold("›")} `;
  }

  private applySnapshot(s: Snapshot): void {
    this.model = modelLabel(s.session.model, s.session.compute);
    this.cSats = s.session.cSats;
    this.worker = s.session.workerModel ?? "auto";
    this.usd = s.session.frontierUsd ?? 0;
    this.published = s.session.published;
    this.clients = s.clients;
    this.mode = (s.session.mode ?? (s.session.autoApprove === "edits" ? "auto-edits" : "ask")) as PermissionMode;
    this.queue = [...(s.queue ?? [])];
  }

  private header(): void {
    const s = this.snap.session;
    const st = this.st;
    this.line(st.bold("EdgeCoder") + st.dim(` · ${this.o.providerLabel}`));
    this.line(`${st.dim("project")} ${s.projectRoot}${s.branch ? st.dim(` (${s.branch})`) : ""}`);
    this.line(`${st.dim("model  ")} ${isFrontierModelId(this.model) ? `${frontierLabel(this.model)} ${st.dim(`(lead) · worker ${this.worker}`)}` : this.model}`);
    this.line(`${st.dim("mode   ")} ${this.mode} ${st.dim("(Shift+Tab or /mode changes it)")}`);
    this.line(`${st.dim("session")} ${s.id}${s.transcript.length ? st.dim(` · ${s.transcript.length} messages`) : ""}`);
    for (const t of s.transcript.slice(-6)) this.replay(t);
    this.line(st.dim("Type a request, or /help. /remote shows this session in the EdgeCoder app; both can type at once."));
  }

  private replay(t: TranscriptEntry): void {
    const c = clean(t.content);
    if (t.role === "user") this.line(`${this.st.bold("›")} ${c}`);
    else this.line(this.st.dim(c.length > 400 ? `${c.slice(0, 400)}…` : c));
  }

  private async say(text: string): Promise<void> {
    this.mine.push(text.trim());
    try {
      const r = await this.c.send(this.o.sessionId, text);
      if (r.turnId) this.running = true;
      else if (r.queued) {
        if (!this.queue.some((q) => q.id === r.queued!.id)) this.queue.push(r.queued);
        this.line(this.st.dim(`  ▸ Queued (#${this.queue.length}): runs when the current reply ends. /unqueue removes it, Esc stops the reply.`));
      }
    } catch (err) {
      this.mine.splice(this.mine.indexOf(text.trim()), 1);
      this.line(this.st.red(errText(err)));
    }
    this.refreshPrompt();
  }

  private async answer(p: Pending, text: string): Promise<void> {
    const ans = text.toLowerCase();
    // Enter means yes.
    const choice = ans === "" || ans === "y" || ans === "yes" ? "y" : ans === "n" || ans === "no" ? "n" : ans === "a" || ans === "always" ? "a" : null;
    if (!choice) {
      if (this.badAnswerShown !== p.id) this.line(this.st.dim("  Enter or y = yes, n = no, a = always. (Slash commands work here too.)"));
      this.badAnswerShown = p.id;
      return;
    }
    this.answered.add(p.id);
    this.approvals = this.approvals.filter((q) => q.id !== p.id);
    try {
      const r = await this.c.approve(this.o.sessionId, p.id, choice !== "n", choice === "a");
      if (r.applied === false) this.line(this.st.dim("  (already answered in the other client)"));
    } catch (err) {
      this.line(this.st.red(`  ${errText(err)}`));
    }
    this.refreshPrompt();
  }

  private addApproval(p: Pending, showDiff: boolean): void {
    if (this.answered.has(p.id) || this.approvals.some((q) => q.id === p.id)) return;
    if (showDiff) {
      const diff = proposedDiff(this.snap.session.projectRoot, p.tool, p.args);
      if (diff?.length) this.line(formatDiff(diff, this.st));
      else if (p.tool === "run_shell") this.line(`    ${this.st.yellow("$")} ${clean(String(p.args.command ?? ""))}`);
    }
    this.approvals.push(p);
    this.refreshPrompt();
  }

  private who(e: SessionEvent): string {
    const label = typeof e.label === "string" ? e.label : "";
    return label || KIND_LABEL[String(e.by)] || String(e.by ?? "another client");
  }

  private onEvent(e: SessionEvent): void {
    const st = this.st;
    // Tentacles hook: their events print one status line each (tentacles.ts).
    if (TentacleTracker.handles(e)) {
      const l = this.tentacles.onEvent(e);
      if (l) this.line(l);
      return;
    }
    switch (e.type) {
      case "agent":
        this.onAgent(e.event as IdeStreamEvent);
        break;
      case "message": {
        const entry = e.entry as TranscriptEntry;
        const own = entry.by === this.me.kind && this.mine.includes(entry.content.trim());
        if (own) {
          this.mine.splice(this.mine.indexOf(entry.content.trim()), 1);
          // A queued message of ours starts now.
          if (this.queue.some((q) => q.id === entry.id)) this.line(`${st.bold("›")} ${clean(entry.content)} ${st.dim("(from the queue)")}`);
        } else this.line(`${st.magenta(`› [from ${typeof e.label === "string" ? e.label : KIND_LABEL[entry.by ?? "api"] ?? entry.by}]`)} ${clean(entry.content)}`);
        this.queue = this.queue.filter((q) => q.id !== entry.id);
        this.running = true;
        break;
      }
      case "queued": {
        const q = e.entry as QueuedMessage;
        if (!this.queue.some((x) => x.id === q.id)) this.queue.push(q);
        if (!(q.by === this.me.kind && this.mine.includes(q.text.trim()))) this.line(st.dim(`  ▸ Queued from ${q.label ?? KIND_LABEL[q.by] ?? q.by}: ${clean(q.text).slice(0, 120)}`));
        break;
      }
      case "unqueued":
        this.queue = Array.isArray(e.queue) ? (e.queue as QueuedMessage[]) : this.queue.filter((q) => q.id !== e.id);
        break;
      case "turn_end": {
        const entry = e.entry as TranscriptEntry;
        if (!this.atLineStart) this.out("\n");
        const bits: string[] = [];
        if (entry.changedFiles?.length) bits.push(`changed ${entry.changedFiles.join(", ")} (/undo reverts)`);
        if (e.stopped) bits.push("stopped");
        if (bits.length) this.line(st.dim(`  ${bits.join(" · ")}`));
        const usage = usageLine(this.turnCalls, this.model);
        if (usage) this.line(st.dim(`  ${usage}`));
        this.cSats = Number(e.cSats ?? this.cSats);
        this.turnCalls = [];
        this.running = false;
        this.approvals = [];
        break;
      }
      case "approval": {
        const id = String(e.id);
        const mineAnswer = this.answered.has(id) && e.by === this.me.kind;
        const wasWaiting = this.approvals.some((q) => q.id === id);
        this.answered.add(id);
        this.approvals = this.approvals.filter((q) => q.id !== id);
        if (e.by === "always") this.line(st.dim("  ✓ allowed (mode or an earlier \"always\")"));
        else if (e.by === "timeout") this.line(st.dim("  ✗ no answer in time: rejected"));
        else if (e.by === "stopped") {
          if (wasWaiting) this.line(st.dim("  ✗ stopped"));
        } else if (!mineAnswer) this.line(st.dim(`  ${e.approved ? "✓ approved" : "✗ rejected"} in ${this.who(e)}`));
        else this.line(st.dim(`  ${e.approved ? "✓ approved" : "✗ rejected"}`));
        break;
      }
      case "presence": {
        const before = new Set(this.clients.map((c) => c.clientId));
        this.clients = (e.clients as ClientRef[]) ?? [];
        const now = new Set(this.clients.map((c) => c.clientId));
        const changed = this.clients.some((c) => !before.has(c.clientId)) || [...before].some((id) => !now.has(id));
        if (changed) this.line(st.dim(`▸ ${this.presence()}`));
        break;
      }
      case "settings": {
        if (typeof e.model === "string") this.model = e.model;
        if (typeof e.workerModel === "string") this.worker = e.workerModel;
        if (typeof e.mode === "string") this.mode = e.mode as PermissionMode;
        if (e.byClient !== undefined && e.byClient !== this.me.clientId) {
          const changed = Array.isArray(e.changed) ? (e.changed as string[]) : [];
          const what = [changed.includes("model") ? `model → ${this.model}` : "", changed.includes("mode") || changed.includes("autoApprove") ? `mode → ${this.mode}` : "", changed.includes("title") ? "title" : ""].filter(Boolean).join(", ");
          if (what) this.line(st.dim(`▸ ${this.who(e)} changed ${what}`));
        }
        break;
      }
      case "stopping":
        if (e.by !== this.me.kind) this.line(st.yellow(`▸ ${this.who(e)} stopped the reply.`));
        break;
      case "published":
        this.published = Boolean(e.published);
        break;
      case "undo":
        this.line(st.yellow(`▸ Undid ${(e.reverted as string[]).join(", ") || "nothing"}.`));
        break;
      case "cleared":
        this.line(st.dim("▸ The conversation was cleared."));
        break;
      case "resync":
        void this.c.snapshot(this.o.sessionId).then((s) => {
          this.applySnapshot(s);
          this.running = !!s.running;
          for (const p of s.pending) this.addApproval(p, false);
          this.refreshPrompt();
        }).catch(() => undefined);
        break;
      case "deleted":
        this.line(st.red("▸ This session was deleted."));
        this.running = false;
        break;
    }
    this.refreshPrompt();
  }

  private presence(): string {
    const names = [...new Set(this.clients.map((c) => (c.clientId === this.me.clientId ? "this terminal" : c.kind === "desktop" ? "EdgeCoder app" : c.label ?? c.kind)))];
    return names.length > 1 ? `Connected: ${names.join(" and ")}` : "Only this terminal is connected.";
  }

  private onAgent(ev: IdeStreamEvent): void {
    const st = this.st;
    switch (ev.type) {
      case "turn":
        this.running = true;
        this.turnCalls = [];
        break;
      case "text":
        this.out(clean(ev.content));
        break;
      case "status":
        this.line(st.dim(`  ${clean(ev.message)}`));
        break;
      case "tool_call": {
        this.line(`${st.cyan("●")} ${toolSummary(ev.tool, ev.args)}`);
        if (ev.requires_approval) this.addApproval({ id: ev.id, tool: ev.tool, args: ev.args }, true);
        break;
      }
      case "tool_result":
        this.line(ev.error ? st.red(`  ⎿ ${resultSummary(undefined, clean(ev.error))}`) : st.dim(`  ⎿ ${resultSummary(ev.result === undefined ? undefined : clean(ev.result), undefined)}`));
        break;
      case "shell_output": {
        const text = [ev.stdout, ev.stderr].filter(Boolean).join("\n");
        this.line(st.dim(`  ⎿ exit ${ev.exit_code}`));
        if (text.trim()) this.line(st.dim(outputTail(text)));
        break;
      }
      case "plan":
        this.line(st.dim(ev.steps.map((s, i) => `  ${i + 1}. ${clean(s.description)}`).join("\n")));
        break;
      case "usage": {
        const call: CallUsage = { cSats: Number.isFinite(ev.cSats) ? ev.cSats : 0, where: ev.where, ...(ev.model ? { model: ev.model } : {}), ...(ev.served ? { served: ev.served } : {}) };
        this.turnCalls.push(call);
        this.lastCall = call;
        if (typeof ev.usd === "number" && Number.isFinite(ev.usd)) this.usd = Number((this.usd + ev.usd).toFixed(6));
        break;
      }
    }
  }

  private async key(k: "escape" | "shift-tab"): Promise<void> {
    if (k === "escape") {
      if (this.running) await this.command("/stop");
      return;
    }
    // Full access is never cycled into (only `/mode full`); from it, Shift+Tab goes back to ask.
    await this.command(`/mode ${nextMode(this.mode)}`);
    this.refreshPrompt();
  }

  /** Slash commands; returns "exit" to leave. */
  async command(input: string): Promise<"exit" | void> {
    const [cmd, ...rest] = input.trim().split(/\s+/);
    const arg = rest.join(" ").trim();
    const st = this.st;
    const id = this.o.sessionId;
    try {
      switch (cmd.toLowerCase()) {
        case "/help":
        case "/?":
          this.line(HELP);
          return;
        case "/exit":
        case "/quit":
          return "exit";
        case "/model": {
          if (!arg) {
            this.line(`model: ${this.model}  ${st.dim("(/model <name> changes it; /compute changes where it runs)")}`);
            return;
          }
          const next = withPlacement(arg, this.model);
          await this.c.settings(id, { model: next });
          this.model = next;
          this.line(st.dim(`▸ model: ${next}`));
          return;
        }
        case "/compute": {
          const where = arg.toLowerCase();
          if (!where) {
            this.line(`compute: ${placementOf(this.model)} ${st.dim("(local, network, mine or auto)")}`);
            return;
          }
          if (!["local", "network", "mine", "auto"].includes(where)) {
            this.line(st.red("Use /compute local, network, mine or auto."));
            return;
          }
          const next = placeModel(this.model, where as "local" | "network" | "mine" | "auto", this.o.defaults);
          await this.c.settings(id, { model: next });
          this.model = next;
          this.line(st.dim(`▸ compute: ${where} · model: ${next}`));
          return;
        }
        case "/mode": {
          const m = arg.toLowerCase();
          if (!m) {
            this.line(`mode: ${this.mode} ${st.dim("(ask, auto-edits, auto, plan or full; Shift+Tab cycles)")}`);
            return;
          }
          if (!["ask", "auto-edits", "auto", "plan", "full"].includes(m)) {
            this.line(st.red("Use /mode ask, auto-edits, auto, plan or full."));
            return;
          }
          await this.c.settings(id, { mode: m as PermissionMode });
          this.mode = m as PermissionMode;
          this.line(st.dim(`▸ mode: ${m}${m === "auto" ? " (safe commands and edits apply; risky ones ask; dangerous ones are refused)" : m === "plan" ? " (read-only until you approve the plan: /approve)" : m === "auto-edits" ? " (edits apply without asking, undoable; commands ask)" : m === "full" ? " (Full access: commands, edits, installs and pushes run without asking; only a few destructive or secret-leaking commands are still refused)" : " (edits and commands ask)"}`));
          return;
        }
        case "/approve": {
          const m = (arg.toLowerCase() || "auto-edits") as PermissionMode;
          if (!["ask", "auto-edits", "auto"].includes(m)) {
            this.line(st.red("Use /approve, /approve auto-edits, /approve auto or /approve ask."));
            return;
          }
          await this.c.approvePlan(id, m);
          this.mode = m;
          this.line(st.dim(`▸ plan approved · mode: ${m}`));
          this.refreshPrompt();
          return;
        }
        case "/stop": {
          const r = (await this.c.cancel(id)) as { stopped?: boolean };
          this.line(st.yellow(r?.stopped ? `▸ Stopping…${this.queue.length ? " The queued message runs next." : ""}` : "▸ Nothing is running."));
          return;
        }
        case "/queue":
          this.line(this.queue.length ? this.queue.map((q, i) => `  ${i + 1}. ${clean(q.text).slice(0, 100)} ${st.dim(`(from ${q.label ?? KIND_LABEL[q.by] ?? q.by})`)}`).join("\n") : st.dim("Nothing is queued."));
          return;
        case "/unqueue": {
          if (!this.queue.length) {
            this.line(st.dim("Nothing is queued."));
            return;
          }
          const n = arg ? Number(arg) : this.queue.length;
          const q = Number.isInteger(n) && n >= 1 && n <= this.queue.length ? this.queue[n - 1] : undefined;
          if (!q) {
            this.line(st.red(`Use /unqueue 1-${this.queue.length}.`));
            return;
          }
          const r = await this.c.unqueue(id, q.id);
          this.queue = this.queue.filter((x) => x.id !== q.id);
          this.line(st.dim(r.removed ? `▸ Removed: ${clean(q.text).slice(0, 80)}` : "▸ It had already started."));
          return;
        }
        case "/clear":
          await this.c.clear(id);
          return;
        case "/undo": {
          const r = await this.c.undo(id);
          if (!r.reverted.length) this.line(st.dim("Nothing to undo."));
          return;
        }
        case "/cost":
          this.line(`This session has spent ${formatCSats(this.cSats)}.${this.usd > 0 || isFrontierModelId(this.model) ? ` On your own frontier key: ${formatUsd(this.usd)} (estimated; billed by the provider, not in cSats).` : ""}`);
          return;
        case "/lead": {
          if (!arg) {
            this.line(`lead: ${isFrontierModelId(this.model) ? `${frontierLabel(this.model)} (${this.model})` : this.model}  ${st.dim("(/lead <id> changes it, e.g. frontier/anthropic/claude-opus-5-5 or auto)")}`);
            return;
          }
          await this.c.settings(id, { leadModel: arg });
          this.model = arg;
          this.line(st.dim(`▸ lead: ${isFrontierModelId(arg) ? frontierLabel(arg) : arg}`));
          return;
        }
        case "/worker": {
          if (!arg) {
            this.line(`worker: ${this.worker}  ${st.dim("(runs helpers and delegated work; /worker <id> changes it)")}`);
            return;
          }
          await this.c.settings(id, { workerModel: arg });
          this.worker = arg;
          this.line(st.dim(`▸ worker: ${arg}`));
          return;
        }
        case "/status": {
          const s = await this.c.snapshot(id);
          this.applySnapshot(s);
          this.line(
            [
              `session  ${s.session.id}`,
              `project  ${s.session.projectRoot}${s.session.branch ? ` (${s.session.branch})` : ""}${s.trusted ? "" : st.dim(" · not trusted")}`,
              `model    ${this.model} (${placementOf(this.model)})`,
              `mode     ${this.mode}`,
              `last ran ${servedDetail(this.lastCall)}`,
              `clients  ${this.presence()}`,
              `queue    ${this.queue.length ? `${this.queue.length} waiting` : "empty"}`,
              `remote   ${s.session.published ? "on (shown live in the EdgeCoder app)" : "off (/remote)"}`,
              `provider ${this.o.providerLabel} (${this.c.baseUrl})`,
              `spent    ${formatCSats(s.session.cSats)}`,
            ].join("\n"),
          );
          return;
        }
        case "/remote": {
          if (arg === "off") {
            await this.c.publish(id, false);
            this.line(st.dim("▸ Remote off: the session is no longer shown live in the app."));
            return;
          }
          await this.c.publish(id, true);
          const title = (await this.c.snapshot(id).catch(() => this.snap)).session.title;
          this.line(
            st.green("▸ Remote on.") +
              ` Open the EdgeCoder app → Code → ${this.snap.session.projectRoot.split(/[/\\]/).pop()} → "${title}" (live).\n` +
              st.dim("  Both can type, approve and change settings at once; the first answer to an approval wins. /remote off stops."),
          );
          return;
        }
        case "/take":
          this.line(st.dim("Nothing to take: the terminal and the app work on this session together."));
          return;
        case "/github":
          await this.githubLogin();
          return;
        case "/tentacles": // tentacles hook
          this.line(await this.tentacles.command(arg, this.c, id));
          return;
        default:
          this.line(st.red(`Unknown command ${cmd}. /help lists them.`));
      }
    } catch (err) {
      this.line(st.red(errText(err)));
    }
  }

  private async githubLogin(): Promise<void> {
    const st = this.st;
    const s = await this.c.githubStatus();
    if (s.loggedIn) {
      this.line(`Signed in to GitHub as ${s.login}.`);
      return;
    }
    let l = await this.c.githubLogin();
    if (l.state === "error") {
      this.line(st.red(l.message ?? "GitHub sign-in failed."));
      return;
    }
    this.line(`Open ${st.bold(l.url)} and enter the code ${st.bold(l.code ?? "")}. Waiting…`);
    const until = Date.now() + 15 * 60_000;
    while ((l.state === "waiting" || l.state === "starting") && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2000));
      l = await this.c.githubLoginStatus(l.id);
    }
    if (l.state === "done") this.line(st.green(`▸ Signed in to GitHub${l.login ? ` as ${l.login}` : ""}.`));
    else this.line(st.red(l.message ?? "GitHub sign-in didn't complete."));
  }

  private async interrupt(): Promise<void> {
    if (this.running) {
      this.line(this.st.yellow("▸ Stopping…"));
      await this.c.cancel(this.o.sessionId).catch(() => undefined);
      return;
    }
    this.interrupts++;
    if (this.interrupts >= 2) {
      this.exiting = true;
      this.io.close?.();
    } else this.line(this.st.dim("(Ctrl+C again or /exit to leave)"));
  }

  private async leave(): Promise<void> {
    this.exiting = true;
    this.follower?.close();
    this.line(this.st.dim(`Session ${this.o.sessionId} kept. Continue it in the app${this.published ? " (it's live there)" : " (/remote)"} or with: edgecoder code --resume ${this.o.sessionId}`));
  }
}

function errText(err: unknown): string {
  if (err instanceof ProviderError) return err.message;
  return (err as Error).message ?? String(err);
}

function modelLabel(model: string, compute: { target: string; computeClass?: string; reservationId?: string; provider?: string }): string {
  if (compute.target === "auto") return "auto";
  if (compute.target === "frontier") return `frontier/${compute.provider ?? ""}/${model}`;
  if (compute.target === "local") return model;
  if (compute.target === "mine") return `mine/${model}`;
  if (compute.target === "reserved") return `reserved/${compute.reservationId}/${model}`;
  return `network/${model}${compute.computeClass && compute.computeClass !== "any" ? `@${compute.computeClass}` : ""}`;
}

export function placementOf(id: string): "local" | "network" | "mine" | "reserved" | "auto" {
  if (id === "auto") return "auto";
  if (id.startsWith("network/")) return "network";
  if (id.startsWith("mine/")) return "mine";
  if (id.startsWith("reserved/")) return "reserved";
  return "local";
}

function bareModel(id: string): string {
  if (id.startsWith("network/")) return id.slice(8).replace(/@(cpu|apple|gpu|gpu\.dc)$/, "");
  if (id.startsWith("mine/")) return id.slice(5);
  const r = /^reserved\/[^/]+\/(.+)$/.exec(id);
  if (r) return r[1];
  return id;
}

/** `/model qwen3-coder:30b` keeps the current placement (network stays network). */
export function withPlacement(name: string, current: string): string {
  if (name === "auto" || /^(network|mine|reserved|frontier)\//.test(name)) return name;
  const where = placementOf(current);
  if (where === "network") return `network/${name}`;
  if (where === "mine") return `mine/${name}`;
  return name;
}

/** `/compute network` keeps the model (from auto: the default for that placement). */
export function placeModel(current: string, where: "local" | "network" | "mine" | "auto", defaults: { local?: string; network?: string } = {}): string {
  if (where === "auto") return "auto";
  const bare = current === "auto" || isFrontierModelId(current) ? (where === "local" ? defaults.local ?? "qwen3.5:9b" : defaults.network ?? "qwen3-coder:30b") : bareModel(current);
  if (where === "local") return bare;
  return `${where}/${bare}`;
}
