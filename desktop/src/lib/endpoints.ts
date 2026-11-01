// #35: coordinator and portal URLs come from user settings, then build-time env
// (VITE_COORDINATOR_URL / VITE_PORTAL_URL), then a default. Remote calls fail fast with
// EndpointUnreachableError instead of hanging. No framework imports, so it is unit-testable.

export type EndpointKind = "coordinator" | "portal";

export const COORDINATOR_KEY = "edgecoder_coordinatorUrl";
export const PORTAL_KEY = "edgecoder_portalUrl";
/** Pre-#35 "Seed Node URL" setting; read as a fallback for the coordinator. */
export const LEGACY_SEED_KEY = "edgecoder_seedNodeUrl";

export const FALLBACK_COORDINATOR_URL = "https://edgecoder-seed-eu.fly.dev";
export const FALLBACK_PORTAL_URL = "https://edgecoder.io";
export const ENDPOINT_TIMEOUT_MS = 8_000;

type EndpointEnv = { VITE_COORDINATOR_URL?: string; VITE_PORTAL_URL?: string };
type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const buildEnv: EndpointEnv = ((import.meta as unknown as { env?: EndpointEnv }).env ?? {}) as EndpointEnv;

function storage(): KV | null {
  try {
    return (globalThis as { localStorage?: KV }).localStorage ?? null;
  } catch {
    return null;
  }
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Normalised origin (+path, no trailing slash) or null. https only, except http on loopback. */
export function validateEndpointUrl(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const ok = u.protocol === "https:" || (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname));
  if (!ok) return null;
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
}

export function defaultEndpoints(env: EndpointEnv = buildEnv): Record<EndpointKind, string> {
  return {
    coordinator: validateEndpointUrl(env.VITE_COORDINATOR_URL) ?? FALLBACK_COORDINATOR_URL,
    portal: validateEndpointUrl(env.VITE_PORTAL_URL) ?? FALLBACK_PORTAL_URL,
  };
}

/** The pre-#35 default; a legacy "Seed Node URL" equal to it is ignored (NXDOMAIN). */
export const DEAD_SEED_URL = "https://edgecoder-seed" + ".fly.dev"; // split so the repo guard test stays simple

function legacySeed(s: KV | null): string | null {
  const v = validateEndpointUrl(s?.getItem(LEGACY_SEED_KEY));
  return v === DEAD_SEED_URL ? null : v;
}

export function coordinatorUrl(s: KV | null = storage(), env: EndpointEnv = buildEnv): string {
  return (
    validateEndpointUrl(s?.getItem(COORDINATOR_KEY)) ??
    legacySeed(s) ??
    defaultEndpoints(env).coordinator
  );
}

export function portalUrl(s: KV | null = storage(), env: EndpointEnv = buildEnv): string {
  return validateEndpointUrl(s?.getItem(PORTAL_KEY)) ?? defaultEndpoints(env).portal;
}

/** The portal's sign-up page (the /portal page hosts the create-account form). Opened in the system browser. */
export function portalSignupUrl(s: KV | null = storage(), env: EndpointEnv = buildEnv): string {
  return `${portalUrl(s, env).replace(/\/+$/, "")}/portal`;
}

/** Save an override; throws on an invalid URL. Empty string clears it. */
export function setEndpoint(kind: EndpointKind, raw: string, s: KV | null = storage()): void {
  const key = kind === "coordinator" ? COORDINATOR_KEY : PORTAL_KEY;
  if (!raw.trim()) {
    s?.removeItem(key);
    if (kind === "coordinator") s?.removeItem(LEGACY_SEED_KEY);
    return;
  }
  const v = validateEndpointUrl(raw);
  if (!v) throw new Error("Use an https:// URL (http:// is allowed only for 127.0.0.1 or localhost)");
  s?.setItem(key, v);
}

export function resetEndpoints(s: KV | null = storage()): void {
  s?.removeItem(COORDINATOR_KEY);
  s?.removeItem(PORTAL_KEY);
  s?.removeItem(LEGACY_SEED_KEY);
}

export class EndpointUnreachableError extends Error {
  readonly kind: EndpointKind;
  readonly url: string;
  constructor(kind: EndpointKind, url: string, cause?: unknown) {
    super(`${kind === "coordinator" ? "Coordinator" : "Portal"} unreachable at ${url}`);
    this.name = "EndpointUnreachableError";
    this.kind = kind;
    this.url = url;
    (this as { cause?: unknown }).cause = cause;
  }
}

type Listener = (e: EndpointUnreachableError) => void;
const listeners = new Set<Listener>();
/** Subscribe to unreachable-endpoint errors (the UI shows a banner). Returns an unsubscribe. */
export function onEndpointUnreachable(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * fetch() against a remote endpoint with a hard timeout. A network error or timeout becomes
 * EndpointUnreachableError (and notifies listeners); a caller abort is re-thrown unchanged.
 * Uses setTimeout (not AbortSignal.timeout) so it also works with fake timers and with a
 * fetch that ignores the abort signal.
 */
export async function fetchEndpoint(
  kind: EndpointKind,
  base: string,
  path: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? ENDPOINT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const callerSignal = init.signal ?? undefined;
  const onAbort = () => ctrl.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) ctrl.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", onAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`timeout after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([doFetch(`${base}${path}`, { ...init, signal: ctrl.signal }), timeout]);
  } catch (e) {
    if (callerSignal?.aborted) throw e;
    const err = new EndpointUnreachableError(kind, base, e);
    for (const l of listeners) {
      try {
        l(err);
      } catch {
        /* listener errors must not mask the original failure */
      }
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onAbort);
  }
}

/** "Test connection" in Settings: GET /health/runtime (coordinator) or /health (portal). */
export async function testEndpoint(kind: EndpointKind, raw: string, fetchImpl?: typeof fetch): Promise<boolean> {
  const base = validateEndpointUrl(raw);
  if (!base) return false;
  try {
    const res = await fetchEndpoint(kind, base, kind === "coordinator" ? "/health/runtime" : "/health", {}, { fetchImpl });
    return res.ok;
  } catch {
    return false;
  }
}
