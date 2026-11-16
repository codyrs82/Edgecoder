// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * An identifier placed into a path on a privileged upstream request (the control plane calls the
 * coordinator and portal with the mesh and admin tokens). Fastify decodes %2F inside a route
 * parameter, so an unencoded id could point the upstream request at a different path. Returns the
 * percent-encoded segment, or null for an id that is empty, too long, a dot segment or contains
 * control characters.
 */
export function upstreamPathSegment(id: unknown, maxLength = 256): string | null {
  if (typeof id !== "string" || id.length === 0 || id.length > maxLength) return null;
  if (id === "." || id === "..") return null;
  if (/[\u0000-\u001f\u007f]/.test(id)) return null;
  return encodeURIComponent(id);
}
