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

async function detectBackend(): Promise<void> {
  try {
    const res = await fetch("http://localhost:4301/health/runtime", {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) { useRemote = false; return; }
  } catch { /* local not available */ }
  useRemote = true;
}

/** Resolves once the first backend detection completes. */
export const backendReady: Promise<void> = detectBackend();

/** True when no local agent is running (all agent/inference calls go remote). */
export function isRemoteMode(): boolean {
  return useRemote;
}

// Re-check every 30s
setInterval(detectBackend, 30_000);

function agentBase(): string {
  if (import.meta.env.DEV) return "/api";
  return useRemote ? "https://edgecoder-seed.fly.dev" : "http://localhost:4301";
}

function portalBase(): string {
  if (import.meta.env.DEV) return "/portal";
  return "https://edgecoder-portal.fly.dev";
}

// ---------------------------------------------------------------------------
// Session token persistence (desktop — HttpOnly cookies don't survive restarts)
// ---------------------------------------------------------------------------

const SESSION_TOKEN_KEY = "edgecoder_session_token";

function saveSessionToken(token: string): void {
  try { localStorage.setItem(SESSION_TOKEN_KEY, token); } catch {}
}
function loadSessionToken(): string | null {
  try { return localStorage.getItem(SESSION_TOKEN_KEY); } catch { return null; }
}
export function clearSessionToken(): void {
  try { localStorage.removeItem(SESSION_TOKEN_KEY); } catch {}
}
function authHeaders(): Record<string, string> {
  const token = loadSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const OLLAMA_BASE = import.meta.env.DEV ? "/ollama" : "http://localhost:11434";

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

async function get<T>(base: string, path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

async function post<T>(
  base: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
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

export const getInferenceHealth = () =>
  get<{ ok: boolean }>(INFERENCE_BASE, "/health");

export const getDashboardOverview = () =>
  get<DashboardOverview>(INFERENCE_BASE, "/dashboard/api/overview");

export const getModelList = () =>
  get<ModelInfo[]>(INFERENCE_BASE, "/model/list");

export const getModelStatus = () =>
  get<unknown>(INFERENCE_BASE, "/model/status");

export const swapModel = (model: string) =>
  post<unknown>(INFERENCE_BASE, "/model/swap", { model });

export const pullModel = (model: string) =>
  post<unknown>(INFERENCE_BASE, "/model/pull", { model });

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

export async function getModelPullProgress(): Promise<ModelPullProgress | null> {
  try {
    const res = await fetch(`${agentBase()}/model/pull/progress`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status === "idle") return null;
    return data as ModelPullProgress;
  } catch {
    // Coordinator not available, try inference service
    try {
      const res = await fetch(`${INFERENCE_BASE}/model/pull/progress`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.status === "idle") return null;
      return data as ModelPullProgress;
    } catch {
      return null;
    }
  }
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
  return res.json();
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
  return "https://edgecoder-portal.fly.dev";
}

export function getOAuthStartUrl(provider: "google" | "microsoft"): string {
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

  const res = await fetch(`${chatBase()}/v1/chat/completions`, {
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
