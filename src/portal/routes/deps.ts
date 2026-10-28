// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { PortalStore } from "../store.js";

/**
 * #16: what the API route modules need from server.ts. Passed in explicitly so each
 * module can be read (and tested) without the rest of the portal.
 */
export interface PortalRouteDeps {
  store: PortalStore | undefined | null;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<{ userId: string } | null>;
}
