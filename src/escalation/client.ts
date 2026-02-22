import { request } from "undici";
import { EscalationRequest, EscalationResult } from "./types.js";

const REDACT_PATTERNS = [
  /AKIA[0-9A-Z]{16}/g,
  /(?<=password\s*=\s*).+/gi,
  /(?<=api[_-]?key\s*=\s*).+/gi
];

function scrub(text: string): string {
  return REDACT_PATTERNS.reduce((current, pattern) => current.replace(pattern, "[REDACTED]"), text);
}

export function sanitizeEscalation(req: EscalationRequest): EscalationRequest {
  return {
    ...req,
    task: scrub(req.task),
    failedCode: scrub(req.failedCode),
    errorHistory: req.errorHistory.map(scrub)
  };
}

export async function escalateToCoordinator(
  coordinatorUrl: string,
  req: EscalationRequest,
  meshToken: string
): Promise<EscalationResult> {
  const safe = sanitizeEscalation(req);
  const res = await request(`${coordinatorUrl}/escalate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(meshToken ? { "x-mesh-token": meshToken } : {})
    },
    body: JSON.stringify(safe)
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Escalation failed with status ${res.statusCode}`);
  }

  return (await res.body.json()) as EscalationResult;
}

export async function pollEscalationResult(
  coordinatorUrl: string,
  taskId: string,
  meshToken: string
): Promise<EscalationResult> {
  const res = await request(`${coordinatorUrl}/escalate/${taskId}`, {
    method: "GET",
    headers: meshToken ? { "x-mesh-token": meshToken } : {}
  });

  if (res.statusCode === 404) {
    return { taskId, status: "pending" };
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Escalation poll failed with status ${res.statusCode}`);
  }

  return (await res.body.json()) as EscalationResult;
}
