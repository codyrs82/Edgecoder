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
