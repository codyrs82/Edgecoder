const AGENT_BASE = "http://localhost:4301";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${AGENT_BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${AGENT_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`POST ${path}: ${res.status}`);
  return res.json();
}

export const getHealth = () => get<{ status: string; uptime: number }>("/health/runtime");
export const getStatus = () => get<{ agents: Record<string, unknown>; queueDepth: number }>("/status");
export const getMeshPeers = () => get<{ peers: unknown[] }>("/mesh/peers");
export const getMeshPeer = (id: string) => get<unknown>(`/agent-mesh/peers/${id}`);
export const getModelList = () => get<{ models: unknown[] }>("/model/list");
export const getModelStatus = () => get<{ model: string; loaded: boolean }>("/model/status");
export const swapModel = (model: string) => post("/model/swap", { model });
export const pullModel = (model: string) => post("/model/pull", { model });
export const getCredits = () => get<{ balance: number }>("/credits/balance");
export const getCreditHistory = () => get<{ transactions: unknown[] }>("/credits/history");
