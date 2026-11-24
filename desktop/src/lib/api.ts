import { localAgentUsable, parseAgentStatus, shouldDropToken, statusFromTokenError, type LocalAgentStatus } from "./agent-status";
import type { EngineMode } from "./permission-modes";
import type { AttachmentPayload } from "./attachments";
import type { WebStatus } from "./web-tool";
import { fetchLocalService, serviceErrorText } from "./local-service";
import { compactPaidTokensSetting } from "./compaction";
import { replyAskCSatsSetting, replyAskUsdSetting } from "./cost-check";
import { coordinatorUrl, defaultEndpoints, fetchEndpoint, portalUrl, type EndpointKind } from "./endpoints";
import type {
  HealthRuntime,
  CoordinatorStatus,
  MeshPeer,
  PeerReputation,
  NodeIdentity,
  DashboardOverview,
  ModelInfo,
  OllamaModel,
  OllamaRunningModel,
  SystemMetrics,
} from "./types";

// ---------------------------------------------------------------------------
// Backend detection: try local first, fall back to remote Fly URLs
// ---------------------------------------------------------------------------

let useRemote = true;
let initialDetectDone = false;

// #72: set from the desktop shell; "port_occupied" means :4301 isn't our agent.
let _agentStatus: LocalAgentStatus = "unknown";
let _localToken: string | null = null;

/** Record the shell's status; any state other than our own live agent drops the cached token. */
function setAgentStatus(status: LocalAgentStatus): LocalAgentStatus {
  _agentStatus = status;
  if (shouldDropToken(status)) _localToken = null;
  return status;
}

/** Local agent status from the desktop shell (#72), for the UI. */
export async function localAgentStatus(): Promise<LocalAgentStatus> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    setAgentStatus(parseAgentStatus(await invoke<string>("get_agent_status")));
  } catch {
    // Not running inside Tauri (dev / web build).
  }
  return _agentStatus;
}

/** Retry spawning the local agent after the user freed :4301 (#72). */
export async function retryLocalAgent(): Promise<LocalAgentStatus> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    _localToken = null;
    setAgentStatus(parseAgentStatus(await invoke<string>("retry_local_agent")));
    if (_agentStatus === "spawned" || _agentStatus === "verified") await detectBackend();
  } catch {
    // Not running inside Tauri.
  }
  return _agentStatus;
}

/** "Restart now": the shell stops EdgeCoder's local service and starts it at once. */
export async function restartLocalService(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  _localToken = null;
  resetIdeToken();
  setAgentStatus(parseAgentStatus(await invoke<string>("restart_local_service")));
}

/** "View log": the last lines of ~/.edgecoder/agent.log, read by the shell (works with the service down). */
export async function readServiceLog(): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("read_service_log");
}

/**
 * The service came back (service-status.ts): forget tokens from before the restart and detect the
 * local backend again, so pages that fell back to remote mode at launch use it.
 */
export async function serviceCameBack(): Promise<void> {
  _localToken = null;
  resetIdeToken();
  await detectBackend();
}

async function tryLocalHealth(): Promise<boolean> {
  // #72: never treat an unverified :4301 listener as our agent.
  if (!localAgentUsable(await localAgentStatus())) return false;
  try {
    const res = await fetch("http://127.0.0.1:4301/health/runtime", {
      signal: AbortSignal.timeout(2000),
    });
    console.log("[api] tryLocalHealth:", res.ok, res.status);
    return res.ok;
  } catch (e) {
    console.warn("[api] tryLocalHealth failed:", (e as Error).message);
    return false;
  }
}

async function detectBackend(): Promise<void> {
  if (!initialDetectDone) {
    // First call: retry with exponential backoff while agent boots
    const delays = [500, 1000, 2000, 2000, 2000, 2000, 2000, 2000];
    for (const delay of delays) {
      if (await tryLocalHealth()) {
        useRemote = false;
        initialDetectDone = true;
        schedulePoll();
        return;
      }
      await new Promise((r) => setTimeout(r, delay));
    }
    // Final attempt after last delay
    useRemote = !(await tryLocalHealth());
    initialDetectDone = true;
    schedulePoll();
    return;
  }

  // Subsequent calls: single attempt
  const wasRemote = useRemote;
  useRemote = !(await tryLocalHealth());
  if (useRemote !== wasRemote) schedulePoll();
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePoll(): void {
  if (pollTimer !== null) clearTimeout(pollTimer);
  const interval = useRemote ? 5_000 : 30_000;
  pollTimer = setTimeout(async () => {
    await detectBackend();
    schedulePoll();
  }, interval);
}

/**
 * Resolves once the first backend detection completes or after 20s timeout. Outside a window (the
 * root suite's node tests import this module) there is no shell or local agent to find, and the
 * probes' retries and log lines outlived the test file (Vitest then failed the run with
 * EnvironmentTeardownError), so nothing is started there; useRemote stays true, as detection
 * would have left it.
 */
export const backendReady: Promise<void> = typeof window === "undefined" ? Promise.resolve() : Promise.race([
  Promise.all([detectBackend(), getLocalToken()]).then(() => {
    console.log("[api] backendReady resolved — useRemote:", useRemote);
  }),
  new Promise<void>((resolve) => {
    setTimeout(() => {
      console.warn("[api] backendReady timed out after 20s — proceeding with useRemote:", useRemote);
      initialDetectDone = true;
      resolve();
    }, 20_000);
  }),
]);

/** True when no local agent is running (all agent/inference calls go remote). */
export function isRemoteMode(): boolean {
  return useRemote;
}

// #35: remote hosts come from Settings / VITE_COORDINATOR_URL / VITE_PORTAL_URL (see endpoints.ts).
function agentBase(): string {
  if (import.meta.env.DEV) return "/api";
  return useRemote ? coordinatorUrl() : "http://127.0.0.1:4301";
}

function portalBase(): string {
  return portalUrl();
}

/** Which remote endpoint a base URL is, so failures surface as "unreachable" (#35). */
function remoteKind(base: string): EndpointKind | null {
  if (import.meta.env.DEV) return null;
  if (useRemote && base === coordinatorUrl()) return "coordinator";
  if (base === portalUrl()) return "portal";
  return null;
}

function apiFetch(base: string, path: string, init: RequestInit): Promise<Response> {
  const kind = remoteKind(base);
  if (kind) return fetchEndpoint(kind, base, path, init);
  return fetch(`${base}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(10_000) });
}

// ---------------------------------------------------------------------------
// Session token persistence (desktop — HttpOnly cookies don't survive restarts)
// ---------------------------------------------------------------------------

const SESSION_TOKEN_KEY = "edgecoder_session_token";

function saveSessionToken(token: string): void {
  try { localStorage.setItem(SESSION_TOKEN_KEY, token); } catch {}
}
export function loadSessionToken(): string | null {
  try { return localStorage.getItem(SESSION_TOKEN_KEY); } catch { return null; }
}
export function clearSessionToken(): void {
  try { localStorage.removeItem(SESSION_TOKEN_KEY); } catch {}
}
function authHeaders(): Record<string, string> {
  const token = loadSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// The desktop shell may run its own Ollama on another loopback port (see lib/local-compute.ts);
// dev builds keep the Vite proxy.
let OLLAMA_BASE = import.meta.env.DEV ? "/ollama" : "http://localhost:11434";

/** Point model management at the Ollama the shell set up (prod only; validated by the caller). */
export function setOllamaBase(base: string): void {
  if (!import.meta.env.DEV) OLLAMA_BASE = base;
}

// ---------------------------------------------------------------------------
// Local agent token (for inference/admin auth)
// ---------------------------------------------------------------------------

async function getLocalToken(): Promise<string> {
  if (_localToken) return _localToken;
  // Retry a few times — Tauri invoke may not be ready immediately
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      _localToken = await invoke<string>("get_local_token");
      console.log("[api] getLocalToken attempt", attempt, "got token:", !!_localToken);
      if (_localToken) return _localToken;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status = statusFromTokenError(message);
      if (status) {
        // #72: the shell refused on purpose; don't retry, and don't use :4301.
        setAgentStatus(status);
        console.warn("[api] local agent token withheld:", status);
        break;
      }
      console.warn("[api] getLocalToken attempt", attempt, "failed:", message);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
  }
  _localToken = _localToken || "";
  return _localToken;
}

async function inferenceHeaders(): Promise<Record<string, string>> {
  const token = await getLocalToken();
  return token ? { "x-inference-token": token } : {};
}

export async function checkOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function get<T>(base: string, path: string, headers?: Record<string, string>): Promise<T> {
  const res = await apiFetch(base, path, { headers });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

async function post<T>(
  base: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const res = await apiFetch(base, path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`POST ${path}: ${res.status}`);
  return res.json();
}

async function del<T>(base: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`DELETE ${path}: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Coordinator (:4301)
// ---------------------------------------------------------------------------

export const getHealth = () =>
  get<HealthRuntime>(agentBase(), "/health/runtime");

export const getStatus = () =>
  get<CoordinatorStatus>(agentBase(), "/status");

export const getMeshPeers = () =>
  get<{ peers: MeshPeer[] }>(agentBase(), "/mesh/peers");

export const getMeshReputation = () =>
  get<{ peers: PeerReputation[] }>(agentBase(), "/mesh/reputation");

export const getIdentity = () =>
  get<NodeIdentity>(agentBase(), "/identity");

export async function testMeshToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${agentBase()}/security/blacklist`, {
      headers: { "x-mesh-token": token },
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Inference service — only available locally (:4302), not exposed on Fly
// ---------------------------------------------------------------------------

const INFERENCE_BASE = import.meta.env.DEV
  ? "/inference"
  : "http://127.0.0.1:4302";

export const getInferenceHealth = async () =>
  get<{ ok: boolean }>(INFERENCE_BASE, "/health", await inferenceHeaders());

export const getDashboardOverview = async () =>
  get<DashboardOverview>(INFERENCE_BASE, "/dashboard/api/overview", await inferenceHeaders());

export const getModelList = async () =>
  get<ModelInfo[]>(INFERENCE_BASE, "/model/list", await inferenceHeaders());

export const getModelStatus = async () =>
  get<unknown>(INFERENCE_BASE, "/model/status", await inferenceHeaders());

export const swapModel = async (model: string) =>
  post<unknown>(INFERENCE_BASE, "/model/swap", { model }, await inferenceHeaders());

export const pullModel = async (model: string) =>
  post<unknown>(INFERENCE_BASE, "/model/pull", { model }, await inferenceHeaders());

/** Curated install catalog served by the inference service (falls back to the bundled copy in lib/models.ts). */
export const getModelCatalog = async () =>
  get<{ version: string; categories: Record<string, string>; models: import("./models").CatalogModel[] }>(
    INFERENCE_BASE,
    "/model/catalog",
    await inferenceHeaders(),
  );

// ---------------------------------------------------------------------------
// Pull progress — try coordinator first, fall back to inference service
// ---------------------------------------------------------------------------

export interface ModelPullProgress {
  model: string;
  status: string;
  progressPct: number;
  completed: number;
  total: number;
  startedAtMs: number;
  error?: string;
}

async function fetchPullProgress(url: string, headers?: Record<string, string>): Promise<ModelPullProgress | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.status === "idle") return null;
    return data as ModelPullProgress;
  } catch {
    return null;
  }
}

/**
 * #37 / #119 review: pullModel() and swapModel() post to the inference service (4302), so read
 * its progress too. The agent/coordinator answers "idle" for pulls it didn't start, which used
 * to hide a 4302 pull. Ask both and prefer whichever has a pull in flight.
 */
export async function getModelPullProgress(): Promise<ModelPullProgress | null> {
  const [inference, agent] = await Promise.all([
    fetchPullProgress(`${INFERENCE_BASE}/model/pull/progress`, await inferenceHeaders()),
    fetchPullProgress(`${agentBase()}/model/pull/progress`),
  ]);
  return inference ?? agent;
}

// ---------------------------------------------------------------------------
// Ollama (:11434)
// ---------------------------------------------------------------------------

export const getOllamaTags = () =>
  get<{ models: OllamaModel[] }>(OLLAMA_BASE, "/api/tags");

export const getOllamaPs = () =>
  get<{ models: OllamaRunningModel[] }>(OLLAMA_BASE, "/api/ps");

export const deleteOllamaModel = (name: string) =>
  del<unknown>(OLLAMA_BASE, "/api/delete", { name });

export async function pullModelStream(
  name: string,
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(`${OLLAMA_BASE}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, stream: true }),
  });
  if (!res.ok) throw new Error(`POST /api/pull: ${res.status}`);
  return res.body!;
}

// ---------------------------------------------------------------------------
// Tauri system metrics
// ---------------------------------------------------------------------------

export async function getSystemMetrics(): Promise<SystemMetrics | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<SystemMetrics>("get_system_metrics");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Portal auth
// ---------------------------------------------------------------------------

export interface AuthUser {
  userId: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${portalBase()}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ email, password }),
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Login failed: ${res.status}`);
  }
  const data = await res.json();
  if (data.sessionToken) saveSessionToken(data.sessionToken);
  return data.user;
}

/** Thrown by signup() with the portal's error code (e.g. "email_already_registered"). */
export class SignupError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SignupError";
  }
}

const SIGNUP_MESSAGES: Record<string, string> = {
  email_already_registered: "An account with this email already exists.",
  terms_not_accepted: "To create an account, agree to the Terms, Privacy Policy and Acceptable Use Policy.",
  email_not_allowed: "That email address can't be used for an account.",
  invalid_request: "Check the email address, and use a password of at least 8 characters.",
};

export interface SignupInput {
  email: string;
  password: string;
  acceptTerms: boolean;
}

/**
 * Create an account. Like login(), a successful sign-up signs in: the portal returns a session
 * token, saved the same way. If this app is already signed in to that very account, the portal
 * answers ok with alreadySignedIn and no new token.
 */
export async function signup(input: SignupInput): Promise<AuthUser> {
  const res = await fetch(`${portalBase()}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      acceptTerms: input.acceptTerms,
    }),
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = typeof data.error === "string" ? data.error : `signup_failed_${res.status}`;
    const message = SIGNUP_MESSAGES[code] ?? (res.status === 429 ? "Too many attempts. Wait a minute and try again." : `Sign-up failed: ${code}`);
    throw new SignupError(code, message);
  }
  if (data.sessionToken) saveSessionToken(data.sessionToken);
  return data.user;
}

export async function getMe(): Promise<AuthUser> {
  const res = await fetch(`${portalBase()}/me`, {
    headers: { ...authHeaders() },
    credentials: "include",
  });
  if (!res.ok) {
    clearSessionToken();
    throw new Error("Not authenticated");
  }
  const data = await res.json();
  return data.user;
}

// ---------------------------------------------------------------------------
// Portal conversation API (:4305 /portal/api/*)
// ---------------------------------------------------------------------------

export interface PortalConversation {
  conversationId: string;
  userId: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PortalMessage {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  tokensUsed: number;
  creditsSpent: number;
  createdAtMs: number;
}

export async function portalListConversations(): Promise<PortalConversation[]> {
  const res = await fetch(`${portalBase()}/portal/api/conversations`, {
    headers: { ...authHeaders() },
    credentials: "include",
  });
  if (!res.ok) throw new Error(`List conversations failed: ${res.status}`);
  const body = await res.json();
  return body.conversations ?? body ?? [];
}

export async function portalCreateConversation(
  title?: string,
): Promise<string> {
  const res = await fetch(`${portalBase()}/portal/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ title }),
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Create conversation failed: ${res.status}`);
  const body = await res.json();
  return body.conversationId;
}

export async function portalGetMessages(
  conversationId: string,
): Promise<PortalMessage[]> {
  const res = await fetch(
    `${portalBase()}/portal/api/conversations/${conversationId}/messages`,
    { headers: { ...authHeaders() }, credentials: "include" },
  );
  if (!res.ok) throw new Error(`Get messages failed: ${res.status}`);
  const body = await res.json();
  return body.messages ?? body ?? [];
}

export async function portalRenameConversation(
  conversationId: string,
  title: string,
): Promise<void> {
  const res = await fetch(
    `${portalBase()}/portal/api/conversations/${conversationId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ title }),
      credentials: "include",
    },
  );
  if (!res.ok) throw new Error(`Rename conversation failed: ${res.status}`);
}

export async function portalDeleteConversation(
  conversationId: string,
): Promise<void> {
  const res = await fetch(
    `${portalBase()}/portal/api/conversations/${conversationId}`,
    {
      method: "DELETE",
      headers: { ...authHeaders() },
      credentials: "include",
    },
  );
  if (!res.ok) throw new Error(`Delete conversation failed: ${res.status}`);
}

/**
 * Stream chat through the portal server.
 *
 * The portal SSE format emits `data: {"content":"..."}` chunks (simpler than
 * the OpenAI-compatible format used by the IDE provider-server).
 */
export async function streamPortalChat(
  conversationId: string,
  message: string,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  onProgress?: (progress: StreamProgress) => void,
  /**
   * The chat's Web toggle: the portal runs the web tool (Auto compute, which can call tools) and
   * sends status lines ("Searching the web…") and the web tool's total with the numbered sources.
   */
  web?: { onStatus?: (message: string) => void; onWeb?: (event: Record<string, unknown>) => void; onWebOff?: (off: { reason: string; message: string }) => void },
): Promise<void> {
  const streamStart = Date.now();
  let tokenCount = 0;

  const res = await fetch(`${portalBase()}/portal/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ conversationId, message, ...(web ? { web: true, compute: { target: "auto" } } : {}) }),
    signal,
    credentials: "include",
  });

  if (!res.ok) throw new Error(`Portal chat request failed: ${res.status}`);
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;

      try {
        const chunk = JSON.parse(data);

        if (chunk.error) {
          // Portal signals errors like "stream_interrupted"
          throw new Error(`Stream error: ${chunk.error}`);
        }

        if (chunk.warning) {
          onProgress?.({
            tokenCount,
            elapsedMs: Date.now() - streamStart,
            warning: chunk.warning,
          });
        }
        if (typeof chunk.status === "string") web?.onStatus?.(chunk.status);
        if (chunk.web && typeof chunk.web === "object") web?.onWeb?.(chunk.web);
        if (chunk.webOff && typeof chunk.webOff === "object") web?.onWebOff?.({ reason: String(chunk.webOff.reason ?? ""), message: String(chunk.webOff.message ?? "") });

        if (chunk.content) {
          tokenCount++;
          onChunk(chunk.content);
          onProgress?.({
            tokenCount,
            elapsedMs: Date.now() - streamStart,
          });
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("Stream error:")) {
          throw e;
        }
        // Skip malformed JSON — non-critical
      }
    }
  }
}

export async function logout(): Promise<void> {
  await fetch(`${portalBase()}/auth/logout`, {
    method: "POST",
    headers: { ...authHeaders() },
    credentials: "include",
  });
  clearSessionToken();
}

/** OAuth always routes through the remote portal — local has no portal server,
 *  and the redirect_uri registered with Microsoft is the production URL. */
function oauthPortalBase(): string {
  return defaultEndpoints().portal;
}

// Login CSRF guard: each OAuth start gets a random verifier kept in this window's sessionStorage; the
// portal binds sha256(verifier) (appChallenge) to the one-time token it puts on the deep link, and
// /auth/oauth/mobile/complete only redeems the token with the matching verifier. A callback the app
// did not start (no pending verifier) is ignored.
const OAUTH_PENDING_KEY = "edgecoder.oauthPending";
const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function oauthChallengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** The verifier of the OAuth flow this app started, if one is pending and fresh. */
export function pendingOAuthVerifier(now: number = Date.now()): string | null {
  try {
    const raw = sessionStorage.getItem(OAUTH_PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { verifier?: unknown; startedAtMs?: unknown };
    if (typeof p.verifier !== "string" || typeof p.startedAtMs !== "number") return null;
    if (now - p.startedAtMs > OAUTH_PENDING_TTL_MS || now < p.startedAtMs) {
      sessionStorage.removeItem(OAUTH_PENDING_KEY);
      return null;
    }
    return p.verifier;
  } catch {
    return null;
  }
}

export function clearPendingOAuth(): void {
  try {
    sessionStorage.removeItem(OAUTH_PENDING_KEY);
  } catch {
    // storage unavailable
  }
}

export async function getOAuthStartUrl(provider: "google" | "microsoft" | "github"): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const verifier = base64Url(bytes);
  sessionStorage.setItem(OAUTH_PENDING_KEY, JSON.stringify({ verifier, startedAtMs: Date.now() }));
  const redirect = encodeURIComponent("edgecoder://oauth-callback");
  const challenge = encodeURIComponent(await oauthChallengeFor(verifier));
  return `${oauthPortalBase()}/auth/oauth/${provider}/start?appRedirect=${redirect}&appChallenge=${challenge}`;
}

/** Redeem the deep link's one-time token with this app's pending verifier (used once). */
export async function completeOAuthWithToken(mobileToken: string): Promise<AuthUser> {
  const verifier = pendingOAuthVerifier();
  if (!verifier) throw new Error("No sign-in was started from this app");
  clearPendingOAuth();
  const res = await fetch(`${oauthPortalBase()}/auth/oauth/mobile/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ token: mobileToken, verifier }),
  });
  if (!res.ok) throw new Error("OAuth sign-in failed");
  const data = await res.json();
  if (data.sessionToken) saveSessionToken(data.sessionToken);
  return data.user;
}

// ---------------------------------------------------------------------------
// GitHub integration API (portal)
// ---------------------------------------------------------------------------

export async function getGitHubStatus(): Promise<{ connected: boolean; login?: string; avatarUrl?: string }> {
  const res = await fetch(`${portalBase()}/portal/api/github/status`, {
    headers: authHeaders(),
    credentials: "include",
  });
  if (!res.ok) return { connected: false };
  return res.json();
}

export async function getGitHubToken(): Promise<string | null> {
  const res = await fetch(`${portalBase()}/portal/api/github/token`, {
    headers: authHeaders(),
    credentials: "include",
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.accessToken ?? null;
}

/** The last agent GitHub token read from the portal (short-lived cache; never logged). */
let agentGitHubCache: { token: string | null; at: number } | null = null;

/**
 * The agent's GitHub connection (Settings → Integrations → GitHub for the agent), read fresh from
 * the portal (cached a minute, ten seconds when not connected) and handed to the local IDE server,
 * so the Code view, shared sessions and bots all use it. Read at send time, not once at startup:
 * a token fetched when a panel first mounted went stale or stayed null after connecting later.
 * A failed read keeps the last good token. `force` re-reads (after connect or disconnect).
 */
export async function agentGitHubToken(force = false): Promise<string | null> {
  const c = agentGitHubCache;
  if (!force && c && Date.now() - c.at < (c.token ? 60_000 : 10_000)) return c.token;
  let token: string | null;
  let reason = "";
  try {
    const res = await fetch(`${portalBase()}/portal/api/github/token`, { headers: authHeaders(), credentials: "include", signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      token = ((await res.json()) as { accessToken?: string | null }).accessToken ?? null;
      if (!token) reason = "not connected";
    } else {
      token = null;
      reason = res.status === 404 ? "not connected" : res.status === 401 ? "you're signed out of EdgeCoder in the app" : `EdgeCoder answered HTTP ${res.status}`;
      if (res.status !== 404 && res.status !== 401 && c?.token) return c.token;
    }
  } catch {
    // Unreachable for now: keep what we had.
    if (c?.token) return c.token;
    token = null;
    reason = "EdgeCoder couldn't be reached to read it";
  }
  agentGitHubCache = { token, at: Date.now() };
  if (!isRemoteMode()) {
    void fsCall("POST", "/v1/ide/github/agent-token", token ? { token } : { token: null, reason }).catch(() => {});
  }
  return token;
}

export async function disconnectGitHub(): Promise<void> {
  await fetch(`${portalBase()}/portal/api/github/disconnect`, {
    method: "DELETE",
    headers: authHeaders(),
    credentials: "include",
  });
}

// ---------------------------------------------------------------------------
// Wallet API (portal)
// ---------------------------------------------------------------------------

/** Where payouts go: a Lightning address from the user's own wallet (portal /wallet/payout-destination). */
export interface PayoutDestinationView {
  accountId: string;
  network: string;
  destination: { kind: string; destination: string; updatedAtMs: number } | null;
  needsDestination: boolean;
  legacyAddressRetired: boolean;
  supportedKinds: string[];
  onchainSupported: boolean;
  registration?: { controlPlane: string; coordinator: string };
  /** The wallet's payment server changed; payouts are held until confirmed in the portal with an email code. */
  callbackChange?: { previousOrigin: string; newOrigin: string; changedAtMs: number | null } | null;
  /** A requested change: waiting for the emailed link/code, or confirmed and cooling off until activatesAtMs. */
  pendingDestination?: { kind: string; destination: string; first: boolean; confirmed: boolean; confirmExpiresAtMs: number; activatesAtMs: number | null } | null;
  cooldownHours?: number;
  firstCooldownHours?: number;
  /** The account is locked (receipt link): payouts and destination changes are paused. */
  locked?: boolean;
}

/**
 * The portal asked for a second factor (two-factor authentication is on for the account). With an
 * authenticator app, the app asks for the code and sends it again; with only a passkey, the action
 * has to be finished on the web (`webOnly`).
 */
export type TwoFactorRequired = { status: "two_factor_required"; methods: string[]; webOnly: boolean; detail: string; invalidCode: boolean };

/** The header the portal reads an inline second-factor code from (routes/account-security.ts). */
export const TWO_FACTOR_HEADER = "x-edgecoder-2fa-code";

function twoFactorResult(res: Response, body: Record<string, unknown>): TwoFactorRequired | null {
  const error = String(body.error ?? "");
  if (!((res.status === 403 && error === "two_factor_required") || (res.status === 401 && error === "two_factor_code_invalid"))) return null;
  const methods = Array.isArray(body.methods) ? body.methods.map(String) : [];
  return { status: "two_factor_required", methods, webOnly: !methods.includes("totp"), detail: String(body.detail ?? "Enter the code from your authenticator app."), invalidCode: error === "two_factor_code_invalid" };
}

export type PayoutDestinationSaveResult =
  | { status: "saved"; view: PayoutDestinationView }
  | { status: "verification_required"; challengeId: string; detail: string }
  | TwoFactorRequired
  | { status: "error"; error: string; detail: string };

export interface WalletSendRequest {
  requestId: string;
  destination: string;
  amountSats: number;
  note: string | null;
  status: string;
  createdAtMs: number;
}

export async function getPayoutDestination(): Promise<PayoutDestinationView> {
  const res = await fetch(`${portalBase()}/wallet/payout-destination`, {
    headers: { ...authHeaders() },
    credentials: "include",
  });
  if (res.status === 401) throw new Error("Sign in to see where payouts go.");
  if (!res.ok) throw new Error("Could not load your payout destination.");
  return res.json();
}

/**
 * Save (or change) the payout destination. It returns verification_required until the change is
 * confirmed from the email (its link, or its code sent back here); a confirmed change then waits out
 * the cooling-off (view.pendingDestination). With 2FA on, it may first return two_factor_required:
 * call again with `twoFactorCode`.
 */
export async function savePayoutDestination(input: { destination: string; challengeId?: string; emailCode?: string; twoFactorCode?: string }): Promise<PayoutDestinationSaveResult> {
  let res: Response;
  const { twoFactorCode, ...payload } = input;
  try {
    res = await fetch(`${portalBase()}/wallet/payout-destination`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeaders(), ...(twoFactorCode ? { [TWO_FACTOR_HEADER]: twoFactorCode } : {}) },
      credentials: "include",
      body: JSON.stringify(payload),
    });
  } catch {
    return { status: "error", error: "network", detail: "Could not reach EdgeCoder. Check your connection and try again." };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 200) return { status: "saved", view: body as unknown as PayoutDestinationView };
  const tf = twoFactorResult(res, body);
  if (tf) return tf;
  if (res.status === 202 && body.verificationRequired) {
    return { status: "verification_required", challengeId: String(body.challengeId), detail: String(body.detail ?? "We emailed you a code.") };
  }
  if (res.status === 429) return { status: "error", error: "rate_limited", detail: "Too many attempts. Wait a minute and try again." };
  return { status: "error", error: String(body.error ?? res.status), detail: String(body.detail ?? `Could not save (${body.error ?? res.status}).`) };
}

/** Payout balance as the coordinator reports it (GET /economy/payouts/:account through the portal). */
export interface PayoutBalance {
  earnedMsat: number;
  /** Earned but inside the earnings hold (PAYOUT_EARNINGS_HOLD_MS: 24 h on mainnet, 0 on regtest). */
  heldMsat: number;
  maturesAtMs: number | null;
  paidMsat: number;
  pendingMsat: number;
  payableMsat: number;
}
export interface PayoutPolicyView {
  network?: string;
  minPayoutSats?: number;
  maxFeeBps?: number;
  minFeeFloorSats?: number;
  autoMinPayoutSats?: number;
  lightningEnabled?: boolean;
  paused?: boolean;
  limits?: { maxSingleSats?: number; maxAccountDailySats?: number; maxGlobalDailySats?: number };
  /** Bitcoin on-chain (ONCHAIN_ENABLED on the coordinator); absent or enabled:false = "Coming soon". */
  onchain?: OnchainPolicyView;
}
export interface OnchainPolicyView {
  enabled: boolean;
  depositConfirmations: number;
  depositMinSats: number;
  depositMaxSats: number;
  payoutMinSats: number;
  payoutIntervalMs: number;
  payoutMaxFeeRateSatVb: number;
  payoutFeePayer: "host" | "edgecoder";
  /** Most a host-paid payout is charged in network fee (0 when EdgeCoder pays). */
  payoutMaxFeeSats: number;
  payoutConfirmations: number;
}
export interface PayoutRow { createdAtMs: number; kind: string; amountMsat: number; feeMsat: number; status: string; error?: string; txid?: string; destination?: string }

/** One on-chain deposit as the coordinator reports it. */
export interface OnchainDeposit {
  txid: string;
  vout: number;
  amountSats: number;
  confirmations: number;
  requiredConfirmations: number;
  status: "pending" | "credited" | "below_minimum" | "held" | "dropped" | "reversed";
  seenAtMs: number;
  creditedAtMs: number | null;
}
/** Fund with Bitcoin: the account's deposit address and its deposits (portal /portal/api/wallet/onchain*). */
export interface OnchainFunding {
  enabled: boolean;
  network: string;
  address: string | null;
  uri: string | null;
  confirmationsRequired?: number;
  minSats?: number;
  maxSats?: number;
  deposits: OnchainDeposit[];
}

async function onchainCall(method: "GET" | "POST", path: string): Promise<OnchainFunding> {
  let res: Response;
  try {
    res = await fetch(`${portalBase()}${path}`, {
      method,
      headers: method === "POST" ? { "content-type": "application/json", ...authHeaders() } : { ...authHeaders() },
      credentials: "include",
      body: method === "POST" ? "{}" : undefined,
    });
  } catch {
    throw new Error("Could not reach EdgeCoder. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401) throw new Error("Sign in to fund with Bitcoin.");
  if (!res.ok) throw new Error(String(body.detail ?? (body.error === "onchain_disabled" ? "Funding with Bitcoin is not enabled on this coordinator." : `Could not load your Bitcoin deposits (${body.error ?? res.status}).`)));
  return body as unknown as OnchainFunding;
}

/** The account's deposit address (a fresh one after each deposit) and its deposits. */
export function getOnchainAddress(): Promise<OnchainFunding> {
  return onchainCall("POST", "/portal/api/wallet/onchain/address");
}
/** The account's deposits with their confirmations (no new address). */
export function getOnchainDeposits(): Promise<OnchainFunding> {
  return onchainCall("GET", "/portal/api/wallet/onchain");
}

/** The portal's one-call wallet view (/portal/api/wallet/overview): network, BTC/USD, both fees, payouts. */
export interface WalletOverview {
  connected: boolean;
  network: string;
  networkSource: "coordinator" | "portal";
  cSats: number | null;
  earnedSats: number | null;
  btcUsd: number | null;
  rateStale: boolean;
  fees: { purchaseFeeBps: number | null; networkFeeBps: number | null };
  topup: { minSats: number; maxSats: number };
  payouts: { balance: PayoutBalance | null; policy: PayoutPolicyView | null; payouts: PayoutRow[] } | null;
}

// ---------------------------------------------------------------------------
// Getting started (portal /portal/api/onboarding): progress per account, shared with the web
// ---------------------------------------------------------------------------

import type { OnboardingSignals, OnboardingState, OnboardingGoal, RoutingPolicy, StepId } from "./onboarding";
export interface OnboardingAnswer {
  state: OnboardingState | null;
  signals: OnboardingSignals;
  show: boolean;
}
export interface OnboardingPatch {
  goal?: OnboardingGoal | null;
  current?: StepId;
  done?: StepId[];
  skipped?: StepId[];
  routing?: RoutingPolicy | null;
  dismissed?: boolean;
  completed?: boolean;
  firstTask?: true;
  reset?: true;
}

export async function getOnboarding(): Promise<OnboardingAnswer> {
  const res = await fetch(`${portalBase()}/portal/api/onboarding`, { headers: { ...authHeaders() }, credentials: "include" });
  if (!res.ok) throw new Error(`Could not load your progress (${res.status}).`);
  return res.json();
}

export async function saveOnboarding(patch: OnboardingPatch): Promise<OnboardingAnswer> {
  const res = await fetch(`${portalBase()}/portal/api/onboarding`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    credentials: "include",
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Could not save your progress (${res.status}).`);
  return res.json();
}

export async function getWalletOverview(): Promise<WalletOverview> {
  const res = await fetch(`${portalBase()}/portal/api/wallet/overview`, { headers: { ...authHeaders() }, credentials: "include" });
  if (res.status === 401) throw new Error("Sign in to see your wallet.");
  if (!res.ok) throw new Error("Could not load your wallet.");
  return res.json();
}

/** Which payment paths the coordinator has on (docs/design/noncustodial-payments.md); all-off when unknown. */
export interface PaymentPaths {
  prepaid: boolean;
  directReservations: boolean;
  nwc: boolean;
}
export async function getPaymentPaths(): Promise<PaymentPaths> {
  try {
    const res = await fetch(`${portalBase()}/portal/api/payments/paths`, { headers: { ...authHeaders() }, credentials: "include" });
    if (!res.ok) return { prepaid: true, directReservations: false, nwc: false };
    const j = (await res.json()) as Partial<PaymentPaths>;
    return { prepaid: j.prepaid !== false, directReservations: j.directReservations === true, nwc: j.nwc === true };
  } catch {
    return { prepaid: true, directReservations: false, nwc: false };
  }
}

export type WithdrawResult =
  | { status: "paid"; amountMsat: number }
  | { status: "verification_required"; challengeId: string; amountMsat: number; detail: string }
  | TwoFactorRequired
  | { status: "error"; code: string; detail: string; unlocksAtMs?: number };

/**
 * Withdraw to a BOLT11 invoice through the portal (an emailed code confirms it: first call returns
 * verification_required). With 2FA on, either call may return two_factor_required: call again with
 * `twoFactorCode`. While a new payout address cools off, it returns code payout_destination_cooling_off.
 */
export async function withdrawToInvoice(input: { bolt11: string; challengeId?: string; emailCode?: string; twoFactorCode?: string }): Promise<WithdrawResult> {
  let res: Response;
  const { twoFactorCode, ...payload } = input;
  try {
    res = await fetch(`${portalBase()}/wallet/payouts/withdraw`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(), ...(twoFactorCode ? { [TWO_FACTOR_HEADER]: twoFactorCode } : {}) },
      credentials: "include",
      body: JSON.stringify(payload),
    });
  } catch {
    return { status: "error", code: "network", detail: "Could not reach EdgeCoder. Check your connection and try again." };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  const tf = twoFactorResult(res, body);
  if (tf) return tf;
  if (res.status === 202 && body.verificationRequired) {
    return { status: "verification_required", challengeId: String(body.challengeId), amountMsat: Number(body.amountMsat ?? 0), detail: String(body.detail ?? "We emailed you a code.") };
  }
  if (res.ok && body.ok) return { status: "paid", amountMsat: Number(body.payout?.amountMsat ?? 0) };
  return {
    status: "error",
    code: String(body.code ?? body.error ?? res.status),
    detail: String(body.detail ?? `Withdrawal failed (${body.code ?? body.error ?? res.status}).`),
    ...(typeof body.unlocksAtMs === "number" ? { unlocksAtMs: body.unlocksAtMs } : {}),
  };
}

export async function getWalletSendRequests(): Promise<WalletSendRequest[]> {
  const res = await fetch(`${portalBase()}/wallet/send/requests`, {
    headers: { ...authHeaders() },
    credentials: "include",
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.requests ?? [];
}

// ---------------------------------------------------------------------------
// IDE chat provider (:4304)
// ---------------------------------------------------------------------------

// The IDE provider server requires `Authorization: Bearer <token>` (#4). The
// token lives in ~/.edgecoder/ide-token and is read via the Tauri command
// `get_ide_token`. It is only ever sent to the local IDE server, never to the portal.
let _ideToken: string | null = null;

async function getIdeToken(): Promise<string> {
  if (_ideToken) return _ideToken;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    _ideToken = (await invoke<string>("get_ide_token")) || null;
  } catch (e) {
    console.warn("[api] get_ide_token failed:", (e as Error).message ?? String(e));
    _ideToken = null;
  }
  return _ideToken ?? "";
}

/** Forget the cached token (e.g. after a 401 when the server created a new file). */
function resetIdeToken(): void {
  _ideToken = null;
}

async function ideHeaders(): Promise<Record<string, string>> {
  const token = await getIdeToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function ideBase(): string {
  return import.meta.env.DEV ? "/chat" : "http://127.0.0.1:4304";
}

function isUnauthorized(e: unknown): boolean {
  return String(e).includes(": 401");
}

/**
 * fetch() against the local IDE server with the cached token. On 401 the token
 * file may have been regenerated, so drop the cached value, reread it and retry once.
 */
async function ideFetch(url: string, init: RequestInit): Promise<Response> {
  // While the local service restarts (an auto-update), retry for ~10 s instead of failing with "Load failed".
  const send = async () =>
    fetchLocalService(
      async () => fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...(await ideHeaders()) } }),
      { method: init.method, signal: init.signal, probe: probeLocalService },
    );
  let res = await send();
  if (res.status === 401) {
    resetIdeToken();
    res = await send();
  }
  return res;
}

/** Whether the local IDE server answers at all (a public GET: no preflight). */
export async function probeLocalService(): Promise<boolean> {
  try {
    return (await fetch(`${ideBase()}/health`, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

/** Same stale-token handling for the get()/post() helpers, which throw on non-2xx. */
async function withIdeRetry<T>(call: (headers: Record<string, string>) => Promise<T>): Promise<T> {
  try {
    return await call(await ideHeaders());
  } catch (e) {
    if (!isUnauthorized(e)) throw e;
    resetIdeToken();
    return call(await ideHeaders());
  }
}

function chatBase(): string {
  if (import.meta.env.DEV) return "/chat";
  return useRemote ? `${portalBase()}/portal/api` : "http://127.0.0.1:4304";
}

export interface StreamRouteInfo {
  route: string;
  label: string;
  model: string;
  p95Ms?: number;
  concurrent?: number;
}

export interface StreamProgress {
  tokenCount: number;
  elapsedMs: number;
  routeInfo?: StreamRouteInfo;
  warning?: string;
}

export async function streamChat(
  messages: Array<{ role: string; content: string }>,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  onProgress?: (progress: StreamProgress) => void,
  requestedModel?: string,
): Promise<void> {
  const streamStart = Date.now();
  let tokenCount = 0;
  let routeInfo: StreamRouteInfo | undefined;

  const toLocalIde = !(useRemote && !import.meta.env.DEV);
  const res = await (toLocalIde ? ideFetch : fetch)(`${chatBase()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: requestedModel ?? "edgecoder-local",
      messages,
      stream: true,
      temperature: 0.7,
      max_tokens: 4096,
      // Settings → Active work lists it as a chat, not an API call (the IDE server only).
      ...(toLocalIde ? { user: "edgecoder-desktop-chat" } : {}),
    }),
    signal,
  });

  if (!res.ok) throw new Error(`Chat request failed: ${res.status}`);
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;

      try {
        const chunk = JSON.parse(data);

        // Handle route_info metadata event
        if (chunk.route_info) {
          routeInfo = chunk.route_info;
          onProgress?.({ tokenCount, elapsedMs: Date.now() - streamStart, routeInfo });
          continue;
        }

        const content = chunk.choices?.[0]?.delta?.content;
        if (content) {
          tokenCount++;
          onChunk(content);
          onProgress?.({ tokenCount, elapsedMs: Date.now() - streamStart, routeInfo });
        }
      } catch {
        // Skip malformed chunks
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Capacity & active jobs
// ---------------------------------------------------------------------------

export interface AgentCapacity {
  agentId: string;
  os: string;
  version: string;
  mode: "swarm-only" | "ide-enabled";
  maxConcurrentTasks: number;
  connectedPeers: string[];
  blacklisted: boolean;
  lastSeenMs: number;
  powerPolicy: { allowCoordinatorTasks: boolean; reason?: string };
  diagnostics?: {
    lastEventAtMs: number;
    lastEventMessage: string;
    recentCount: number;
  };
}

export interface CapacityResponse {
  totals: {
    agentsConnected: number;
    totalCapacity: number;
    swarmEnabledCount: number;
    localOllamaCount: number;
    ideEnabledCount: number;
    activeTunnels: number;
    blacklistedAgents: number;
  };
  agents: AgentCapacity[];
}

export const getCapacity = () =>
  get<CapacityResponse>(agentBase(), "/capacity");

// ---------------------------------------------------------------------------
// Swarm model availability
// ---------------------------------------------------------------------------

export interface SwarmModelInfo {
  model: string;
  paramSize: number;
  agentCount: number;
  avgLoad: number;
}

export const getAvailableModels = () =>
  get<SwarmModelInfo[]>(agentBase(), "/models/available");

// ---------------------------------------------------------------------------
// IDE Agent (:4304)
// ---------------------------------------------------------------------------

export async function ideSetProject(projectRoot: string): Promise<void> {
  await withIdeRetry((h) => post(ideBase(), "/v1/ide/project", { projectRoot }, h));
}

export async function ideGetProject(): Promise<string | null> {
  try {
    const data = await withIdeRetry((h) => get<{ projectRoot: string | null }>(ideBase(), "/v1/ide/project", h));
    return data.projectRoot;
  } catch {
    return null;
  }
}

/**
 * Answer a chat or bot tool call; `always` also keeps the call's "Always allow" rules for its project.
 * `forRun` ("Allow for the rest of this run") answers a web-page guard ask for the rest of the turn.
 * A cost check (cost-check.ts) answers with `choice`: continue, switch (to its suggested model) or stop.
 */
export async function ideSendToolApproval(id: string, approved: boolean, always = false, choice?: "continue" | "switch" | "stop", forRun = false): Promise<void> {
  await withIdeRetry((h) => post(ideBase(), "/v1/ide/tool-approval", { id, approved, ...(always ? { always: true } : {}), ...(forRun ? { forRun: true } : {}), ...(choice ? { choice } : {}) }, h));
}

/** Every project's "always allow" answers (Settings → General). */
export interface ProjectPermissionsView {
  shell: string[];
  rules?: string[];
  edits?: boolean;
}
export const listPermissions = () => fsCall<{ projects: Record<string, ProjectPermissionsView> }>("GET", "/v1/ide/permissions").then((r) => r.projects ?? {});
/** Remove one rule (`npm test:*`), an older command name, or "edits". */
export const removePermission = (projectRoot: string, rule: string) => fsCall<{ removed: boolean }>("POST", "/v1/ide/permissions/remove", { projectRoot, rule });

/** Settings → General → Sandbox: Auto runs unchecked commands in the OS sandbox (src/apps/ide/sandbox-settings.ts). */
export interface SandboxSettingView {
  enabled: boolean;
  available: boolean;
  kind: "sandbox-exec" | "bwrap" | null;
  why: string;
}
export const getSandboxSetting = () => fsCall<SandboxSettingView>("GET", "/v1/ide/sandbox");
export const setSandboxSetting = (enabled: boolean) => fsCall<SandboxSettingView>("POST", "/v1/ide/sandbox", { enabled });

export interface IdeStreamEvent {
  type: "text" | "status" | "tool_call" | "tool_result" | "diff" | "shell_request" | "shell_output" | "plan" | "turn" | "file_change" | "usage" | "web" | "web_off" | "context" | "compacted" | "cost_note" | "done";
  [key: string]: unknown;
}

/**
 * A model id from the compute picker as the IDE chat takes it: "network/m@gpu", "mine/m" and
 * "reserved/<id>/m" run off this computer (billed in cSats on the network), anything else here.
 */
export function computeFields(id?: string): { model?: string; compute?: { target: "mine" | "network" | "reserved" | "auto"; computeClass?: string; reservationId?: string } } {
  if (!id) return {};
  if (id === "auto") return { compute: { target: "auto" } };
  if (id.startsWith("mine/")) return { model: id.slice(5), compute: { target: "mine" } };
  const reserved = /^reserved\/([^/]+)\/(.+)$/.exec(id);
  if (reserved) return { model: reserved[2], compute: { target: "reserved", reservationId: reserved[1] } };
  if (id.startsWith("network/")) {
    const rest = id.slice(8);
    const at = rest.lastIndexOf("@");
    const cls = at > 0 ? rest.slice(at + 1) : "";
    return ["cpu", "apple", "gpu", "gpu.dc"].includes(cls)
      ? { model: rest.slice(0, at), compute: { target: "network", computeClass: cls } }
      : { model: rest, compute: { target: "network", computeClass: "any" } };
  }
  return { model: id };
}

export async function streamIdeChat(
  messages: Array<{ role: string; content: string }>,
  projectRoot: string,
  onEvent: (event: IdeStreamEvent) => void,
  signal?: AbortSignal,
  requestedModel?: string,
  githubToken?: string | null,
  /**
   * The permission mode (ask, auto-edits, auto, plan, full; permission-modes.ts). The older values
   * "none" / "edits" still work.
   */
  permission: "none" | "edits" | EngineMode = "none",
  /** Which view sent it, for Settings → Active work and Tasks. */
  origin?: "chat" | "code",
  /** Files attached to the last message (images/PDFs reach only a model that can see them). */
  attachments?: AttachmentPayload[],
  /** The chat's Web toggle: offer web_search and read_page (docs/web-tool.md). */
  web = false,
  /** The Code view's Helpers switch (docs/tentacles.md): `sessionId` is the chat's id. */
  helpers?: { sessionId: string; enabled: boolean; maxParallel: number; budgetCSats: number },
  /** The Code view chat's id: its mirror on the provider shows the turn to your phone (code-chat-mirror.ts). */
  chatId?: string,
): Promise<void> {
  const base = ideBase();
  const res = await ideFetch(`${base}/v1/ide/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      ...computeFields(requestedModel),
      projectRoot,
      ...(permission === "none" || permission === "edits"
        ? { autoApprove: permission }
        : { mode: permission, autoApprove: permission === "auto-edits" || permission === "auto" || permission === "full" ? "edits" : "none" }),
      ...(origin ? { origin } : {}),
      ...(githubToken ? { githubToken } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(web ? { web: true } : {}),
      ...(helpers ? { helpers } : {}),
      // Settings → General → "Compact long chats at … tokens" (a paid lead compacts past it).
      compactPaidTokens: compactPaidTokensSetting(),
      // Settings → General → "Ask before a reply spends more than …" (a paid lead asks past it).
      replyAskCSats: replyAskCSatsSetting(),
      replyAskUsd: replyAskUsdSetting(),
      ...(chatId ? { chatId } : {}),
    }),
    signal,
  });

  if (!res.ok) throw new Error(`IDE chat request failed: ${res.status}`);
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;

      try {
        const event = JSON.parse(data) as IdeStreamEvent;
        onEvent(event);
      } catch {
        // Skip malformed events
      }
    }
  }
}

/**
 * Summarize a chat's older messages (POST /v1/ide/compact, compaction.ts). `force`: now (`/compact`,
 * "Compact conversation"); otherwise only when the chat's model is paid and its history passed the
 * budget. The summary runs on a cheap model (this computer's for a local chat), never your
 * frontier key unless you turned that on.
 */
export async function ideCompact(messages: Array<{ role: "user" | "assistant"; content: string }>, requestedModel: string | undefined, force: boolean, signal?: AbortSignal): Promise<import("./compaction").CompactResult> {
  const res = await ideFetch(`${ideBase()}/v1/ide/compact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, ...computeFields(requestedModel), force, compactPaidTokens: compactPaidTokensSetting() }),
    signal,
  });
  if (!res.ok) throw new Error(`Compacting failed: ${res.status}`);
  return (await res.json()) as import("./compaction").CompactResult;
}

/** The SSE events of an IDE stream, one parsed object per `data:` line, until [DONE]. */
async function readIdeEvents(res: Response, onEvent: (event: IdeStreamEvent) => void): Promise<void> {
  if (!res.body) throw new Error("No response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;
      try {
        onEvent(JSON.parse(data) as IdeStreamEvent);
      } catch {
        // Skip malformed events
      }
    }
  }
}

/** /v1/ide/web-chat turned the web down for this reply ("needs_csats", "no_tools", "rate_limited"…). */
export class WebOffError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message || "Web search isn't available for this reply.");
    this.name = "WebOffError";
  }
}

/**
 * A chat without a project with Web on (/v1/ide/web-chat): the model with only
 * web_search and read_page, on the chat's compute. Same events as streamIdeChat.
 */
export async function streamIdeWebChat(
  messages: Array<{ role: string; content: string }>,
  onEvent: (event: IdeStreamEvent) => void,
  signal?: AbortSignal,
  requestedModel?: string,
): Promise<void> {
  const res = await ideFetch(`${ideBase()}/v1/ide/web-chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, ...computeFields(requestedModel) }),
    signal,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string; reason?: string };
    // Web isn't offered for this reply (no cSats, a model without tools): the caller answers without it.
    if (res.status === 409 && body.error === "web_off") throw new WebOffError(body.reason ?? "", body.message ?? "");
    throw new Error(body.message ?? `Web chat request failed: ${res.status}`);
  }
  await readIdeEvents(res, onEvent);
}

/**
 * Whether the chat's Web toggle can be on for this model (docs/web-tool.md): asked of this
 * computer's IDE server, or of the portal when no local agent runs (web chats there run on Auto).
 */
export async function getWebStatus(model?: string): Promise<WebStatus | null> {
  try {
    if (isRemoteMode() && !import.meta.env.DEV) {
      const res = await fetch(`${portalBase()}/portal/api/web/status?target=auto`, { headers: { ...authHeaders() }, credentials: "include", signal: AbortSignal.timeout(10_000) });
      return res.ok ? ((await res.json()) as WebStatus) : null;
    }
    return await withIdeRetry((h) => get<WebStatus>(ideBase(), `/v1/ide/web/status${model ? `?model=${encodeURIComponent(model)}` : ""}`, h));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Project files (:4304 /v1/ide/fs/*), confined to the open project by the server
// ---------------------------------------------------------------------------

export interface FsEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  size?: number;
}

export interface FsFile {
  path: string;
  content: string;
  mtimeMs: number;
  size: number;
}

/** A failed file operation; `code` is the server's (conflict, exists, not_found, binary, too_large, ...). */
export class FsError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly data?: Record<string, unknown>) {
    super(message);
  }
}

async function fsCall<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await ideFetch(`${ideBase()}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new FsError(data.error ?? "error", serviceErrorText(res.status, data), res.status, data as Record<string, unknown>);
  return data as T;
}

const q = (p: string) => encodeURIComponent(p);

export const fsList = (path = "") => fsCall<{ entries: FsEntry[] }>("GET", `/v1/ide/fs/list?path=${q(path)}`).then((r) => r.entries);
export const fsRead = (path: string) => fsCall<FsFile>("GET", `/v1/ide/fs/read?path=${q(path)}`);
export const fsWrite = (path: string, content: string, baseMtimeMs?: number) =>
  fsCall<{ path: string; mtimeMs: number }>("POST", "/v1/ide/fs/write", { path, content, baseMtimeMs });
export const fsCreate = (path: string, kind: "file" | "dir") => fsCall<FsEntry>("POST", "/v1/ide/fs/create", { path, kind });
export const fsRename = (from: string, to: string) => fsCall<{ from: string; to: string }>("POST", "/v1/ide/fs/rename", { from, to });
export const fsDelete = (path: string) => fsCall<{ ok: true }>("POST", "/v1/ide/fs/delete", { path });
export const fsStat = (paths: string[]) => fsCall<{ mtimes: Record<string, number | null> }>("POST", "/v1/ide/fs/stat", { paths }).then((r) => r.mtimes);
export const fsGitStatus = () => fsCall<{ branch: string | null; files: Record<string, string> }>("GET", "/v1/ide/fs/git-status");

// Agent turn checkpoints (:4304 /v1/ide/checkpoints): what a turn changed, and undo.
export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
}
export const ideTurnChanges = (turnId: string) =>
  fsCall<{ turnId: string; changes: FileChange[] }>("GET", `/v1/ide/checkpoints/${q(turnId)}`).then((r) => r.changes);
export const ideRevertTurn = (turnId: string, paths?: string[]) =>
  fsCall<{ ok: true; reverted: string[] }>("POST", `/v1/ide/checkpoints/${q(turnId)}/revert`, paths ? { paths } : {}).then((r) => r.reverted);

/** Inline edit (Cmd+K): the replacement for the selection, from the local model. */
export const ideInlineEdit = (body: { path: string; language: string; prefix: string; selection: string; suffix: string; instruction: string; model?: string }) =>
  fsCall<{ model: string; replacement: string }>("POST", "/v1/ide/inline-edit", body).then((r) => r.replacement);

/** Fuzzy project path search (@-mentions, quick open). */
export const fsFind = (q: string, limit = 20) =>
  fsCall<{ matches: Array<{ path: string; kind: "file" | "dir" }> }>("GET", `/v1/ide/fs/find?q=${encodeURIComponent(q)}&limit=${limit}`).then((r) => r.matches);

export type CompletionResponse =
  | { completion: string; model: string }
  | { completion: ""; model: string; reason: "model_missing" | "unsupported" | "error"; message: string };

/** Tab autocomplete at the cursor (fill-in-the-middle). Aborting cancels the model call. */
export async function ideComplete(prefix: string, suffix: string, signal?: AbortSignal, model?: string): Promise<CompletionResponse> {
  const res = await ideFetch(`${ideBase()}/v1/ide/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefix, suffix, ...(model ? { model } : {}) }),
    signal,
  });
  return (await res.json()) as CompletionResponse;
}

// Codebase index (:4304 /v1/ide/index/*): search the project by meaning.
export interface IndexStatus {
  state: "none" | "building" | "ready" | "error";
  files: number;
  chunks: number;
  indexedAtMs?: number;
  progress?: { done: number; total: number };
  error?: string;
  model: string;
}
export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}
export const indexStatus = () => fsCall<IndexStatus>("GET", "/v1/ide/index/status");
export const indexBuild = () => fsCall<IndexStatus>("POST", "/v1/ide/index/build", {});
export const indexSearch = (query: string, k = 8) => fsCall<{ hits: SearchHit[] }>("POST", "/v1/ide/index/search", { query, k }).then((r) => r.hits);

// Source control (:4304 /v1/ide/git/*)
export interface GitFile {
  path: string;
  status: string;
  from?: string;
}
export interface GitState {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitFile[];
  unstaged: GitFile[];
  branches: string[];
  /** Remote names, origin first. */
  remotes: string[];
  /** The first remote's URL without credentials (older IDE servers leave it out). */
  remoteUrl?: string | null;
  hasCommits: boolean;
}
export const gitState =() => fsCall<GitState | { notARepo: true }>("GET", "/v1/ide/git/state");
export const gitHeadContent = (path: string) =>
  fsCall<{ content: string | null }>("GET", `/v1/ide/git/head-content?path=${encodeURIComponent(path)}`).then((r) => r.content);
export const gitStage = (paths: string[]) => fsCall("POST", "/v1/ide/git/stage", { paths });
export const gitUnstage = (paths: string[]) => fsCall("POST", "/v1/ide/git/unstage", { paths });
export const gitDiscard = (paths: string[]) => fsCall("POST", "/v1/ide/git/discard", { paths });
export const gitCommit = (message: string, all = false) => fsCall<{ commit: string }>("POST", "/v1/ide/git/commit", { message, all }).then((r) => r.commit);
export const gitCheckout = (branch: string, create = false) => fsCall("POST", "/v1/ide/git/checkout", { branch, create });
export const gitPull = () => fsCall<{ output: string }>("POST", "/v1/ide/git/pull").then((r) => r.output);
export const gitPush = () => fsCall<{ output: string }>("POST", "/v1/ide/git/push").then((r) => r.output);
export const gitInit = () => fsCall<{ ok: true }>("POST", "/v1/ide/git/init", {});
/** Clone into `<parentDir>/<repo name>` and make it the open project; returns the new folder. */
export const gitClone = (url: string, parentDir: string) =>
  fsCall<{ projectRoot: string }>("POST", "/v1/ide/git/clone", { url, parentDir }).then((r) => r.projectRoot);
export const gitAddRemote = (url: string, name = "origin") => fsCall<{ ok: true; name: string; url: string }>("POST", "/v1/ide/git/remote", { name, url });
/** Create a GitHub repository with the gh CLI and push the current branch to it. */
export const gitPublishGitHub = (name: string, visibility: "public" | "private") =>
  fsCall<{ url: string; output: string }>("POST", "/v1/ide/git/publish", { name, visibility });
export interface GitHubCliStatus {
  ghInstalled: boolean;
  loggedIn: boolean;
  login: string | null;
}
export const gitGitHubStatus = () => fsCall<GitHubCliStatus>("GET", "/v1/ide/git/github/status");

// The projects folder (default ~/EdgeCoder) and connecting repositories into it (:4304 /v1/ide/repos).
export interface ProjectsFolder {
  path: string;
  source: "env" | "setting" | "default";
  defaultPath?: string;
}
export const getProjectsFolder = () => fsCall<ProjectsFolder>("GET", "/v1/ide/settings/projects-folder");
export const setProjectsFolder = (path: string) => fsCall<ProjectsFolder>("POST", "/v1/ide/settings/projects-folder", { path });
/** The `edgecoder` command-line launcher (~/.local/bin/edgecoder, or edgecoder.cmd on Windows). */
export interface CliStatus { path: string; dir: string; installed: boolean; ours: boolean; onPath: boolean }
export const getCliStatus = () => fsCall<CliStatus>("GET", "/v1/ide/settings/cli");
/** Writes the launcher; the message says where and whether its folder is on PATH. Throws with the reason when it can't. */
export const installCliTool = () => fsCall<{ ok: boolean; path: string; dir: string; state: string; onPath: boolean; message: string }>("POST", "/v1/ide/settings/cli/install", {});
/** gh's sign-in and, when signed in, the user's 20 most recent repositories (owner/name). */
export const recentRepos = () => fsCall<GitHubCliStatus & { repos: string[] }>("GET", "/v1/ide/repos/recent");
export interface RepoConnection {
  path: string;
  name: string;
  url: string;
  action: "cloned" | "updated";
  branch: string | null;
  dirty: boolean;
  behind: number;
  ahead: number;
  fastForwarded: boolean;
  message: string;
}
/**
 * Put `repo` (owner/repo or a URL) at <projects folder>/<name>: clone it, or fetch and fast-forward
 * the copy that's there (local changes are left alone). The IDE server opens it as the project.
 */
export async function connectRepo(repo: string, onProgress?: (line: string) => void): Promise<RepoConnection> {
  const res = await ideFetch(`${ideBase()}/v1/ide/repos/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, stream: true }),
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new FsError(data.error ?? "error", data.message ?? `Couldn't connect the repository (${res.status}).`, res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const ev = JSON.parse(line.slice(6)) as { type: string; line?: string; result?: RepoConnection; message?: string };
      if (ev.type === "progress" && ev.line) onProgress?.(ev.line);
      else if (ev.type === "done" && ev.result) return ev.result;
      else if (ev.type === "error") throw new FsError("git", ev.message ?? "Couldn't connect the repository.", 400);
    }
  }
  throw new FsError("git", "The connection to EdgeCoder closed before the repository was ready.", 502);
}

// Background jobs on the network (:4304 /v1/ide/network/tasks)
export interface NetworkTask {
  id: string;
  prompt: string;
  language: "python" | "javascript";
  state: "running" | "done" | "failed" | "timed_out";
  submittedAtMs: number;
  finishedAtMs?: number;
  output?: string;
  error?: string;
  creditsSpent?: number;
}
export const networkSubmit = (prompt: string, language: "python" | "javascript" = "python") =>
  fsCall<NetworkTask>("POST", "/v1/ide/network/tasks", { prompt, language });
export const networkTasks = () => fsCall<{ tasks: NetworkTask[] }>("GET", "/v1/ide/network/tasks").then((r) => r.tasks);

// Problems from the project's own checkers (:4304 /v1/ide/diagnostics)
export interface Diagnostic {
  path: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: "error" | "warning" | "info";
  message: string;
  source: string;
}
export const ideDiagnostics = (paths: string[]) =>
  fsCall<{ byPath: Record<string, Diagnostic[]>; checkers: string[]; untrusted?: string[] }>("POST", "/v1/ide/diagnostics", { paths });

/** Whether the open folder may run its own tooling (tsc, cargo). Folders start untrusted. */
export interface ProjectTrust {
  projectRoot: string | null;
  trusted: boolean;
}
export const ideProjectTrust = () => fsCall<ProjectTrust>("GET", "/v1/ide/project/trust");
/** Only ever called from an explicit user choice; nothing trusts a folder automatically. */
export const ideSetProjectTrust = (trusted: boolean) => fsCall<ProjectTrust>("POST", "/v1/ide/project/trust", { trusted });

/** Create <projects folder>/<name> (a git repo) and make it the open project. */
export const ideNewProject = (name: string) => fsCall<{ projectRoot: string }>("POST", "/v1/ide/projects/new", { name }).then((r) => r.projectRoot);
export type ProjectTemplate = "empty" | "web" | "node";
export interface NewProjectRequest {
  /** The exact folder name. */
  folder: string;
  /** Absolute parent folder; the projects folder when left out. */
  parentDir?: string;
  template?: ProjectTemplate;
  git?: boolean;
}
/** The New project sheet: <parentDir>/<folder> with a template, git or not; it becomes the open project. */
export const ideCreateProject = (req: NewProjectRequest) =>
  fsCall<{ projectRoot: string }>("POST", "/v1/ide/projects/new", { name: req.folder, ...req }).then((r) => r.projectRoot);
/** Preview URL of a project file (default index.html) on the IDE server's preview origin. */
export const idePreviewUrl = (path = "") => fsCall<{ url: string }>("GET", `/v1/ide/preview?path=${encodeURIComponent(path)}`).then((r) => r.url);

// Compute: cSats balance, prices per class, network models, buying cSats (:4304 /v1/ide/compute*)
export interface ComputeOverview {
  connected: boolean;
  /** This computer's agent (so "My machines" can leave it out). */
  selfAgentId?: string;
  reason?: string;
  account?: {
    accountId: string;
    cSats: number;
    earnedSats: number;
    recent: Array<{ type: string; cSats: number; reason: string; taskId?: string; atMs: number }>;
    machines?: Machine[];
    networkAgents?: number;
    coordinator?: { peerId: string; url: string };
  };
  /** agents: machines online in the class with a model (newer coordinators). */
  classes?: Record<string, { label: string; cSatsPerSecondBaseTier: number; agents?: number }>;
  /** Network models; model calls are priced per token (cSats per million tokens in / out). */
  /** restricted: a security research tier model, listed only to entitled accounts; never a network call. */
  /** agentsByClass: machines per class with the model (newer coordinators). */
  // cloudRank / cloudHint: a cloud model (hosted API), its order among cloud models and its hint ("recommended", "premium").
  models?: Array<{ model: string; agents: number; agentsByClass?: Record<string, number>; classes: string[]; cSatsPerMTokens?: { input: number; output: number; cachedInput?: number }; restricted?: string; cloudRank?: number; cloudHint?: string }>;
  /** How this computer's agent chose its coordinator: from the signed registry by latency, or the fallback URL. */
  steering?: CoordinatorSteering | null;
  /** The network refused this computer's agent (its safety check blacklisted it), with the reason. */
  paused?: { reason: string; sinceMs: number } | null;
  /** Network jobs this computer's agent is running now (the update restart waits for them). */
  claims?: number;
  /** The agent stopped taking network work ahead of a restart. */
  draining?: boolean;
  /** This computer's memory: pressure, budget, and the models it serves on the network. */
  memory?: MemoryOverview;
}
/** The agent's host memory guard (src/swarm/memory-manager.ts MemoryStatusView). */
export interface MemoryOverview {
  pressure: "normal" | "warning" | "critical";
  /** Not taking network work for memory reasons. */
  paused: boolean;
  pausedReason: string | null;
  totalBytes: number;
  budgetBytes: number;
  usedBytes: number;
  loadedModels: string[];
  /** Served on the network (fit the memory budget); the rest are local-only. */
  servingModels: string[];
  /** Newer agents: the installed models not served on the network, with their estimated bytes. */
  ownerModels?: Array<{ name: string; bytes: number }>;
  localOnlyModels: string[];
  tooBigModels: string[];
  contextWindow: number;
  parallel: number;
}
export interface CoordinatorSteering {
  url: string;
  source: "registry" | "fallback";
  peerId?: string;
  region?: string;
  latencyMs?: number;
  /** Why the fallback URL is in use ("" for a registry pick). */
  reason: string;
  decidedAtMs: number;
}
export const computeOverview = () => fsCall<ComputeOverview>("GET", "/v1/ide/compute");
/** Before an update restart: this computer's agent stops taking network work and hands its jobs to others. */
export const drainAgent = (resume = false) => fsCall<{ ok?: boolean; draining?: boolean; released?: number }>("POST", "/v1/ide/compute/drain", { resume });
// The network's world view (:4304 /v1/ide/network/world): every coordinator and every machine on
// it, other people's masked, plus this computer's round trip to each coordinator (myRttMs).
export type { WorldStatus, WorldAgent, WorldCoordinator, WorldView } from "./world-view";
import type { WorldView } from "./world-view";
export const networkWorld = () => fsCall<WorldView | { connected: false; reason?: string }>("GET", "/v1/ide/network/world");
export const computeBuy = (amountSats: number) =>
  fsCall<{ intentId: string; invoice: string; amountSats: number; cSats: number; feeSats: number; network: string; expiresInSeconds: number }>("POST", "/v1/ide/compute/buy", { amountSats });
export const computeIntent = (intentId: string) => fsCall<{ intentId: string; status: string; cSats: number }>("POST", "/v1/ide/compute/intent", { intentId });
/** The key external tools use for http://127.0.0.1:4304/v1 (this computer's IDE token). */
export const ideApiKey = () => getIdeToken();
export const IDE_API_BASE = "http://127.0.0.1:4304/v1";

/** One of your machines as the coordinator sees it. */
export interface Machine {
  agentId: string;
  online: boolean;
  lastSeenMs: number;
  computeClass: string;
  tier: string | null;
  activeModel: string | null;
  models: string[];
  reservedUntilMs: number | null;
  /** false: the account is not an approved host yet, so this machine runs only your own work (hosting for others is by request). */
  hostsForNetwork?: boolean;
  /** Hardware verification: the tier claimed, the tier paid after the coordinator's challenge, and evidence from real work. */
  verification?: {
    status: string; claimedTier: string; grantedTier: string; reason: string | null; lastPassAtMs: number | null; score: number | null; tokensPerSec: number | null;
    /** Newer coordinators: when it is checked next, whether this agent version can answer the check, and challenge_* flags. */
    nextCheckAtMs?: number | null; checkSupported?: boolean | null; flags?: string[] | null;
  };
}

// Connect to compute: one local port per connection (:4304 /v1/ide/connections)
export type ConnectionTarget = "local" | "mine" | "network" | "reserved" | "auto";
export interface Connection {
  id: string;
  name: string;
  port: number;
  key: string;
  target: ConnectionTarget;
  model: string;
  computeClass?: string;
  reservationId?: string;
  maxCSatsPerSecond?: number;
  budgetCSats?: number;
  spentCSats: number;
  enabled: boolean;
  createdAtMs: number;
  url: string;
  listening: boolean;
  error?: string;
}
export type ConnectionInput = Pick<Connection, "name" | "target" | "model"> & Partial<Pick<Connection, "computeClass" | "reservationId" | "maxCSatsPerSecond" | "budgetCSats" | "port" | "enabled">>;
export const listConnections = () => fsCall<{ connections: Connection[]; localModels: string[]; networkConnected: boolean; nextPort: number }>("GET", "/v1/ide/connections");
export const createConnection = (c: ConnectionInput) => fsCall<{ connection: Connection }>("POST", "/v1/ide/connections", c).then((r) => r.connection);
export const updateConnection = (id: string, patch: Partial<ConnectionInput> & { rotateKey?: boolean; resetSpent?: boolean }) =>
  fsCall<{ connection: Connection }>("PATCH", `/v1/ide/connections/${encodeURIComponent(id)}`, patch).then((r) => r.connection);
export const deleteConnection = (id: string) => fsCall<{ ok: boolean }>("DELETE", `/v1/ide/connections/${encodeURIComponent(id)}`);

// Reserved capacity: hold a machine of a class for a while, paid up front in cSats
export interface Reservation {
  id: string;
  computeClass: string;
  tier?: string;
  model?: string;
  agentId: string;
  startMs: number;
  endMs: number;
  status: "active" | "ended";
  endReason?: string;
  cSatsPerSecond: number;
  prepaidCSats: number;
  usedCSats?: number;
  refundCSats?: number;
  models: string[];
}
export interface ReservationOptions {
  reservations: Reservation[];
  options: Record<string, { available: number; cSatsPerSecond?: number; tiers: string[]; models: string[] }>;
  minMinutes: number;
  maxMinutes: number;
}
export const listReservations = () => fsCall<ReservationOptions>("GET", "/v1/ide/reservations");
export const createReservation = (r: { computeClass: string; minutes: number; model?: string }) =>
  fsCall<{ reservation: Reservation }>("POST", "/v1/ide/reservations", r).then((x) => x.reservation);
export const cancelReservation = (reservationId: string) => fsCall<{ reservation: Reservation }>("POST", "/v1/ide/reservations/cancel", { reservationId }).then((x) => x.reservation);

// Usage: what you ran, where, and what it cost (coordinator usage records, via :4304 /v1/ide/usage)
export interface UsageRecord {
  id: string;
  atMs: number;
  kind: "inference" | "job" | "reservation";
  placement: "network" | "mine" | "reserved";
  model?: string;
  computeClass?: string;
  agentId?: string;
  source?: string;
  ok: boolean;
  durationMs: number;
  costMsat: number;
  promptTokens?: number;
  outputTokens?: number;
  /** model "auto": "routed to <model> on <class> because <reason>". */
  routing?: string;
}
export interface UsageSlice { key: string; requests: number; cSats: number; seconds: number; promptTokens: number; outputTokens: number }
export interface UsageSummary {
  sinceMs: number;
  totals: { requests: number; cSats: number; seconds: number; failed: number; promptTokens: number; outputTokens: number };
  byDay: Array<{ day: string; requests: number; cSats: number }>;
  byModel: UsageSlice[];
  byClass: UsageSlice[];
  bySource: UsageSlice[];
  byPlacement: UsageSlice[];
  records: UsageRecord[];
}
export const getUsage = (days: number) => fsCall<UsageSummary>("GET", `/v1/ide/usage?days=${days}`);

/** A page on the web portal (opens in the browser). */
export const portalWebUrl = (path = "") => `${portalBase()}${path}`;

/** Save your display name (portal account). */
export async function updateProfile(displayName: string): Promise<void> {
  const res = await fetch(`${portalBase()}/me/profile`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    credentials: "include",
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) throw new Error(res.status === 400 ? "Use plain text for your name." : `Could not save (${res.status})`);
}

/** Readable text for an error from the compute routes. */
export function computeErrorText(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  const known: Record<string, string> = {
    insufficient_credits: "Not enough cSats. Buy more on Plan & usage.",
    no_agent_available: "No machine of that class is free right now. Try another class or later.",
    not_enrolled: "This computer isn't connected to the network yet. Sign in and let the agent start.",
    unknown_reservation: "That reservation no longer exists.",
  };
  if (known[code]) return known[code];
  // The agent can't reach the coordinator (not registered yet, or the coordinator is down).
  const status = (err as { status?: number })?.status ?? 0;
  if (["agent_not_registered", "mesh_unauthorized", "coordinator_unreachable"].includes(code) || [502, 503, 504].includes(status)) {
    return "This computer isn't connected to the network right now. It retries on its own; check Settings → Network.";
  }
  return (err as Error)?.message ?? String(err);
}

// Persistent bots (:4304 /v1/ide/bots): named agents that own a job in a project folder
import type { Bot, BotInput, BotMessage, BotRun } from "./bots";
const botPath = (id: string, rest = "") => `/v1/ide/bots/${encodeURIComponent(id)}${rest}`;
export const listBots = () => fsCall<{ bots: Bot[] }>("GET", "/v1/ide/bots").then((r) => r.bots);
export const getBot = (id: string) => fsCall<{ bot: Bot; memory: string }>("GET", botPath(id));
export const createBot = (b: BotInput) => fsCall<{ bot: Bot }>("POST", "/v1/ide/bots", b).then((r) => r.bot);
export const updateBot = (id: string, patch: Partial<BotInput> & { memory?: string }) => fsCall<{ bot: Bot }>("PATCH", botPath(id), patch).then((r) => r.bot);
export const deleteBot = (id: string) => fsCall<{ ok: boolean }>("DELETE", botPath(id));
export const runBot = (id: string) => fsCall<{ started: boolean; runId?: string; bot: Bot }>("POST", botPath(id, "/run"), {});
export const cancelBotRun = (id: string) => fsCall<{ cancelled: boolean }>("POST", botPath(id, "/cancel"), {});
export const botMessages = (id: string) => fsCall<{ messages: BotMessage[] }>("GET", botPath(id, "/messages")).then((r) => r.messages);
/** `attachments`: files from the composer; the bot saves them in its folder (src/apps/ide/attachments.ts). */
export const sendBotMessage = (id: string, content: string, attachments?: AttachmentPayload[]) =>
  fsCall<{ started: boolean; queued: boolean; bot: Bot }>("POST", botPath(id, "/messages"), { content, ...(attachments?.length ? { attachments } : {}) });
export const botHistory = (id: string) => fsCall<{ runs: BotRun[] }>("GET", botPath(id, "/history")).then((r) => r.runs);
/** Clone or update the bot's repository now (it also happens on save and before each run). */
/** A web-made bot's folder, chosen here: "default" (~/EdgeCoder/Bots/<name>) or an existing folder. */
export const setupBotFolder = (id: string, body: { choice: "default"; allowAuto?: boolean } | { choice: "path"; path: string; allowAuto?: boolean }) =>
  fsCall<{ bot: Bot }>("POST", botPath(id, "/folder"), body).then((r) => r.bot);
export const syncBotRepository = (id: string) => fsCall<{ bot: Bot }>("POST", botPath(id, "/repository/sync"), {}).then((r) => r.bot);
export const approveBotCall = (id: string, callId: string, approved: boolean, always = false, forRun = false) =>
  fsCall<{ ok: boolean; bot: Bot }>("POST", botPath(id, "/approve"), { callId, approved, ...(always ? { always: true } : {}), ...(forRun ? { forRun: true } : {}) });
/** Your answer to a bot's "Use Claude for this run?": this run, every run today, or no. */
export const answerBotFrontier = (id: string, callId: string, choice: "run" | "day" | "decline") => fsCall<{ ok: boolean; bot: Bot }>("POST", botPath(id, "/frontier"), { callId, choice });
/** The server's message for a failed bot call (its `error` field). */
/**
 * The server's message for a failed bot call: its own text for a 4xx or 5xx (serviceErrorText),
 * "couldn't reach" only when nothing answered (LocalServiceUnreachableError).
 */
export const botErrorText = (err: unknown) => (err instanceof FsError ? err.message : (err as Error)?.message ?? String(err));

// ---------------------------------------------------------------------------
// Shared coding sessions (:4304 /v1/ide/sessions): sessions the terminal (`edgecoder code`)
// published with /remote, continued here. The provider runs the turns; this app and the terminal
// are both clients of the session and may send, approve and change settings at any time.
// ---------------------------------------------------------------------------

export interface SessionClientRef {
  clientId: string;
  /** "remote": the owner's phone (Code from your phone), shown as "Phone". */
  kind: "terminal" | "desktop" | "api" | "remote";
  label?: string;
}
export interface SessionSummary {
  id: string;
  title: string;
  projectRoot: string;
  branch: string | null;
  model: string;
  origin: "terminal" | "desktop" | "api";
  published: boolean;
  updatedAt: number;
  messages: number;
  running: boolean;
  live: boolean;
  controller: SessionClientRef | null;
  clients: SessionClientRef[];
  pending: number;
  /** A Code view chat's mirror (code-chat-mirror.ts): the chat shows in the Code view, not as its own session. */
  chatId?: string;
}
export interface SessionEntry {
  id: string;
  role: "user" | "assistant" | "note";
  content: string;
  at: number;
  by?: string;
  events?: IdeStreamEvent[];
  turnId?: string;
  changedFiles?: string[];
  usage?: { cSats: number; where?: string; calls?: import("./served").CallUsage[]; usd?: number };
  undone?: boolean;
  /** A plan written in Plan mode (Approve plan / Revise). */
  plan?: boolean;
  /** A note: older messages were summarized to save tokens (`/compact`, or before a paid turn). */
  compaction?: { throughId: string; savedTokens: number; manual: boolean };
}
export interface SessionQueued {
  id: string;
  text: string;
  by: "terminal" | "desktop" | "api";
  label?: string;
  at: number;
}
export interface SessionSnapshotView {
  session: { id: string; title: string; projectRoot: string; branch: string | null; model: string; compute: { target: string; provider?: string }; published: boolean; cSats: number; transcript: SessionEntry[]; mode?: EngineMode; autoApprove?: "none" | "edits"; workerModel?: string; frontierUsd?: number };
  seq: number;
  controller: SessionClientRef | null;
  clients: SessionClientRef[];
  running: { turnId: string; text: string; events: IdeStreamEvent[] } | null;
  pending: Array<{ id: string; tool: string; args: Record<string, unknown> }>;
  queue?: SessionQueued[];
}
export interface SessionEvent {
  seq: number;
  type: string;
  [k: string]: unknown;
}

/** This window, as a session client (one id per app run). */
export const DESKTOP_CLIENT: SessionClientRef = { clientId: `desk-${Math.random().toString(36).slice(2, 12)}`, kind: "desktop", label: "EdgeCoder app" };

const sessionPost = <T>(id: string, action: string, body: Record<string, unknown> = {}) =>
  fsCall<T>("POST", `/v1/ide/sessions/${id}/${action}`, { ...DESKTOP_CLIENT, ...body });

/** Sessions shown live in the app (published from a terminal). */
export const listPublishedSessions = () => fsCall<{ sessions: SessionSummary[] }>("GET", "/v1/ide/sessions?published=1").then((r) => r.sessions);
/** Every session on the IDE server (auto-restart checks for running turns); older servers may 404. */
export const listAllSessions = () => fsCall<{ sessions: SessionSummary[] }>("GET", "/v1/ide/sessions").then((r) => r.sessions ?? []);
export const getSession = (id: string) => fsCall<SessionSnapshotView>("GET", `/v1/ide/sessions/${id}`);
/** Starts a turn, or queues the message while one runs (turnId null). */
export const sessionSend = (id: string, text: string) => sessionPost<{ turnId: string | null; queued?: SessionQueued }>(id, "messages", { text });
export const sessionUnqueue = (id: string, queuedId: string) => sessionPost<{ removed: boolean }>(id, "unqueue", { queuedId });
/** `applied` false: the terminal answered first. */
export const sessionApprove = (id: string, callId: string, approved: boolean, always = false, forRun = false) =>
  sessionPost<{ ok: boolean; applied?: boolean }>(id, "approve", { callId, approved, always, ...(forRun ? { forRun: true } : {}) });
export const sessionSettings = (id: string, patch: { model?: string; mode?: EngineMode }) => sessionPost(id, "settings", patch);
/** Approve the session's plan (Plan mode) and carry it out in `mode`. */
export const sessionApprovePlan = (id: string, mode: EngineMode = "auto-edits") => sessionPost<{ turnId: string | null }>(id, "plan", { mode });
export const sessionCancel = (id: string) => sessionPost(id, "cancel");
export const sessionUndo = (id: string) => sessionPost<{ reverted: string[] }>(id, "undo");
/** Summarize the session's older messages now (`/compact` in the terminal). */
export const sessionCompact = (id: string) => sessionPost<{ compacted: boolean; savedTokens?: number }>(id, "compact");
// Tentacles (helper agents; docs/tentacles.md): the session's tree, cancel, merge or drop a waiting patch.
export const sessionTentacles = (id: string) =>
  fsCall<{ config: { enabled: boolean }; spentCSats: number; tentacles: import("./tentacles").TentacleItem[] }>("GET", `/v1/ide/sessions/${id}/tentacles`);
export const tentacleCancel = (id: string, tid: string) => sessionPost<{ cancelled: boolean }>(id, `tentacles/${tid}/cancel`);
export const tentacleMerge = (id: string, tid: string, approved: boolean) => sessionPost(id, `tentacles/${tid}/merge`, { approved });

/** A Code view chat as the provider mirrors it for your phone (POST /v1/ide/code-chats/sync, desktop-chats.ts). */
export interface CodeChatSync {
  chatId: string;
  projectRoot: string;
  title?: string;
  mode?: EngineMode;
  model?: string;
  messages: Array<{ id: string; role: "user" | "assistant"; content: string; at: number; turnId?: string; changedFiles?: string[]; plan?: boolean }>;
}
/** Adds the chat's messages the mirror lacks (made on first sync); returns the mirror session's id. */
export const syncCodeChat = (body: CodeChatSync) => fsCall<{ sessionId: string; messages: number }>("POST", "/v1/ide/code-chats/sync", body);
/** The chat was deleted here: its mirror (and what the phone sees of it) goes too. */
export const forgetCodeChat = (chatId: string) => fsCall<{ removed: boolean }>("POST", "/v1/ide/code-chats/forget", { chatId });

/** Follow a session's events after `since` until the signal aborts; reconnects resume after the last event. */
export async function followSession(id: string, since: number, onEvent: (e: SessionEvent) => void, signal: AbortSignal): Promise<void> {
  let last = since;
  while (!signal.aborted) {
    try {
      const q = new URLSearchParams({ since: String(last), clientId: DESKTOP_CLIENT.clientId, kind: "desktop", label: DESKTOP_CLIENT.label ?? "" });
      const res = await ideFetch(`${ideBase()}/v1/ide/sessions/${id}/events?${q}`, { method: "GET", signal });
      if (!res.ok || !res.body) throw new Error(`events: ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
          buf = buf.slice(i + 2);
          if (!line) continue;
          try {
            const e = JSON.parse(line.slice(6)) as SessionEvent;
            if (e.type !== "resync" && e.seq <= last) continue;
            last = e.seq;
            onEvent(e);
          } catch {
            // skip malformed
          }
        }
      }
    } catch {
      if (signal.aborted) return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// Settings → Active work, Tasks and Logs (:4304 /v1/ide/activity, /v1/ide/logs; activity-routes.ts).
export type ActivityKind = "chat" | "code" | "bot" | "tentacle" | "api";
export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  title: string;
  source?: string;
  model?: string;
  startedAtMs: number;
  endedAtMs?: number;
  status: "running" | "done" | "failed" | "cancelled";
  error?: string;
  cSats: number;
  calls: import("./served").CallUsage[];
  steps: string[];
  progress?: string;
}
export interface ServedJob {
  id: string;
  kind: "inference" | "code";
  model: string | null;
  startedAtMs: number;
  elapsedMs: number;
  outputTokens: number;
  /** "you": your own request; "network": someone else's (never who). */
  requester: "you" | "network";
}
export interface AgentActivity {
  reachable: boolean;
  agentId: string | null;
  coordinatorUrl: string | null;
  registered: boolean;
  region: string | null;
  paused: { reason: string; sinceMs: number } | null;
  draining: boolean;
  claims: number;
  slots: { total: number; busy: number } | null;
  computeClass: string | null;
  tier: string | null;
  jobs: ServedJob[];
  jobsUnknown: boolean;
  /** The host memory guard (null: an agent without it). */
  memory?: MemoryOverview | null;
}
export interface ActivitySnapshot {
  atMs: number;
  /** null: this computer is not on the network. */
  agent: AgentActivity | null;
  mine: ActivityItem[];
}
export const getActivity = () => fsCall<ActivitySnapshot>("GET", "/v1/ide/activity");
export const getRecentActivity = () => fsCall<{ items: ActivityItem[] }>("GET", "/v1/ide/activity/recent").then((r) => r.items);

export interface LogSourceInfo { id: string; label: string; exists: boolean; size: number }
export interface LogTail {
  source: string;
  exists: boolean;
  size: number;
  start: number;
  next: number;
  lines: string[];
  truncated: boolean;
  reset: boolean;
  sources: LogSourceInfo[];
}
/** The end of an app log (the last `maxKb`), or what was appended after byte `after`. */
export const getLogTail = (source: string, after?: number, maxKb = 256) =>
  fsCall<LogTail>("GET", `/v1/ide/logs?source=${encodeURIComponent(source)}&maxKb=${maxKb}${after !== undefined ? `&after=${after}` : ""}`);

// Signing in to GitHub from the app (:4304 /v1/ide/github/login): gh's device flow.
export interface GitHubDeviceLogin {
  id: string;
  state: "starting" | "waiting" | "done" | "error" | "cancelled";
  code: string | null;
  url: string;
  login: string | null;
  message: string | null;
}
export const githubLoginStart = () => fsCall<GitHubDeviceLogin>("POST", "/v1/ide/github/login", {});
export const githubLoginStatus = (id: string) => fsCall<GitHubDeviceLogin>("GET", `/v1/ide/github/login/${id}`);
export const githubLoginCancel = (id: string) => fsCall<GitHubDeviceLogin>("POST", `/v1/ide/github/login/${id}/cancel`, {});

// ---------------------------------------------------------------------------
// Frontier models on your own key (docs/frontier-keys.md), via the provider on this computer
// (:4304 /v1/ide/frontier). The key is sent only to that loopback provider, which keeps it in the
// OS keychain bound to your account; no response ever contains it.
// ---------------------------------------------------------------------------

export interface FrontierProviderView {
  id: string;
  kind: "anthropic" | "openai-compatible";
  baseUrl?: string;
  accountId: string;
  storage: "keychain" | "file";
  usable: boolean;
  reason?: string;
  models?: string[];
}

export interface FrontierSettingsView {
  defaultLead: string;
  workerModel: string;
  sessionCapUsd: number | null;
  dailyCapUsd: number | null;
  useForAuto: boolean;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface FrontierStatusView {
  account: string | null;
  /**
   * How sure the provider is about `account`: "unknown" while this computer's agent is still
   * connecting or the check failed (not the same as signed out). Absent from older providers.
   */
  accountState?: "signed_in" | "signed_out" | "unknown";
  storage: string;
  fallbackFile: boolean;
  providers: FrontierProviderView[];
  models: string[];
  settings: FrontierSettingsView;
  spend: { today: number; last30Days: number };
}

export const getFrontierStatus = () => fsCall<FrontierStatusView>("GET", "/v1/ide/frontier");
export const addFrontierKey = (input: { id: string; key: string; kind?: "anthropic" | "openai-compatible"; baseUrl?: string }) =>
  fsCall<{ provider: FrontierProviderView; models: string[] }>("POST", "/v1/ide/frontier/keys", input);
export const testFrontierKey = (id: string) => fsCall<{ models: string[] }>("POST", "/v1/ide/frontier/keys/test", { id });
export const removeFrontierKey = (id: string, ownerAccount?: string) => fsCall<{ removed: boolean }>("POST", "/v1/ide/frontier/keys/remove", { id, ...(ownerAccount ? { ownerAccount } : {}) });
export const updateFrontierSettings = (patch: Partial<FrontierSettingsView>) => fsCall<{ settings: FrontierSettingsView }>("POST", "/v1/ide/frontier/settings", patch);

// Cloud bots (portal /portal/api/bots, agentId "cloud"; docs/cloud-bots.md): bots that run on
// EdgeCoder's servers. The desktop lists them with its own bots and can read and message them.
export interface CloudBotMessage {
  id: string;
  role: "user" | "assistant" | "event";
  content: string;
  atMs: number;
}
export interface CloudBotSummary {
  id: string;
  runtime: "cloud";
  name: string;
  role: string;
  color: string;
  status: string;
  activity?: string;
  enabled: boolean;
  repository?: string;
  lastRun?: { status: string; summary: string; error?: string; startedAtMs: number };
  tail?: CloudBotMessage[];
  messageCount?: number;
}
const cloudBotPath = (id: string, rest = "") => `${portalBase()}/portal/api/bots/cloud/${encodeURIComponent(id)}${rest}`;
async function portalJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...authHeaders(), ...(init.headers ?? {}) }, credentials: "include", signal: AbortSignal.timeout(15_000) });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
  return body;
}
/** The account's cloud bots (empty when signed out or the portal can't be reached). */
export async function listCloudBots(): Promise<CloudBotSummary[]> {
  if (!loadSessionToken()) return [];
  const r = await portalJson<{ bots?: Array<CloudBotSummary | { runtime?: string }> }>(`${portalBase()}/portal/api/bots`);
  return (r.bots ?? []).filter((b): b is CloudBotSummary => b.runtime === "cloud");
}
export const getCloudBot = (id: string) => portalJson<{ bot: CloudBotSummary }>(cloudBotPath(id)).then((r) => r.bot);
export const messageCloudBot = (id: string, content: string) =>
  portalJson<{ commandId: string; result?: { data?: { queued?: boolean } } }>(cloudBotPath(id, "/commands"), { method: "POST", body: JSON.stringify({ action: "message", args: { content } }) });
