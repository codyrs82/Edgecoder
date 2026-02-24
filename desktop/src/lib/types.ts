// Shared TypeScript interfaces for EdgeCoder Desktop
// Based on verified API responses from coordinator, inference, and Ollama services.

// From :4301/health/runtime
export interface HealthRuntime {
  ok: boolean;
  coordinator: {
    provider: string;
    queued: number;
    agents: number;
    results: number;
  };
  ollama: {
    expectedProvider: string;
    host: string;
    reachable: boolean;
    version: string | null;
    modelCount: number;
    error: string | null;
  };
}

// From :4301/status
export interface CoordinatorStatus {
  queued: number;
  agents: number;
  results: number;
}

// From :4301/mesh/peers
export interface MeshPeer {
  peerId: string;
  publicKeyPem: string;
  coordinatorUrl: string;
  networkMode: "public_mesh" | "enterprise_overlay";
}

// From :4301/mesh/reputation
export interface PeerReputation {
  peerId: string;
  score: number;
}

// From :4301/identity
export interface NodeIdentity {
  peerId: string;
  publicKeyPem: string;
  coordinatorUrl: string;
  networkMode: string;
}

// From :4302/dashboard/api/overview
export interface DashboardOverview {
  activeModel: string;
  activeModelParamSize: number;
  ollamaHealthy: boolean;
  uptimeSeconds: number;
  memoryMB: number;
  nodeVersion: string;
}

// From :4302/model/list
export interface ModelInfo {
  modelId: string;
  paramSize: number;
  quantization: string;
  installed: boolean;
  active: boolean;
  source: string;
}

// From :11434/api/tags
export interface OllamaModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  modified_at: string;
  details: {
    parameter_size: string;
    quantization_level: string;
    family: string;
  };
}

// From :11434/api/ps
export interface OllamaRunningModel {
  name: string;
  model: string;
  size: number;
  size_vram: number;
  digest: string;
}

// Tauri system metrics
export interface SystemMetrics {
  cpu_usage_percent: number;
  memory_used_mb: number;
  memory_total_mb: number;
  disk_used_gb: number;
  disk_total_gb: number;
}

// Task submission to POST /submit
export interface TaskSubmission {
  taskId: string;
  prompt: string;
  language: "python" | "javascript";
  snapshotRef: string;
  resourceClass?: "cpu" | "gpu";
  priority?: number;
}
