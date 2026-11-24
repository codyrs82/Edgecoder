// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import { loadConfig } from "../common/config.js";

/*
 * Growth signals (src/growth, src/portal/growth.ts): the new-sign-up alert, the daily digest and the
 * campaign counts. Mail goes to ALERT_EMAILS through Resend (src/alerting/config.ts). The portal
 * spreads this into its schema (src/portal/config.ts). Documented in
 * site-docs/reference/environment-variables.md ("Growth signals").
 */
export const growthEnv = {
  /**
   * Sign-ups that never alert and are left out of the campaign sign-up counts: a comma list of exact
   * addresses (`me@example.com`), whole domains (`@example.com`) or globs (`cody+*@sixthirty.ai`).
   */
  SIGNUP_ALERT_IGNORE: z.string().optional()
};

const schema = z.object(growthEnv);

export interface GrowthConfig {
  ignore: string[];
}

export function growthConfigFrom(raw: { SIGNUP_ALERT_IGNORE?: string }): GrowthConfig {
  return {
    ignore: (raw.SIGNUP_ALERT_IGNORE ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.includes("@"))
  };
}

export function growthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GrowthConfig {
  return growthConfigFrom(loadConfig("growth", schema, env));
}

/** Whether an address is on the ignore list: exact, `@domain` (that domain only), or a `*` glob. */
export function emailIgnored(email: string, patterns: readonly string[]): boolean {
  const e = email.trim().toLowerCase();
  for (const raw of patterns) {
    let p = raw.trim().toLowerCase();
    if (!p) continue;
    // "@example.com" is the whole domain: the same as "*@example.com".
    if (p.startsWith("@")) p = `*${p}`;
    if (!p.includes("*")) {
      if (e === p) return true;
      continue;
    }
    const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^@]*")}$`);
    if (re.test(e)) return true;
  }
  return false;
}
