// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Reading the IP lookup (api.ipapi.is) the portal makes for an enrolled node's address
 * (/internal/nodes/validate) and, for /nodes/discover-coordinator, the caller's.
 *
 * Network run 22: every enrolment's lastCountryCode stayed empty, so the platform coordinator was
 * never picked by region. The lookup was read as `country_code` at the top level, which the
 * keyless (free tier) answer does not have: it gives the country's name (`country: "United
 * Kingdom"`), and the full answer nests the code under `location.country_code`. The code is now
 * read from either place, else derived from the country's English name.
 */

let byName: Map<string, string> | undefined;

/** The ISO 3166 alpha-2 code for an English country name ("United Kingdom" -> "GB"), or undefined. */
export function countryCodeForName(name: string | undefined | null): string | undefined {
  const key = (name ?? "").trim().toLowerCase();
  if (!key) return undefined;
  if (!byName) {
    byName = new Map();
    try {
      const names = new Intl.DisplayNames(["en"], { type: "region" });
      const A = "A".charCodeAt(0);
      for (let i = 0; i < 26; i++) {
        for (let j = 0; j < 26; j++) {
          const code = String.fromCharCode(A + i, A + j);
          // Aliases (UK, DD, ...) canonicalise to another code: only the canonical one is kept.
          if (Intl.getCanonicalLocales(`und-${code}`)[0] !== `und-${code}`) continue;
          const n = names.of(code);
          if (n && n !== code && !byName.has(n.toLowerCase())) byName.set(n.toLowerCase(), code);
        }
      }
    } catch {
      // No ICU region names: only the code fields are read.
    }
    // Names the lookup may use that differ from Intl's English ones.
    for (const [n, code] of [["united states of america", "US"], ["russian federation", "RU"], ["korea, republic of", "KR"], ["czech republic", "CZ"], ["the netherlands", "NL"], ["viet nam", "VN"]] as const) byName.set(n, code);
  }
  return byName.get(key);
}

const CODE_RE = /^[A-Za-z]{2}$/;

/** Country code and VPN flag from an api.ipapi.is answer (either shape). */
export function parseIpIntelligence(payload: unknown): { countryCode?: string; vpnDetected?: boolean } {
  if (!payload || typeof payload !== "object") return {};
  const p = payload as { country_code?: unknown; country?: unknown; location?: { country_code?: unknown; country?: unknown }; is_vpn?: unknown; is_proxy?: unknown };
  const rawCode = [p.country_code, p.location?.country_code].find((c): c is string => typeof c === "string" && CODE_RE.test(c.trim()));
  const name = [p.country, p.location?.country].find((c): c is string => typeof c === "string");
  const countryCode = rawCode?.trim().toUpperCase() ?? countryCodeForName(name);
  const vpn = p.is_vpn === true || p.is_proxy === true;
  return {
    ...(countryCode ? { countryCode } : {}),
    ...(p.is_vpn !== undefined || p.is_proxy !== undefined ? { vpnDetected: vpn } : {}),
  };
}
