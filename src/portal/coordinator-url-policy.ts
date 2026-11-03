// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { isIP } from "node:net";

/*
 * Which coordinator URLs the portal may call with its credentials (x-portal-service-token).
 *
 * Coordinator URLs reach the portal from the control plane's /network/coordinators list, which
 * peers can influence. Before any credential is attached the URL must pass this policy:
 * - strict (production, or whenever PORTAL_COORDINATOR_HOSTS is set): https only, no userinfo,
 *   no IP-literal or localhost / .local / .internal host in private, loopback or link-local space,
 *   and the hostname must be on the allowlist.
 * - the allowlist is PORTAL_COORDINATOR_HOSTS (comma list of hostnames or URLs) or, when unset,
 *   the hosts of the configured COORDINATOR_DISCOVERY_URLS.
 * - outside production with no PORTAL_COORDINATOR_HOSTS, everything passes (local development).
 */

export interface CoordinatorUrlPolicy {
  strict: boolean;
  allowedHosts: Set<string>;
}

function hostOf(entry: string): string | null {
  const raw = entry.trim();
  if (!raw) return null;
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

export function coordinatorUrlPolicyFromEnv(env: NodeJS.ProcessEnv, discoveryUrls: string[]): CoordinatorUrlPolicy {
  const configured = (env.PORTAL_COORDINATOR_HOSTS ?? "").trim();
  const source = configured ? configured.split(",") : discoveryUrls;
  const allowedHosts = new Set(source.map(hostOf).filter((h): h is string => Boolean(h)));
  return { strict: env.NODE_ENV === "production" || configured.length > 0, allowedHosts };
}

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** True for IP literals and names that point into private, loopback or link-local space. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const kind = isIP(h);
  if (kind === 4) return ipv4Private(h);
  if (kind === 6) {
    if (h === "::" || h === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return ipv4Private(mapped[1]);
    return /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  }
  return false;
}

export function coordinatorUrlAllowed(raw: string, policy: CoordinatorUrlPolicy): boolean {
  if (!policy.strict) return true;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isPrivateHost(host)) return false;
  return policy.allowedHosts.has(host);
}

export function filterCoordinatorUrls(urls: string[], policy: CoordinatorUrlPolicy): string[] {
  return urls.filter((u) => coordinatorUrlAllowed(u, policy));
}
