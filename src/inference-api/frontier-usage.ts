// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Local spend for frontier calls (docs/frontier-keys.md): the provider bills the user directly, so
 * EdgeCoder charges no cSats for these calls and only keeps an estimate here, from token counts
 * and the price table, to show spend and to enforce the user's caps:
 *   - a warning at 80% of the session cap or the daily cap,
 *   - a hard stop at 100% (the call is refused before anything is sent).
 * Kept in ~/.edgecoder/frontier-usage.json (0600) next to frontier.json; nothing leaves the computer.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultFrontierFile } from "./frontier-keys.js";
import { formatUsd } from "./frontier-models.js";

export const WARN_AT = 0.8;

interface UsageFile {
  /** Local date (YYYY-MM-DD) -> USD. */
  days: Record<string, number>;
  /** Session key -> USD and when it was last used. */
  sessions: Record<string, { usd: number; at: number }>;
  /** Totals by model (`<provider>/<model>`). */
  models: Record<string, { usd: number; inputTokens: number; outputTokens: number; calls: number }>;
}

export interface Caps {
  sessionCapUsd: number | null;
  dailyCapUsd: number | null;
}

export interface SpendCheck {
  state: "ok" | "warn" | "stop";
  sessionUsd: number;
  dayUsd: number;
  message?: string;
}

export const localDay = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

export class FrontierSpend {
  readonly file: string;
  private readonly warned = new Set<string>();

  constructor(file?: string, private readonly now: () => Date = () => new Date()) {
    this.file = file ?? join(dirname(defaultFrontierFile()), "frontier-usage.json");
  }

  private read(): UsageFile {
    try {
      const d = JSON.parse(readFileSync(this.file, "utf8")) as Partial<UsageFile>;
      return { days: d.days ?? {}, sessions: d.sessions ?? {}, models: d.models ?? {} };
    } catch {
      return { days: {}, sessions: {}, models: {} };
    }
  }

  private write(d: UsageFile): void {
    // Keep 90 days and the sessions used in the last 30.
    const cutDay = localDay(new Date(this.now().getTime() - 90 * 86_400_000));
    for (const k of Object.keys(d.days)) if (k < cutDay) delete d.days[k];
    const cutAt = this.now().getTime() - 30 * 86_400_000;
    for (const [k, v] of Object.entries(d.sessions)) if (v.at < cutAt) delete d.sessions[k];
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
    renameSync(tmp, this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // Windows
    }
  }

  totals(sessionKey?: string): { sessionUsd: number; dayUsd: number } {
    const d = this.read();
    return { sessionUsd: sessionKey ? d.sessions[sessionKey]?.usd ?? 0 : 0, dayUsd: d.days[localDay(this.now())] ?? 0 };
  }

  /** Before a call: stop at 100% of either cap, warn (once per session and threshold) at 80%. */
  check(sessionKey: string, caps: Caps): SpendCheck {
    const { sessionUsd, dayUsd } = this.totals(sessionKey);
    const over = (spent: number, cap: number | null) => cap !== null && spent >= cap;
    if (over(sessionUsd, caps.sessionCapUsd)) {
      return { state: "stop", sessionUsd, dayUsd, message: `Frontier spend for this session reached its cap (${formatUsd(sessionUsd)} of ${formatUsd(caps.sessionCapUsd!)}). Raise the cap in Settings → Frontier models, or switch the lead to Auto.` };
    }
    if (over(dayUsd, caps.dailyCapUsd)) {
      return { state: "stop", sessionUsd, dayUsd, message: `Frontier spend today reached your daily cap (${formatUsd(dayUsd)} of ${formatUsd(caps.dailyCapUsd!)}). Raise the cap in Settings → Frontier models, or switch the lead to Auto.` };
    }
    const near = (spent: number, cap: number | null) => cap !== null && cap > 0 && spent >= cap * WARN_AT;
    const warnings: string[] = [];
    if (near(sessionUsd, caps.sessionCapUsd) && !this.warned.has(`s:${sessionKey}`)) {
      this.warned.add(`s:${sessionKey}`);
      warnings.push(`this session has used ${formatUsd(sessionUsd)} of its ${formatUsd(caps.sessionCapUsd!)} frontier cap`);
    }
    if (near(dayUsd, caps.dailyCapUsd) && !this.warned.has(`d:${localDay(this.now())}:${sessionKey}`)) {
      this.warned.add(`d:${localDay(this.now())}:${sessionKey}`);
      warnings.push(`today's frontier spend is ${formatUsd(dayUsd)} of your ${formatUsd(caps.dailyCapUsd!)} daily cap`);
    }
    if (warnings.length) return { state: "warn", sessionUsd, dayUsd, message: `Heads up: ${warnings.join("; ")}.` };
    return { state: "ok", sessionUsd, dayUsd };
  }

  /** After a call: add its estimated cost. */
  record(sessionKey: string, model: string, usd: number, tokens: { inputTokens: number; outputTokens: number }): { sessionUsd: number; dayUsd: number } {
    const d = this.read();
    const day = localDay(this.now());
    const add = (n: number | undefined) => Math.round(((n ?? 0) + usd) * 1e6) / 1e6;
    d.days[day] = add(d.days[day]);
    d.sessions[sessionKey] = { usd: add(d.sessions[sessionKey]?.usd), at: this.now().getTime() };
    const m = d.models[model] ?? { usd: 0, inputTokens: 0, outputTokens: 0, calls: 0 };
    d.models[model] = { usd: add(m.usd), inputTokens: m.inputTokens + tokens.inputTokens, outputTokens: m.outputTokens + tokens.outputTokens, calls: m.calls + 1 };
    this.write(d);
    return { sessionUsd: d.sessions[sessionKey].usd, dayUsd: d.days[day] };
  }

  summary(): { today: number; last30Days: number; models: UsageFile["models"] } {
    const d = this.read();
    const cut = localDay(new Date(this.now().getTime() - 29 * 86_400_000));
    return { today: d.days[localDay(this.now())] ?? 0, last30Days: Object.entries(d.days).filter(([k]) => k >= cut).reduce((n, [, v]) => n + v, 0), models: d.models };
  }
}
