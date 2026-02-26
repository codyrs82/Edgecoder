// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

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
  status: "pending" | "processing" | "completed" | "failed" | "pending_human";
  improvedCode?: string;
  explanation?: string;
  resolvedByAgentId?: string;
  resolvedByModel?: string;
  escalationId?: string;
}

// ---------------------------------------------------------------------------
// Human Escalation — when all automated resolvers fail, the task is surfaced
// to a human operator for context or direct code edits.
// ---------------------------------------------------------------------------

export type HumanEscalationStatus =
  | "pending_human"
  | "human_responded"
  | "resolved"
  | "abandoned";

export interface HumanEscalation {
  escalationId: string;
  taskId: string;
  agentId: string;
  task: string;
  failedCode: string;
  errorHistory: string[];
  language: Language;
  iterationsAttempted: number;
  automatedAttempts: string[];
  status: HumanEscalationStatus;
  humanContext?: string;
  humanEditedCode?: string;
  respondedByUserId?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export type HumanEscalationAction = "provide_context" | "edit_code" | "abandon";

export interface HumanEscalationResponse {
  context?: string;
  editedCode?: string;
  action: HumanEscalationAction;
}
