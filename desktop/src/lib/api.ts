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

const AGENT_BASE = import.meta.env.DEV ? "/api" : "http://localhost:4301";
const INFERENCE_BASE = import.meta.env.DEV
  ? "/inference"
  : "http://localhost:4302";
const OLLAMA_BASE = import.meta.env.DEV ? "/ollama" : "http://localhost:11434";

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function get<T>(base: string, path: string): Promise<T> {
  const res = await fetch(`${base}${path}`);
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
  });
  if (!res.ok) throw new Error(`POST ${path}: ${res.status}`);
  return res.json();
}

async function del<T>(base: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`DELETE ${path}: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Coordinator (:4301)
// ---------------------------------------------------------------------------

export const getHealth = () =>
  get<HealthRuntime>(AGENT_BASE, "/health/runtime");

export const getStatus = () =>
  get<CoordinatorStatus>(AGENT_BASE, "/status");

export const getMeshPeers = () =>
  get<{ peers: MeshPeer[] }>(AGENT_BASE, "/mesh/peers");

export const getMeshReputation = () =>
  get<{ peers: PeerReputation[] }>(AGENT_BASE, "/mesh/reputation");

export const getIdentity = () =>
  get<NodeIdentity>(AGENT_BASE, "/identity");

export const submitTask = (task: TaskSubmission) =>
  post<{ taskId: string }>(AGENT_BASE, "/submit", task);

export async function testMeshToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${AGENT_BASE}/security/blacklist`, {
      headers: { "x-mesh-token": token },
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Inference service (:4302)
// ---------------------------------------------------------------------------

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

const PORTAL_BASE = import.meta.env.DEV ? "/portal" : "http://localhost:4305";

export interface AuthUser {
  userId: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${PORTAL_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Login failed: ${res.status}`);
  }
  return res.json();
}

export async function getMe(): Promise<AuthUser> {
  const res = await fetch(`${PORTAL_BASE}/me`, { credentials: "include" });
  if (!res.ok) throw new Error("Not authenticated");
  return res.json();
}

export async function logout(): Promise<void> {
  await fetch(`${PORTAL_BASE}/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
}

export function getOAuthStartUrl(provider: "google" | "microsoft"): string {
  return `${PORTAL_BASE}/auth/oauth/${provider}/start`;
}

// ---------------------------------------------------------------------------
// IDE chat provider (:4304)
// ---------------------------------------------------------------------------

const CHAT_BASE = import.meta.env.DEV ? "/chat" : "http://localhost:4304";

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
): Promise<void> {
  const streamStart = Date.now();
  let tokenCount = 0;
  let routeInfo: StreamRouteInfo | undefined;

  const res = await fetch(`${CHAT_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "edgecoder-local",
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
  get<CapacityResponse>(AGENT_BASE, "/capacity");
