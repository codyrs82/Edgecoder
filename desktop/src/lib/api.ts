import { localAgentUsable, parseAgentStatus, shouldDropToken, statusFromTokenError, type LocalAgentStatus } from "./agent-status";
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
  TaskSubmission,
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
    if (_agentStatus === "spawned") await detectBackend();
  } catch {
    // Not running inside Tauri.
  }
  return _agentStatus;
}

async function tryLocalHealth(): Promise<boolean> {
  // #72: never treat an unverified :4301 listener as our agent.
  if (!localAgentUsable(await localAgentStatus())) return false;
  try {
    const res = await fetch("http://localhost:4301/health/runtime", {
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

/** Resolves once the first backend detection completes or after 20s timeout. */
export const backendReady: Promise<void> = Promise.race([
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

export const submitTask = (task: TaskSubmission) =>
  post<{ taskId: string }>(agentBase(), "/submit", task);

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
  : "http://localhost:4302";

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
): Promise<void> {
  const streamStart = Date.now();
  let tokenCount = 0;

  const res = await fetch(`${portalBase()}/portal/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ conversationId, message }),
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

export function getOAuthStartUrl(provider: "google" | "microsoft" | "github"): string {
  const redirect = encodeURIComponent("edgecoder://oauth-callback");
  return `${oauthPortalBase()}/auth/oauth/${provider}/start?appRedirect=${redirect}`;
}

export async function completeOAuthWithToken(mobileToken: string): Promise<AuthUser> {
  const res = await fetch(`${oauthPortalBase()}/auth/oauth/mobile/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ token: mobileToken }),
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

export interface WalletOnboarding {
  accountId: string;
  network: string;
  derivedAddress: string | null;
  createdAtMs: number;
  acknowledgedAtMs: number | null;
}

export interface WalletSeedSetup {
  ok: boolean;
  accountId: string;
  network: string;
  seedPhrase: string;
  derivedAddress: string | null;
  guidance: { title: string; steps: string[] };
}

export interface WalletSendRequest {
  requestId: string;
  destination: string;
  amountSats: number;
  note: string | null;
  status: string;
  createdAtMs: number;
}

export async function getWalletOnboarding(): Promise<WalletOnboarding | null> {
  try {
    const res = await fetch(`${portalBase()}/wallet/onboarding`, {
      headers: { ...authHeaders() },
      credentials: "include",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Wallet status: ${res.status}`);
    return res.json();
  } catch {
    return null;
  }
}

export async function setupWalletSeed(): Promise<WalletSeedSetup> {
  const res = await fetch(`${portalBase()}/wallet/onboarding/setup-seed`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    credentials: "include",
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error("Failed to generate seed phrase");
  return res.json();
}

export async function acknowledgeWalletSeed(): Promise<void> {
  const res = await fetch(`${portalBase()}/wallet/onboarding/acknowledge`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    credentials: "include",
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error("Failed to acknowledge seed backup");
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
  return import.meta.env.DEV ? "/chat" : "http://localhost:4304";
}

function isUnauthorized(e: unknown): boolean {
  return String(e).includes(": 401");
}

/**
 * fetch() against the local IDE server with the cached token. On 401 the token
 * file may have been regenerated, so drop the cached value, reread it and retry once.
 */
async function ideFetch(url: string, init: RequestInit): Promise<Response> {
  const send = async () =>
    fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...(await ideHeaders()) } });
  let res = await send();
  if (res.status === 401) {
    resetIdeToken();
    res = await send();
  }
  return res;
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
  return useRemote ? `${portalBase()}/portal/api` : "http://localhost:4304";
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

export async function ideSendToolApproval(id: string, approved: boolean): Promise<void> {
  await withIdeRetry((h) => post(ideBase(), "/v1/ide/tool-approval", { id, approved }, h));
}

export interface IdeStreamEvent {
  type: "text" | "status" | "tool_call" | "tool_result" | "diff" | "shell_request" | "shell_output" | "plan" | "turn" | "file_change" | "done";
  [key: string]: unknown;
}

/**
 * A model id from the compute picker as the IDE chat takes it: "network/m@gpu", "mine/m" and
 * "reserved/<id>/m" run off this computer (billed in cSats on the network), anything else here.
 */
export function computeFields(id?: string): { model?: string; compute?: { target: "mine" | "network" | "reserved"; computeClass?: string; reservationId?: string } } {
  if (!id) return {};
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
  /** "edits": file edits apply without asking (undoable from the reply's changes card). */
  autoApprove: "none" | "edits" = "none",
): Promise<void> {
  const base = ideBase();
  const res = await ideFetch(`${base}/v1/ide/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      ...computeFields(requestedModel),
      projectRoot,
      autoApprove,
      ...(githubToken ? { githubToken } : {}),
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
  constructor(readonly code: string, message: string, readonly status: number) {
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
  if (!res.ok) throw new FsError(data.error ?? "error", data.message ?? `${path}: ${res.status}`, res.status);
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
}
export const gitState = () => fsCall<GitState | { notARepo: true }>("GET", "/v1/ide/git/state");
export const gitHeadContent = (path: string) =>
  fsCall<{ content: string | null }>("GET", `/v1/ide/git/head-content?path=${encodeURIComponent(path)}`).then((r) => r.content);
export const gitStage = (paths: string[]) => fsCall("POST", "/v1/ide/git/stage", { paths });
export const gitUnstage = (paths: string[]) => fsCall("POST", "/v1/ide/git/unstage", { paths });
export const gitDiscard = (paths: string[]) => fsCall("POST", "/v1/ide/git/discard", { paths });
export const gitCommit = (message: string, all = false) => fsCall<{ commit: string }>("POST", "/v1/ide/git/commit", { message, all }).then((r) => r.commit);
export const gitCheckout = (branch: string, create = false) => fsCall("POST", "/v1/ide/git/checkout", { branch, create });
export const gitPull = () => fsCall<{ output: string }>("POST", "/v1/ide/git/pull").then((r) => r.output);
export const gitPush = () => fsCall<{ output: string }>("POST", "/v1/ide/git/push").then((r) => r.output);

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
  fsCall<{ byPath: Record<string, Diagnostic[]>; checkers: string[] }>("POST", "/v1/ide/diagnostics", { paths });

/** Create ~/EdgeCoder Projects/<name> (a git repo) and make it the open project. */
export const ideNewProject = (name: string) => fsCall<{ projectRoot: string }>("POST", "/v1/ide/projects/new", { name }).then((r) => r.projectRoot);
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
  classes?: Record<string, { label: string; cSatsPerSecondBaseTier: number }>;
  models?: Array<{ model: string; agents: number; classes: string[] }>;
}
export const computeOverview = () => fsCall<ComputeOverview>("GET", "/v1/ide/compute");
export const computeBuy = (amountSats: number) =>
  fsCall<{ intentId: string; invoice: string; amountSats: number; cSats: number; feeSats: number; network: string; expiresInSeconds: number }>("POST", "/v1/ide/compute/buy", { amountSats });
export const computeIntent = (intentId: string) => fsCall<{ intentId: string; status: string; cSats: number }>("POST", "/v1/ide/compute/intent", { intentId });
/** The key external tools use for http://localhost:4304/v1 (this computer's IDE token). */
export const ideApiKey = () => getIdeToken();
export const IDE_API_BASE = "http://localhost:4304/v1";

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
}

// Connect to compute: one local port per connection (:4304 /v1/ide/connections)
export type ConnectionTarget = "local" | "mine" | "network" | "reserved";
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
  return known[code] ?? (err as Error)?.message ?? String(err);
}
