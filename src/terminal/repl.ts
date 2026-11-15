// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * The `edgecoder code` REPL: a client of one shared session on the IDE provider. Replies stream
 * in, tool calls print in one line, writes and commands ask inline (y / n / always) with the diff,
 * and whatever another client (the desktop app) does in the same session is mirrored here.
 */

import type { ClientRef, SessionEvent, TranscriptEntry } from "../apps/ide/sessions.js";
import type { IdeStreamEvent } from "../apps/ide/tool-types.js";
import { ProviderError, type ProviderClient, type Snapshot } from "./client.js";
import { formatCSats, formatDiff, outputTail, proposedDiff, resultSummary, toolSummary, type Style } from "./render.js";

export interface ReplIO {
  /** One line of input after showing `prompt`; null at the end of input. */
  readLine(prompt: string): Promise<string | null>;
  write(text: string): void;
  /** Ctrl+C. */
  onInterrupt?(fn: () => void): void;
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

export const HELP = `Commands:
  /model [name]                 show or set the model (a local tag, network/<model>[@class], auto)
  /compute [local|network|mine|auto]   where the model runs
  /remote [off]                 continue this session in the EdgeCoder app (Code view), or stop
  /take                         take control back from the app
  /undo                         undo the files the last reply changed
  /clear                        start the conversation over
  /status                       session, project, branch, model, who is connected
  /cost                         what this session has spent
  /github                       sign in to GitHub (device code)
  /help                         this list
  /exit                         leave (the session stays; reopen it in the app or with --resume)
Approvals: y = yes, n = no, a = always (edits for this session, or this command name). Ctrl+C stops a reply.`;

interface Pending {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export class Repl {
  private readonly c: ProviderClient;
  private readonly io: ReplIO;
  private readonly st: Style;
  private readonly me: ClientRef;
  private snap!: Snapshot;
  private follower: { close: () => void } | null = null;
  private controllerId: string | null = null;
  private controllerLabel = "";
  private running = false;
  private currentTurn: string | null = null;
  private endedTurns = new Set<string>();
  private queue: Pending[] = [];
  private calls = new Map<string, Pending>();
  private answered = new Set<string>();
  private wake: () => void = () => undefined;
  private atLineStart = true;
  private echoExpected = 0;
  private turnCost = 0;
  private turnWhere = "";
  private cSats = 0;
  private model = "";
  private published = false;
  private clients: ClientRef[] = [];
  private exiting = false;
  private interrupts = 0;

  constructor(private readonly o: ReplOptions) {
    this.c = o.client;
    this.io = o.io;
    this.st = o.style;
    this.me = o.client.client;
  }

  private get inControl(): boolean {
    return this.controllerId === this.me.clientId;
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
    if (this.o.remote) await this.command("/remote");
    // A turn that was already running (resuming), or one the app started: follow it to the end.
    if (this.snap.running) {
      this.running = true;
      this.currentTurn = this.snap.running.turnId;
      for (const p of this.snap.pending) this.queue.push(p);
    }
    try {
      for (;;) {
        if (this.running && this.inControl) await this.waitTurn();
        const input = await this.io.readLine(this.prompt());
        if (input === null) break;
        this.interrupts = 0;
        const text = input.trim();
        if (!text) continue;
        if (text.startsWith("/")) {
          if ((await this.command(text)) === "exit") break;
          continue;
        }
        await this.say(text);
      }
    } finally {
      await this.leave();
    }
    return 0;
  }

  private prompt(): string {
    return this.inControl ? this.st.bold("› ") : this.st.dim(`(${this.controllerLabel || "the app"} is in control) › `);
  }

  private applySnapshot(s: Snapshot): void {
    this.controllerId = s.controller?.clientId ?? null;
    this.controllerLabel = s.controller ? s.controller.label ?? s.controller.kind : "";
    this.model = modelLabel(s.session.model, s.session.compute);
    this.cSats = s.session.cSats;
    this.published = s.session.published;
    this.clients = s.clients;
  }

  private header(): void {
    const s = this.snap.session;
    const st = this.st;
    this.line(st.bold("EdgeCoder") + st.dim(` · ${this.o.providerLabel}`));
    this.line(`${st.dim("project")} ${s.projectRoot}${s.branch ? st.dim(` (${s.branch})`) : ""}`);
    this.line(`${st.dim("model  ")} ${this.model}`);
    this.line(`${st.dim("session")} ${s.id}${s.transcript.length ? st.dim(` · ${s.transcript.length} messages`) : ""}`);
    for (const t of s.transcript.slice(-6)) this.replay(t);
    this.line(st.dim("Type a request, or /help. /remote continues this session in the EdgeCoder app."));
  }

  private replay(t: TranscriptEntry): void {
    if (t.role === "user") this.line(`${this.st.bold("›")} ${t.content}`);
    else this.line(this.st.dim(t.content.length > 400 ? `${t.content.slice(0, 400)}…` : t.content));
  }

  private async say(text: string): Promise<void> {
    if (!this.inControl) {
      this.line(this.st.yellow(`${this.controllerLabel || "The app"} is in control of this session. /take to take it back.`));
      return;
    }
    if (this.running) {
      this.line(this.st.yellow("A reply is still running. Ctrl+C stops it."));
      return;
    }
    this.echoExpected++;
    try {
      const { turnId } = await this.c.send(this.o.sessionId, text);
      if (!this.endedTurns.has(turnId)) {
        this.running = true;
        this.currentTurn = turnId;
      }
    } catch (err) {
      this.echoExpected = Math.max(0, this.echoExpected - 1);
      this.line(this.st.red(errText(err)));
      return;
    }
    await this.waitTurn();
  }

  /** Until the running turn ends: answer approvals as they come (while in control). */
  private async waitTurn(): Promise<void> {
    while (this.running) {
      if (this.inControl && this.queue.length) {
        const p = this.queue.shift()!;
        if (!this.answered.has(p.id)) await this.ask(p);
        continue;
      }
      await new Promise<void>((r) => (this.wake = r));
    }
  }

  private async ask(p: Pending): Promise<void> {
    for (let tries = 0; tries < 3; tries++) {
      const a = await this.io.readLine(this.st.yellow(`  Allow ${toolSummary(p.tool, p.args)}? [y]es / [n]o / [a]lways › `));
      if (this.answered.has(p.id)) return; // answered elsewhere meanwhile
      const ans = (a ?? "n").trim().toLowerCase();
      const choice = ans === "y" || ans === "yes" ? "y" : ans === "n" || ans === "no" ? "n" : ans === "a" || ans === "always" ? "a" : null;
      if (!choice) {
        this.line(this.st.dim("  Answer y, n or a."));
        continue;
      }
      this.answered.add(p.id);
      try {
        await this.c.approve(this.o.sessionId, p.id, choice !== "n", choice === "a");
      } catch (err) {
        this.line(this.st.red(`  ${errText(err)}`));
      }
      return;
    }
    this.answered.add(p.id);
    await this.c.approve(this.o.sessionId, p.id, false).catch(() => undefined);
  }

  private onEvent(e: SessionEvent): void {
    const st = this.st;
    switch (e.type) {
      case "agent":
        this.onAgent(e.event as IdeStreamEvent, String(e.turnId ?? ""));
        break;
      case "message": {
        const entry = e.entry as TranscriptEntry;
        if (entry.by === this.me.kind && this.echoExpected > 0) {
          this.echoExpected--;
          break;
        }
        this.line(`${st.magenta(`› [${entry.by ?? "app"}]`)} ${entry.content}`);
        break;
      }
      case "turn_end": {
        const entry = e.entry as TranscriptEntry;
        if (entry.turnId) this.endedTurns.add(entry.turnId);
        if (!this.atLineStart) this.out("\n");
        const bits: string[] = [];
        if (entry.changedFiles?.length) bits.push(`changed ${entry.changedFiles.join(", ")} (/undo reverts)`);
        if (this.turnCost > 0 || this.turnWhere) bits.push(`${formatCSats(this.turnCost)}${this.turnWhere ? ` · ${this.turnWhere}` : ""}`);
        if (e.stopped) bits.push("stopped");
        if (bits.length) this.line(st.dim(`  ${bits.join(" · ")}`));
        this.cSats = Number(e.cSats ?? this.cSats);
        this.turnCost = 0;
        this.turnWhere = "";
        if (!this.currentTurn || entry.turnId === this.currentTurn) {
          this.running = false;
          this.currentTurn = null;
        }
        this.queue = [];
        break;
      }
      case "approval": {
        const id = String(e.id);
        const had = this.answered.has(id);
        this.answered.add(id);
        this.queue = this.queue.filter((q) => q.id !== id);
        if (e.by === "always") this.line(st.dim("  ✓ allowed (always)"));
        else if (!had || e.by !== this.me.kind) this.line(st.dim(`  ${e.approved ? "✓ approved" : "✗ rejected"}${e.by && e.by !== this.me.kind ? ` (${e.by})` : ""}`));
        break;
      }
      case "control": {
        const ctl = e.controller as ClientRef | null;
        const was = this.inControl;
        this.controllerId = ctl?.clientId ?? null;
        this.controllerLabel = ctl ? ctl.label ?? ctl.kind : "";
        if (was && !this.inControl) this.line(st.yellow(`▸ ${this.controllerLabel || "Nobody"} ${ctl ? "took control" : "has control"}. You're watching; /take takes it back.`));
        else if (!was && this.inControl) {
          this.line(st.green("▸ You're in control."));
          // Approvals still waiting in a running turn are now ours to answer.
          void this.c.snapshot(this.o.sessionId).then((s) => {
            for (const p of s.pending) if (!this.answered.has(p.id) && !this.queue.some((q) => q.id === p.id)) this.queue.push(p);
            if (s.running) {
              this.running = true;
              this.currentTurn = s.running.turnId;
            }
            this.wake();
          }).catch(() => undefined);
        }
        break;
      }
      case "presence": {
        const before = new Set(this.clients.map((c) => c.clientId));
        this.clients = (e.clients as ClientRef[]) ?? [];
        for (const c of this.clients) if (!before.has(c.clientId) && c.clientId !== this.me.clientId) this.line(st.dim(`▸ ${c.label ?? c.kind} is following this session.`));
        const now = new Set(this.clients.map((c) => c.clientId));
        for (const id of before) if (!now.has(id) && id !== this.me.clientId) this.line(st.dim("▸ A client left this session."));
        break;
      }
      case "settings":
        if (typeof e.model === "string") this.model = e.model;
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
        void this.c.snapshot(this.o.sessionId).then((s) => this.applySnapshot(s)).catch(() => undefined);
        break;
      case "deleted":
        this.line(st.red("▸ This session was deleted."));
        this.running = false;
        break;
    }
    this.wake();
  }

  private onAgent(ev: IdeStreamEvent, turnId: string): void {
    const st = this.st;
    switch (ev.type) {
      case "turn":
        if (!this.running) {
          // A turn someone else started (the app): follow it.
          this.running = true;
          this.currentTurn = turnId;
        }
        break;
      case "text":
        this.out(ev.content);
        break;
      case "status":
        this.line(st.dim(`  ${ev.message}`));
        break;
      case "tool_call": {
        const p = { id: ev.id, tool: ev.tool, args: ev.args };
        this.calls.set(ev.id, p);
        this.line(`${st.cyan("●")} ${toolSummary(ev.tool, ev.args)}`);
        if (ev.requires_approval) {
          const diff = proposedDiff(this.snap.session.projectRoot, ev.tool, ev.args);
          if (diff?.length) this.line(formatDiff(diff, st));
          else if (ev.tool === "run_shell") this.line(`    ${st.yellow("$")} ${String(ev.args.command ?? "")}`);
          if (this.inControl) this.queue.push(p);
          else this.line(st.dim(`  waiting for ${this.controllerLabel || "the app"} to approve…`));
        }
        break;
      }
      case "tool_result":
        this.line(ev.error ? st.red(`  ⎿ ${resultSummary(undefined, ev.error)}`) : st.dim(`  ⎿ ${resultSummary(ev.result, undefined)}`));
        break;
      case "shell_output": {
        const text = [ev.stdout, ev.stderr].filter(Boolean).join("\n");
        this.line(st.dim(`  ⎿ exit ${ev.exit_code}`));
        if (text.trim()) this.line(st.dim(outputTail(text)));
        break;
      }
      case "plan":
        this.line(st.dim(ev.steps.map((s, i) => `  ${i + 1}. ${s.description}`).join("\n")));
        break;
      case "usage":
        this.turnCost += Number.isFinite(ev.cSats) ? ev.cSats : 0;
        this.turnWhere = ev.where;
        break;
    }
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
        case "/clear":
          await this.c.clear(id);
          return;
        case "/undo": {
          const r = await this.c.undo(id);
          if (!r.reverted.length) this.line(st.dim("Nothing to undo."));
          return;
        }
        case "/cost":
          this.line(`This session has spent ${formatCSats(this.cSats)}.`);
          return;
        case "/status": {
          const s = await this.c.snapshot(id);
          this.applySnapshot(s);
          const others = s.clients.filter((c) => c.clientId !== this.me.clientId);
          this.line(
            [
              `session  ${s.session.id}`,
              `project  ${s.session.projectRoot}${s.session.branch ? ` (${s.session.branch})` : ""}${s.trusted ? "" : st.dim(" · not trusted")}`,
              `model    ${this.model}`,
              `control  ${this.inControl ? "you" : this.controllerLabel || "nobody"}`,
              `watching ${others.length ? others.map((c) => c.label ?? c.kind).join(", ") : "nobody else"}`,
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
            this.line(st.dim("▸ Remote control off: the session is no longer shown live in the app."));
            return;
          }
          await this.c.publish(id, true);
          this.line(
            st.green("▸ Remote control on.") +
              ` Open the EdgeCoder app → Code → ${this.snap.session.projectRoot.split(/[/\\]/).pop()} → "${this.snap.session.title}" (live).\n` +
              st.dim("  The app can send messages and approve tool calls; this terminal mirrors it. /take takes control back, /remote off stops."),
          );
          return;
        }
        case "/take": {
          await this.c.takeControl(id);
          const s = await this.c.snapshot(id);
          this.controllerId = s.controller?.clientId ?? null;
          for (const p of s.pending) if (!this.answered.has(p.id) && !this.queue.some((q) => q.id === p.id)) this.queue.push(p);
          if (s.running) {
            this.running = true;
            this.currentTurn = s.running.turnId;
          }
          return;
        }
        case "/github":
          await this.githubLogin();
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
    if (this.running && this.inControl) {
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
    // Hand control back so the app can carry on (the session itself stays).
    if (this.inControl) await this.c.releaseControl(this.o.sessionId).catch(() => undefined);
    this.line(this.st.dim(`Session ${this.o.sessionId} kept. Continue it in the app${this.published ? " (it's live there)" : " (/remote)"} or with: edgecoder code --resume ${this.o.sessionId}`));
  }
}

function errText(err: unknown): string {
  if (err instanceof ProviderError) return err.message;
  return (err as Error).message ?? String(err);
}

function modelLabel(model: string, compute: { target: string; computeClass?: string; reservationId?: string }): string {
  if (compute.target === "auto") return "auto";
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
  if (name === "auto" || /^(network|mine|reserved)\//.test(name)) return name;
  const where = placementOf(current);
  if (where === "network") return `network/${name}`;
  if (where === "mine") return `mine/${name}`;
  return name;
}

/** `/compute network` keeps the model (from auto: the default for that placement). */
export function placeModel(current: string, where: "local" | "network" | "mine" | "auto", defaults: { local?: string; network?: string } = {}): string {
  if (where === "auto") return "auto";
  const bare = current === "auto" ? (where === "local" ? defaults.local ?? "qwen3.5:9b" : defaults.network ?? "qwen3-coder:30b") : bareModel(current);
  if (where === "local") return bare;
  return `${where}/${bare}`;
}
