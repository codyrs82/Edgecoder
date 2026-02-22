import { Language } from "../common/types.js";

export interface EscalationRequest {
  taskId: string;
  agentId: string;
  task: string;
  failedCode: string;
  errorHistory: string[];
  language: Language;
  iterationsAttempted: number;
}

export interface EscalationResult {
  taskId: string;
  status: "pending" | "processing" | "completed" | "failed";
  improvedCode?: string;
  explanation?: string;
  resolvedByAgentId?: string;
  resolvedByModel?: string;
}
