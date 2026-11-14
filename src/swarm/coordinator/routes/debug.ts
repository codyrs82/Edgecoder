// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Debug routes, registered only when debugRoutesEnabled() is true.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { debugRoutesEnabled } from "../../../common/env-guard.js";
import type { CoordinatorApp } from "../app.js";
import { mesh, queue, protocol, identity, COORDINATOR_PUBLIC_URL, coordinatorKeys } from "../context.js";
import { authorizeAdmin } from "../auth.js";

// ── Debug: direct enqueue for E2E testing (no inference decomposition) ──
const debugEnqueueSchema = z.object({
  input: z.string().min(1).max(10_000),
  language: z.string().optional(),
  taskId: z.string().uuid().optional(),
});

export function registerDebugRoutes(app: CoordinatorApp): void {
  // #40: debug routes are registered only outside production with ENABLE_DEBUG_ROUTES=1.
  if (debugRoutesEnabled()) {
    app.post("/debug/enqueue", async (req, reply) => {
      if (!authorizeAdmin(req, reply)) return;
      const parsed = debugEnqueueSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_input", detail: parsed.error.message });
      const body = parsed.data;
      const taskId = body.taskId ?? randomUUID();
      const hasPeers = mesh.listPeers().length > 0;
      const subtask = queue.enqueueSubtask({
        taskId,
        kind: "single_step",
        language: (body.language as "python" | "javascript") ?? "python",
        input: body.input,
        timeoutMs: 30_000,
        snapshotRef: "debug",
        projectMeta: { projectId: "debug", resourceClass: "cpu" as any, priority: 50 }
      }, hasPeers ? { claimDelayMs: 3_000 } : undefined);
      // Gossip task_offer to peer coordinators
      const offerMsg = protocol.createMessage(
        "task_offer",
        identity.peerId,
        {
          subtaskId: subtask.id,
          taskId,
          kind: subtask.kind,
          language: subtask.language,
          input: subtask.input,
          timeoutMs: subtask.timeoutMs,
          snapshotRef: subtask.snapshotRef,
          projectMeta: subtask.projectMeta,
          originCoordinatorId: identity.peerId,
          originCoordinatorUrl: COORDINATOR_PUBLIC_URL,
        },
        coordinatorKeys.privateKeyPem,
        60_000
      );
      void mesh.broadcast(offerMsg);
      return reply.send({ taskId, subtaskId: subtask.id, queued: true });
    });
  }
}
