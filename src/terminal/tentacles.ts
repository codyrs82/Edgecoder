// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * `edgecoder code`'s view of a session's tentacles (docs/tentacles.md): one status line as each
 * starts, finishes or is merged, `/tentacles` for the live tree, and the commands that act on them
 * (cancel, apply / drop a patch waiting for approval, settings). The REPL hands it the session's
 * tentacle_* events and the /tentacles command; everything else lives here.
 */

import type { SessionEvent } from "../apps/ide/sessions.js";
import type { TentacleCall, TentacleConfig, TentacleView } from "../apps/ide/tentacles.js";
import { tentacleCallLine, tentacleTotals } from "../apps/ide/tentacle-format.js";
import type { ProviderClient } from "./client.js";
import { formatCSats, type Style } from "./render.js";

export const TENTACLES_HELP = `  /tentacles                    the session's helper agents (live tree)
  /tentacles cancel <id>        stop one
  /tentacles apply|drop <id>    merge (or drop) a passed patch waiting for approval
  /tentacles on|off             let the lead delegate, or not
  /tentacles max <n> | budget <cSats> | worker <model>   limits and the worker model (never a frontier model)`;

const ACTIVE = new Set(["queued", "running", "verifying"]);
const short = (s: string, n = 56) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class TentacleTracker {
  private readonly views = new Map<string, TentacleView>();
  private config: TentacleConfig | null = null;
  private spent = 0;

  constructor(private readonly st: Style) {}

  /** Load the current state (on start, after a resync). */
  async refresh(c: ProviderClient, sessionId: string): Promise<void> {
    try {
      const r = await c.req<{ config: TentacleConfig; spentCSats: number; tentacles: TentacleView[] }>("GET", `/v1/ide/sessions/${sessionId}/tentacles`);
      this.config = r.config;
      this.spent = r.spentCSats;
      this.views.clear();
      for (const t of r.tentacles) this.views.set(t.id, t);
    } catch {
      // an older provider without tentacles
    }
  }

  /** Whether `e` is a tentacle event (the REPL passes those here). */
  static handles(e: SessionEvent): boolean {
    return e.type.startsWith("tentacle_");
  }

  private where(t: TentacleView): string {
    const r = t.result;
    return r ? `${r.model} on ${r.class}` : t.model ?? "auto";
  }

  /** One line for a tentacle. */
  line(t: TentacleView): string {
    const st = this.st;
    const status =
      t.status === "passed" ? st.green("passed") : t.status === "failed" || t.status === "error" ? st.red(t.status) : t.status === "cancelled" ? st.dim("cancelled") : st.cyan(t.status);
    const merge = t.merge && t.merge.state !== "no_changes" && t.merge.state !== "not_applied" ? ` · ${t.merge.state === "awaiting_approval" ? st.yellow("waiting for approval") : t.merge.state.replace("_", " ")}` : "";
    const detail = ACTIVE.has(t.status) ? st.dim(` · ${short(t.progress, 40)}`) : t.result?.error ? st.dim(` · ${short(t.result.error, 50)}`) : t.result?.unverified ? st.yellow(" · unverified") : "";
    return `${st.dim(t.id)} ${status}${merge} · ${short(t.task)} · ${this.where(t)} · ${formatCSats(t.cSats)}${detail}`;
  }

  /** Apply an event; returns the line to print, or null for progress (shown by /tentacles). */
  onEvent(e: SessionEvent): string | null {
    const st = this.st;
    switch (e.type) {
      case "tentacle_started": {
        const t = e.tentacle as TentacleView;
        this.views.set(t.id, t);
        return st.dim(`  ⟡ tentacle ${t.id}: ${short(t.task)} (${t.kind}${t.readOnly ? ", read-only" : ""})`);
      }
      case "tentacle_progress": {
        const t = this.views.get(String(e.id));
        if (!t) return null;
        const wasQueued = t.status === "queued";
        t.status = e.status as TentacleView["status"];
        t.progress = String(e.progress ?? "");
        t.cSats = Number(e.cSats ?? t.cSats);
        if (typeof e.model === "string") t.model = e.model;
        return wasQueued && t.status === "running" ? st.dim(`  ⟡ ${t.id} running on ${t.model ?? "auto"}`) : null;
      }
      case "tentacle_finished":
      case "tentacle_merge": {
        const t = e.tentacle as TentacleView;
        this.views.set(t.id, t);
        const hint = t.merge?.state === "awaiting_approval" ? st.dim(`  (/tentacles apply ${t.id} or drop ${t.id})`) : "";
        return `  ⟡ ${this.line(t)}${hint}`;
      }
      case "tentacle_usage": {
        // Each helper call's own served line: model · class · host region · tokens · cSats.
        const t = this.views.get(String(e.id));
        const call = e.call as TentacleCall | undefined;
        if (t && call) {
          t.calls = [...(t.calls ?? []), call];
          t.cSats = Number(e.cSats ?? t.cSats);
        }
        const line = typeof e.line === "string" ? e.line : call ? tentacleCallLine(call) : "";
        return line ? st.dim(`    ↳ ${String(e.id)} · ${line}`) : null;
      }
      case "tentacle_totals": {
        const totals = e.totals as { line?: string } | undefined;
        const session = e.session as { line?: string } | undefined;
        if (!totals?.line) return null;
        return `  ⟡ helpers merged: ${totals.line}${session?.line && session.line !== totals.line ? st.dim(` (session: ${session.line})`) : ""}`;
      }
      case "tentacle_config":
        this.config = e.config as TentacleConfig;
        this.spent = Number(e.spentCSats ?? this.spent);
        return null;
      default:
        return null;
    }
  }

  /** The live tree. */
  tree(): string {
    const st = this.st;
    const all = [...this.views.values()].sort((a, b) => a.createdAt - b.createdAt);
    const running = all.filter((t) => ACTIVE.has(t.status)).length;
    const spent = this.spent || all.reduce((n, t) => n + t.cSats, 0);
    const head = `Tentacles ${this.config ? (this.config.enabled ? st.green("on") : st.dim("off")) : ""} · ${running} running · ${formatCSats(spent)}${this.config ? ` of ${formatCSats(this.config.budgetCSats)}` : ""}${this.config ? st.dim(` · max ${this.config.maxParallel} · worker ${this.config.workerModel}`) : ""}`;
    if (!all.length) return `${head}\n${st.dim("  none yet. The lead delegates when tentacles are on (/tentacles on).")}`;
    const rows = all.flatMap((t, i) => {
      const last = i === all.length - 1;
      const calls = (t.result?.calls ?? t.calls ?? []).map((c) => st.dim(`${last ? " " : "│"}   ↳ ${tentacleCallLine(c)}`));
      return [`${last ? "└" : "├"} ${this.line(t)}`, ...calls];
    });
    return [head, ...rows, st.dim(`  total: ${tentacleTotals(all).line}`)].join("\n");
  }

  /** `/tentacles [sub] [arg]`: returns what to print. */
  async command(arg: string, c: ProviderClient, sessionId: string): Promise<string> {
    const [sub, ...rest] = arg.split(/\s+/).filter(Boolean);
    const value = rest.join(" ");
    const base = `/v1/ide/sessions/${sessionId}/tentacles`;
    const config = async (patch: Record<string, unknown>) => {
      const r = await c.req<{ config: TentacleConfig }>("POST", `${base}/config`, patch);
      this.config = r.config;
      return this.st.dim(`▸ tentacles ${r.config.enabled ? "on" : "off"} · max ${r.config.maxParallel} · budget ${formatCSats(r.config.budgetCSats)} · worker ${r.config.workerModel}`);
    };
    switch ((sub ?? "").toLowerCase()) {
      case "":
      case "list":
        await this.refresh(c, sessionId);
        return this.tree();
      case "cancel": {
        const r = await c.req<{ cancelled: boolean }>("POST", `${base}/${value}/cancel`);
        return r.cancelled ? this.st.dim(`▸ cancelling ${value}`) : this.st.dim(`${value} isn't running.`);
      }
      case "apply":
      case "drop": {
        const r = await c.req<{ tentacle: TentacleView }>("POST", `${base}/${value}/merge`, { approved: sub === "apply" });
        this.views.set(r.tentacle.id, r.tentacle);
        return this.line(r.tentacle) + (r.tentacle.merge?.error ? `\n${this.st.red(r.tentacle.merge.error)}` : "");
      }
      case "on":
      case "off":
        return config({ enabled: sub === "on" });
      case "max":
        return config({ maxParallel: Number(value) });
      case "budget":
        return config({ budgetCSats: Number(value) });
      case "worker":
        return config({ workerModel: value || "auto" });
      default:
        return TENTACLES_HELP;
    }
  }
}
