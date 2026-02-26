import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { EscalationResolver } from "../../src/escalation/server.js";
import type { EscalationRequest, HumanEscalation } from "../../src/escalation/types.js";
import {
  getHumanEscalation,
  listHumanEscalations,
  updateHumanEscalation,
  countPendingHumanEscalations,
  clearHumanEscalations,
} from "../../src/escalation/human-store.js";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<EscalationRequest> = {}): EscalationRequest {
  return {
    taskId: "task-human-1",
    agentId: "agent-h",
    task: "implement merge sort",
    failedCode: "def merge_sort(arr): return arr",
    errorHistory: ["AssertionError: not sorted"],
    language: "python",
    iterationsAttempted: 5,
    ...overrides,
  };
}

function createMockServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        resolve({ server, url: `http://127.0.0.1:${addr.port}` });
      }
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Human Escalation", () => {
  beforeEach(() => {
    clearHumanEscalations();
  });

  // -------------------------------------------------------------------------
  // 1. Waterfall exhaustion creates human escalation entry
  // -------------------------------------------------------------------------

  describe("waterfall exhaustion creates human escalation", () => {
    it("creates a HumanEscalation entry when no backends are configured", async () => {
      const resolver = new EscalationResolver({});
      const result = await resolver.resolve(makeRequest());

      expect(result.status).toBe("pending_human");
      expect(result.escalationId).toBeDefined();

      const entry = getHumanEscalation(result.escalationId!);
      expect(entry).toBeDefined();
      expect(entry!.taskId).toBe("task-human-1");
      expect(entry!.status).toBe("pending_human");
    });

    it("creates a HumanEscalation entry when all backends fail", async () => {
      const resolver = new EscalationResolver({
        parentCoordinatorUrl: "http://127.0.0.1:1",
        cloudInferenceUrl: "http://127.0.0.1:1",
        maxRetries: 0,
        requestTimeoutMs: 200,
      });

      const result = await resolver.resolve(makeRequest());
      expect(result.status).toBe("pending_human");
      expect(result.escalationId).toBeDefined();

      const entry = getHumanEscalation(result.escalationId!);
      expect(entry).toBeDefined();
    });

    it("does NOT create a HumanEscalation when a backend succeeds", async () => {
      let parentServer: Server;
      let parentUrl: string;
      ({ server: parentServer, url: parentUrl } = await createMockServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ taskId: "task-human-1", status: "completed", improvedCode: "ok" })
        );
      }));

      try {
        const resolver = new EscalationResolver({
          parentCoordinatorUrl: parentUrl,
          maxRetries: 0,
        });

        const result = await resolver.resolve(makeRequest());
        expect(result.status).toBe("completed");

        const pending = listHumanEscalations("pending_human");
        expect(pending).toHaveLength(0);
      } finally {
        await closeServer(parentServer);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. Human escalation has correct initial state
  // -------------------------------------------------------------------------

  describe("correct initial state", () => {
    it("captures all request fields and sets initial status", async () => {
      const resolver = new EscalationResolver({});
      const req = makeRequest({
        taskId: "task-init-state",
        agentId: "agent-init",
        task: "implement quicksort",
        failedCode: "def qs(a): pass",
        errorHistory: ["err1", "err2"],
        language: "python",
        iterationsAttempted: 4,
      });
      const result = await resolver.resolve(req);

      const entry = getHumanEscalation(result.escalationId!)!;
      expect(entry.taskId).toBe("task-init-state");
      expect(entry.agentId).toBe("agent-init");
      expect(entry.task).toBe("implement quicksort");
      expect(entry.failedCode).toBe("def qs(a): pass");
      expect(entry.errorHistory).toEqual(["err1", "err2"]);
      expect(entry.language).toBe("python");
      expect(entry.iterationsAttempted).toBe(4);
      expect(entry.status).toBe("pending_human");
      expect(entry.humanContext).toBeUndefined();
      expect(entry.humanEditedCode).toBeUndefined();
      expect(entry.respondedByUserId).toBeUndefined();
      expect(entry.createdAtMs).toBeGreaterThan(0);
      expect(entry.updatedAtMs).toBeGreaterThan(0);
    });

    it("records which automated resolvers were attempted", async () => {
      const { server: parentServer, url: parentUrl } = await createMockServer((_req, res) => {
        res.writeHead(500);
        res.end("fail");
      });
      const { server: cloudServer, url: cloudUrl } = await createMockServer((_req, res) => {
        res.writeHead(500);
        res.end("fail");
      });

      try {
        const resolver = new EscalationResolver({
          parentCoordinatorUrl: parentUrl,
          cloudInferenceUrl: cloudUrl,
          maxRetries: 0,
        });

        const result = await resolver.resolve(makeRequest());
        const entry = getHumanEscalation(result.escalationId!)!;
        expect(entry.automatedAttempts).toContain("parent-coordinator");
        expect(entry.automatedAttempts).toContain("cloud-inference");
        expect(entry.automatedAttempts).toHaveLength(2);
      } finally {
        await closeServer(parentServer);
        await closeServer(cloudServer);
      }
    });

    it("records no automated attempts when no backends are configured", async () => {
      const resolver = new EscalationResolver({});
      const result = await resolver.resolve(makeRequest());
      const entry = getHumanEscalation(result.escalationId!)!;
      expect(entry.automatedAttempts).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 3. "provide_context" response updates escalation correctly
  // -------------------------------------------------------------------------

  describe("provide_context response", () => {
    it("updates status to human_responded and stores the context", async () => {
      const resolver = new EscalationResolver({});
      const result = await resolver.resolve(makeRequest());
      const escalationId = result.escalationId!;

      const updated = updateHumanEscalation(escalationId, {
        status: "human_responded",
        humanContext: "The function needs to handle empty arrays and single-element arrays.",
        respondedByUserId: "user-abc",
      });

      expect(updated).toBeDefined();
      expect(updated!.status).toBe("human_responded");
      expect(updated!.humanContext).toBe(
        "The function needs to handle empty arrays and single-element arrays."
      );
      expect(updated!.respondedByUserId).toBe("user-abc");
    });
  });

  // -------------------------------------------------------------------------
  // 4. "edit_code" response resolves directly
  // -------------------------------------------------------------------------

  describe("edit_code response", () => {
    it("updates status to resolved and stores the edited code", async () => {
      const resolver = new EscalationResolver({});
      const result = await resolver.resolve(makeRequest());
      const escalationId = result.escalationId!;

      const updated = updateHumanEscalation(escalationId, {
        status: "resolved",
        humanEditedCode:
          "def merge_sort(arr):\n  if len(arr) <= 1: return arr\n  mid = len(arr)//2\n  return merge(merge_sort(arr[:mid]), merge_sort(arr[mid:]))",
        respondedByUserId: "user-xyz",
      });

      expect(updated).toBeDefined();
      expect(updated!.status).toBe("resolved");
      expect(updated!.humanEditedCode).toContain("merge_sort");
      expect(updated!.respondedByUserId).toBe("user-xyz");
    });
  });

  // -------------------------------------------------------------------------
  // 5. "abandon" response marks as abandoned
  // -------------------------------------------------------------------------

  describe("abandon response", () => {
    it("updates status to abandoned", async () => {
      const resolver = new EscalationResolver({});
      const result = await resolver.resolve(makeRequest());
      const escalationId = result.escalationId!;

      const updated = updateHumanEscalation(escalationId, {
        status: "abandoned",
        respondedByUserId: "user-quit",
      });

      expect(updated).toBeDefined();
      expect(updated!.status).toBe("abandoned");
      expect(updated!.respondedByUserId).toBe("user-quit");
    });
  });

  // -------------------------------------------------------------------------
  // 6. Pending count returns correct count
  // -------------------------------------------------------------------------

  describe("pending count", () => {
    it("returns 0 when no escalations exist", () => {
      expect(countPendingHumanEscalations()).toBe(0);
    });

    it("returns the correct count of pending_human escalations", async () => {
      const resolver = new EscalationResolver({});

      // Create 3 escalations
      const r1 = await resolver.resolve(makeRequest({ taskId: "t1" }));
      const r2 = await resolver.resolve(makeRequest({ taskId: "t2" }));
      const r3 = await resolver.resolve(makeRequest({ taskId: "t3" }));

      expect(countPendingHumanEscalations()).toBe(3);

      // Resolve one
      updateHumanEscalation(r1.escalationId!, { status: "resolved" });
      expect(countPendingHumanEscalations()).toBe(2);

      // Abandon another
      updateHumanEscalation(r2.escalationId!, { status: "abandoned" });
      expect(countPendingHumanEscalations()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Only pending_human escalations are listed
  // -------------------------------------------------------------------------

  describe("listing filters by status", () => {
    it("lists only pending_human escalations", async () => {
      const resolver = new EscalationResolver({});

      const r1 = await resolver.resolve(makeRequest({ taskId: "list-1" }));
      const r2 = await resolver.resolve(makeRequest({ taskId: "list-2" }));
      const r3 = await resolver.resolve(makeRequest({ taskId: "list-3" }));

      // Resolve one, abandon another
      updateHumanEscalation(r1.escalationId!, { status: "resolved" });
      updateHumanEscalation(r2.escalationId!, { status: "abandoned" });

      const pendingOnly = listHumanEscalations("pending_human");
      expect(pendingOnly).toHaveLength(1);
      expect(pendingOnly[0].taskId).toBe("list-3");
    });

    it("lists all escalations when no status filter is given", async () => {
      const resolver = new EscalationResolver({});
      await resolver.resolve(makeRequest({ taskId: "all-1" }));
      await resolver.resolve(makeRequest({ taskId: "all-2" }));

      const all = listHumanEscalations();
      expect(all).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Additional edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("updateHumanEscalation returns undefined for nonexistent id", () => {
      const result = updateHumanEscalation("nonexistent-id", { status: "abandoned" });
      expect(result).toBeUndefined();
    });

    it("getHumanEscalation returns undefined for nonexistent id", () => {
      expect(getHumanEscalation("nonexistent")).toBeUndefined();
    });

    it("escalation result includes the explanation about human input", async () => {
      const resolver = new EscalationResolver({});
      const result = await resolver.resolve(makeRequest());
      expect(result.explanation).toContain("human");
    });
  });
});
