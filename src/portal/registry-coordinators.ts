// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { RegistryEntry } from "../discovery/registry.js";
import { isPrivateHost } from "./coordinator-url-policy.js";

/*
 * The portal's coordinator list from the signed registry (PORTAL_REGISTRY_COORDINATORS, off by
 * default). With it on, the registry's active outside (community) members that are not failing their
 * health checks join the coordinators the portal asks about a user's machines (machine, bot and
 * code routes), after the static list, so
 * an admission or a suspension takes effect without a deploy. They are reached only with
 * portal-signed requests: their hosts are never sent PORTAL_SERVICE_TOKEN (coordinator-request.ts,
 * serviceTokenHostPolicy), whatever this flag says.
 */

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** Every host any outside member lists, whatever its status: these never receive the service token. */
export function outsideMemberHosts(members: ReadonlyArray<{ operatorKind: string; urls: readonly string[] }>): Set<string> {
  const out = new Set<string>();
  for (const m of members) {
    if (m.operatorKind === "edgecoder") continue;
    for (const u of m.urls) {
      const h = hostOf(u);
      if (h) out.add(h);
    }
  }
  return out;
}

/** https URLs of active, not unhealthy, outside members (deduplicated, at most `max`). Empty when disabled. */
export function registryFanoutUrls(entries: readonly RegistryEntry[], opts: { enabled: boolean; max?: number }): string[] {
  if (!opts.enabled) return [];
  const out: string[] = [];
  for (const e of entries) {
    if (e.operator.kind === "edgecoder" || (e.status ?? "active") !== "active" || e.health.status === "unhealthy") continue;
    for (const raw of e.urls) {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        continue;
      }
      if (u.protocol !== "https:" || u.username || u.password || isPrivateHost(u.hostname)) continue;
      const norm = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
      if (!out.includes(norm)) out.push(norm);
    }
  }
  return out.slice(0, opts.max ?? 8);
}
