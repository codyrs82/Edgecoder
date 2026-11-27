// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Which peer coordinators this coordinator sends its MESH_AUTH_TOKEN to (MESH_TOKEN_PEER_URLS).
 *
 * Every peer request is signed with the coordinator's own key (peer-auth.ts). The shared token
 * still goes along while one is set, so peers that require it keep working. A peer run by another
 * operator that admits signed requests (MESH_TOKEN_REQUIRED_FOR_PEERS=false) must not receive it:
 * whoever runs that peer could read it from the request and use it on every coordinator that
 * holds the same token. With MESH_TOKEN_PEER_URLS set, the token goes only to those origins;
 * every other peer gets the signature alone. Unset keeps sending it to every peer.
 */

/** Origins (scheme://host[:port]) the token may be sent to, or null for "every peer" (unset). */
export type MeshTokenScope = ReadonlySet<string> | null;

function originOf(value: string): string | null {
  try {
    const u = new URL(value.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** Parses a comma-separated list of peer URLs. Empty or unset: null (send to every peer). */
export function parseMeshTokenScope(raw: string | undefined): MeshTokenScope {
  const items = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) return null;
  const origins = new Set<string>();
  for (const item of items) {
    const origin = originOf(item);
    if (!origin) throw new Error(`MESH_TOKEN_PEER_URLS: not a URL: ${item}`);
    origins.add(origin);
  }
  return origins;
}

/** Whether a request to `url` may carry the mesh token under `scope`. */
export function meshTokenAllowedFor(scope: MeshTokenScope, url: string): boolean {
  if (scope === null) return true;
  const origin = originOf(url);
  return origin !== null && scope.has(origin);
}

/** The token to send with a request to `url`, or undefined when none is set or the URL is out of scope. */
export function meshTokenForUrl(token: string | undefined, scope: MeshTokenScope, url: string): string | undefined {
  if (!token) return undefined;
  return meshTokenAllowedFor(scope, url) ? token : undefined;
}
