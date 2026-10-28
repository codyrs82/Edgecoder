// #24: "session expired" is a persistent state (a banner), unlike one-off action errors (toasts).
// Framework-free so the root vitest suite can test it.

type Listener = () => void;
const listeners = new Set<Listener>();
let expired = false;

// The auth endpoints themselves answer 401 for bad credentials; that isn't an expired session.
const AUTH_PATHS = ["/me", "/auth/login", "/auth/logout", "/auth/signup", "/auth/oauth/"];

/** A 401 from the portal on a request that carried a session token means the session expired. */
export function isSessionExpiry(status: number, path: string, hadToken: boolean): boolean {
  return status === 401 && hadToken && !AUTH_PATHS.some((p) => path === p || path.startsWith(p));
}

export function markSessionExpired(): void {
  if (expired) return;
  expired = true;
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* a listener error must not break the request path */
    }
  }
}

export function clearSessionExpired(): void {
  expired = false;
}

export function isSessionExpired(): boolean {
  return expired;
}

export function onSessionExpired(cb: Listener): () => void {
  listeners.add(cb);
  if (expired) cb();
  return () => listeners.delete(cb);
}
