// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Where the portal sends admin-token calls (COORDINATOR_ADMIN_URLS). The coordinators refuse admin
 * calls that come through the public edge (src/common/admin-origin.ts), so in production these are
 * their internal addresses (http://<app>.internal:<ADMIN_LISTEN_PORT>). Operator-set, so not
 * filtered by the discovery URL policy. Unset: `fallback` (the discovered URLs), as before.
 */
export function createCoordinatorAdminUrls(raw: string | undefined, defaultFallback: () => Promise<string[]>) {
  const list = (raw ?? "").split(",").map((u) => u.trim().replace(/\/+$/, "")).filter((u) => /^https?:\/\//i.test(u));
  return async (fallback: () => Promise<string[]> = defaultFallback): Promise<string[]> => (list.length ? list : fallback());
}
