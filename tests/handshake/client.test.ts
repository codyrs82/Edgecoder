import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  sanitizePayload,
  queueCloudReview,
  CloudReviewPayload
} from "../../src/handshake/client.js";
import type { QueueReasonCode } from "../../src/common/types.js";

// ---------------------------------------------------------------------------
// Mock the `undici` module so no real HTTP calls are made.
// ---------------------------------------------------------------------------

const mockRequest = vi.fn();
vi.mock("undici", () => ({ request: (...args: unknown[]) => mockRequest(...args) }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(overrides: Partial<CloudReviewPayload> = {}): CloudReviewPayload {
  return {
    task: "fix test flake in CI",
    snippet: 'const x = "hello";',
    queueReason: "timeout" as QueueReasonCode,
    ...overrides
  };
}

function okResponse(body: Record<string, unknown>, statusCode = 200) {
  return {
    statusCode,
    body: { json: () => Promise.resolve(body) }
  };
}

function errorResponse(statusCode: number) {
  return {
    statusCode,
    body: { json: () => Promise.resolve({ error: "bad" }) }
  };
}

// ---------------------------------------------------------------------------
// Tests — sanitizePayload
// ---------------------------------------------------------------------------

describe("sanitizePayload", () => {
  it("returns payload unchanged when no secrets present", () => {
    const payload = makePayload();
    const result = sanitizePayload(payload);
    expect(result).toEqual(payload);
  });

  it("redacts AWS access key IDs from task field", () => {
    const payload = makePayload({ task: "use key AKIAIOSFODNN7EXAMPLE to deploy" });
    const result = sanitizePayload(payload);
    expect(result.task).toBe("use key [REDACTED] to deploy");
    expect(result.task).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts AWS access key IDs from snippet field", () => {
    const payload = makePayload({ snippet: "aws_key=AKIAIOSFODNN7EXAMPLE" });
    const result = sanitizePayload(payload);
    expect(result.snippet).toContain("[REDACTED]");
    expect(result.snippet).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts password assignments", () => {
    const payload = makePayload({ task: 'password = "hunter2"' });
    const result = sanitizePayload(payload);
    expect(result.task).toContain("[REDACTED]");
    expect(result.task).not.toContain("hunter2");
  });

  it("redacts api_key assignments", () => {
    const payload = makePayload({ error: "api_key = sk-secret-value" });
    const result = sanitizePayload(payload);
    expect(result.error).toContain("[REDACTED]");
    expect(result.error).not.toContain("sk-secret-value");
  });

  it("redacts api-key assignments (hyphenated)", () => {
    const payload = makePayload({ snippet: "api-key = my-secret-key" });
    const result = sanitizePayload(payload);
    expect(result.snippet).toContain("[REDACTED]");
    expect(result.snippet).not.toContain("my-secret-key");
  });

  it("handles multiple secrets in the same field", () => {
    const payload = makePayload({
      task: "password = secret1 and api_key = secret2 and AKIAIOSFODNN7EXAMPLE"
    });
    const result = sanitizePayload(payload);
    expect(result.task).not.toContain("secret1");
    expect(result.task).not.toContain("secret2");
    expect(result.task).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("preserves undefined optional fields", () => {
    const payload = makePayload({ snippet: undefined, error: undefined });
    const result = sanitizePayload(payload);
    expect(result.snippet).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("preserves queueReason unchanged", () => {
    const payload = makePayload({ queueReason: "model_limit" as QueueReasonCode });
    const result = sanitizePayload(payload);
    expect(result.queueReason).toBe("model_limit");
  });
});

// ---------------------------------------------------------------------------
// Tests — queueCloudReview: successful handshake flow
// ---------------------------------------------------------------------------

describe("queueCloudReview", () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it("sends POST to {endpoint}/review with bearer token", async () => {
    const reviewId = "review-abc-123";
    mockRequest.mockResolvedValue(okResponse({ reviewId }));

    const result = await queueCloudReview(
      "https://cloud.example.com",
      makePayload(),
      "tok_secret"
    );

    expect(result).toEqual({ reviewId });
    expect(mockRequest).toHaveBeenCalledOnce();

    const [url, opts] = mockRequest.mock.calls[0];
    expect(url).toBe("https://cloud.example.com/review");
    expect(opts.method).toBe("POST");
    expect(opts.headers.authorization).toBe("Bearer tok_secret");
    expect(opts.headers["content-type"]).toBe("application/json");
  });

  it("sanitizes payload before sending", async () => {
    mockRequest.mockResolvedValue(okResponse({ reviewId: "r-1" }));

    const payload = makePayload({ task: "password = hunter2" });
    await queueCloudReview("https://cloud.example.com", payload, "tok");

    const sentBody = JSON.parse(mockRequest.mock.calls[0][1].body);
    expect(sentBody.task).not.toContain("hunter2");
    expect(sentBody.task).toContain("[REDACTED]");
  });

  it("returns reviewId from a successful JSON response", async () => {
    mockRequest.mockResolvedValue(okResponse({ reviewId: "review-xyz" }));
    const result = await queueCloudReview("http://localhost:4000", makePayload(), "t");
    expect(result.reviewId).toBe("review-xyz");
  });

  // ---- Successful responses at boundary status codes ----

  it("accepts 200 status", async () => {
    mockRequest.mockResolvedValue(okResponse({ reviewId: "r-200" }, 200));
    const result = await queueCloudReview("http://api", makePayload(), "t");
    expect(result.reviewId).toBe("r-200");
  });

  it("accepts 201 status", async () => {
    mockRequest.mockResolvedValue(okResponse({ reviewId: "r-201" }, 201));
    const result = await queueCloudReview("http://api", makePayload(), "t");
    expect(result.reviewId).toBe("r-201");
  });

  it("accepts 299 status (upper boundary of success range)", async () => {
    mockRequest.mockResolvedValue(okResponse({ reviewId: "r-299" }, 299));
    const result = await queueCloudReview("http://api", makePayload(), "t");
    expect(result.reviewId).toBe("r-299");
  });

  // ---- Error status codes ----

  it("throws on 4xx response", async () => {
    mockRequest.mockResolvedValue(errorResponse(401));
    await expect(
      queueCloudReview("http://api", makePayload(), "bad-token")
    ).rejects.toThrow("Cloud review failed with status 401");
  });

  it("throws on 403 forbidden", async () => {
    mockRequest.mockResolvedValue(errorResponse(403));
    await expect(
      queueCloudReview("http://api", makePayload(), "t")
    ).rejects.toThrow("Cloud review failed with status 403");
  });

  it("throws on 5xx response", async () => {
    mockRequest.mockResolvedValue(errorResponse(500));
    await expect(
      queueCloudReview("http://api", makePayload(), "t")
    ).rejects.toThrow("Cloud review failed with status 500");
  });

  it("throws on 300 redirect (not in 2xx range)", async () => {
    mockRequest.mockResolvedValue(errorResponse(300));
    await expect(
      queueCloudReview("http://api", makePayload(), "t")
    ).rejects.toThrow("Cloud review failed with status 300");
  });

  it("throws on 199 status (below 2xx range)", async () => {
    mockRequest.mockResolvedValue(errorResponse(199));
    await expect(
      queueCloudReview("http://api", makePayload(), "t")
    ).rejects.toThrow("Cloud review failed with status 199");
  });

  // ---- Server unreachable / network error scenarios ----

  it("propagates network errors (server unreachable)", async () => {
    mockRequest.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:4000"));
    await expect(
      queueCloudReview("http://localhost:4000", makePayload(), "t")
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("propagates DNS resolution failure", async () => {
    mockRequest.mockRejectedValue(new Error("getaddrinfo ENOTFOUND cloud.example.com"));
    await expect(
      queueCloudReview("https://cloud.example.com", makePayload(), "t")
    ).rejects.toThrow("ENOTFOUND");
  });

  it("propagates timeout errors", async () => {
    mockRequest.mockRejectedValue(new Error("Request timed out"));
    await expect(
      queueCloudReview("http://api", makePayload(), "t")
    ).rejects.toThrow("Request timed out");
  });

  // ---- Invalid response handling ----

  it("propagates JSON parse error from malformed response body", async () => {
    mockRequest.mockResolvedValue({
      statusCode: 200,
      body: {
        json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON"))
      }
    });
    await expect(
      queueCloudReview("http://api", makePayload(), "t")
    ).rejects.toThrow("Unexpected token");
  });

  // ---- Authentication / signing: token is included correctly ----

  it("sends the exact bearer token provided", async () => {
    mockRequest.mockResolvedValue(okResponse({ reviewId: "r" }));
    await queueCloudReview("http://api", makePayload(), "my-super-secret-token-123");

    const authHeader = mockRequest.mock.calls[0][1].headers.authorization;
    expect(authHeader).toBe("Bearer my-super-secret-token-123");
  });

  it("sends empty bearer when token is empty string", async () => {
    mockRequest.mockResolvedValue(okResponse({ reviewId: "r" }));
    await queueCloudReview("http://api", makePayload(), "");

    const authHeader = mockRequest.mock.calls[0][1].headers.authorization;
    expect(authHeader).toBe("Bearer ");
  });

  // ---- Payload serialization ----

  it("serializes the full sanitized payload as JSON body", async () => {
    mockRequest.mockResolvedValue(okResponse({ reviewId: "r" }));
    const payload = makePayload({
      task: "fix bug",
      snippet: "console.log(1)",
      error: "TypeError: x is undefined",
      queueReason: "outside_subset" as QueueReasonCode
    });
    await queueCloudReview("http://api", payload, "tok");

    const sentBody = JSON.parse(mockRequest.mock.calls[0][1].body);
    expect(sentBody.task).toBe("fix bug");
    expect(sentBody.snippet).toBe("console.log(1)");
    expect(sentBody.error).toBe("TypeError: x is undefined");
    expect(sentBody.queueReason).toBe("outside_subset");
  });
});
