import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capacityFor,
  CHAT_CAPACITY_DEFAULT_TIMEOUT_MS,
  CHAT_CAPACITY_DEFAULT_TTL_MS,
  chatCapacityOptionsFromEnv,
  createChatCapacityDirectory,
  httpCapacityProbe,
  type CapacityReport,
} from "../../src/portal/chat-capacity.js";
import { coordinatorUrlAllowed, coordinatorUrlPolicyFromEnv } from "../../src/portal/coordinator-url-policy.js";

// #39: the portal picks, for each chat, a coordinator that reports capacity for it.

const US = "https://us.example.com";
const EU = "https://eu.example.com";
const WITH_MODEL: CapacityReport = { reachable: true, ownModelCount: 1 };
const NO_MODEL: CapacityReport = { reachable: true, ownModelCount: 0 };
const OLD_BUILD: CapacityReport = { reachable: true };
const DOWN: CapacityReport = { reachable: false };

/** A directory over fixed reports, with a clock the test moves. */
function directory(reports: Record<string, CapacityReport | (() => Promise<CapacityReport>)>, extra: { ttlMs?: number; urls?: string[]; allowed?: (u: string) => boolean } = {}) {
  let t = 1_000_000;
  const probe = vi.fn(async (url: string, _kind: "chat" | "network") => {
    const r = reports[url];
    if (!r) throw new Error(`unexpected probe of ${url}`);
    return typeof r === "function" ? r() : r;
  });
  const dir = createChatCapacityDirectory({
    candidates: async () => extra.urls ?? Object.keys(reports),
    allowed: extra.allowed ?? (() => true),
    ttlMs: extra.ttlMs ?? 15_000,
    now: () => t,
    probe,
  });
  return { dir, probe, reports, advance: (ms: number) => void (t += ms) };
}

describe("capacityFor", () => {
  it("reads a default chat from the coordinator's own model server", () => {
    expect(capacityFor(WITH_MODEL, { kind: "chat" })).toBe("yes");
    expect(capacityFor(NO_MODEL, { kind: "chat" })).toBe("no");
    expect(capacityFor(OLD_BUILD, { kind: "chat" })).toBe("unknown");
    expect(capacityFor(DOWN, { kind: "chat" })).toBe("no");
  });

  it("reads a network chat from the models connected agents can run", () => {
    const need = { kind: "network", model: "qwen3.5:9b" } as const;
    expect(capacityFor({ reachable: true, agentModels: ["qwen3.5:9b"] }, need)).toBe("yes");
    expect(capacityFor({ reachable: true, agentModels: ["other"] }, need)).toBe("unlisted");
    expect(capacityFor({ reachable: true }, need)).toBe("unknown");
    expect(capacityFor({ reachable: false, agentModels: ["qwen3.5:9b"] }, need)).toBe("no");
  });
});

describe("choosing a coordinator", () => {
  it("prefers the configured primary when it has capacity", async () => {
    const { dir } = directory({ [US]: WITH_MODEL, [EU]: WITH_MODEL });
    expect(await dir.pick({ kind: "chat" })).toEqual({ url: US, known: 2 });
  });

  it("goes to the next coordinator when the primary has no model (the coordinator-only US seed)", async () => {
    const { dir } = directory({ [US]: NO_MODEL, [EU]: WITH_MODEL });
    expect(await dir.pick({ kind: "chat" })).toEqual({ url: EU, known: 2 });
  });

  it("skips a primary that does not answer", async () => {
    const { dir } = directory({ [US]: DOWN, [EU]: WITH_MODEL });
    expect((await dir.pick({ kind: "chat" })).url).toBe(EU);
  });

  it("uses a coordinator that does not say only when none reports capacity", async () => {
    expect((await directory({ [US]: OLD_BUILD, [EU]: WITH_MODEL }).dir.pick({ kind: "chat" })).url).toBe(EU);
    expect((await directory({ [US]: NO_MODEL, [EU]: OLD_BUILD }).dir.pick({ kind: "chat" })).url).toBe(EU);
  });

  it("returns no coordinator, and how many it knows, when none has capacity", async () => {
    const { dir } = directory({ [US]: NO_MODEL, [EU]: DOWN });
    expect(await dir.pick({ kind: "chat" })).toEqual({ url: null, known: 2 });
    expect(await directory({}).dir.pick({ kind: "chat" })).toEqual({ url: null, known: 0 });
  });

  it("does not wait for later coordinators once the primary says yes", async () => {
    const { dir } = directory({ [US]: WITH_MODEL, [EU]: () => new Promise<CapacityReport>(() => undefined) });
    expect((await dir.pick({ kind: "chat" })).url).toBe(US);
  });

  it("leaves out the coordinators a chat already tried", async () => {
    const { dir } = directory({ [US]: WITH_MODEL, [EU]: WITH_MODEL });
    expect((await dir.pick({ kind: "chat" }, [US])).url).toBe(EU);
    expect(await dir.pick({ kind: "chat" }, [`${US}/`, EU])).toEqual({ url: null, known: 2 });
  });

  it("prefers another coordinator for a while after a chat failed on one, without dropping it", async () => {
    const { dir, advance } = directory({ [US]: WITH_MODEL, [EU]: WITH_MODEL });
    dir.markFailed(US);
    expect((await dir.pick({ kind: "chat" })).url).toBe(EU);
    // Still usable when it is the only one left.
    expect((await dir.pick({ kind: "chat" }, [EU])).url).toBe(US);
    advance(15_001);
    expect((await dir.pick({ kind: "chat" })).url).toBe(US);
  });

  it("ranks network coordinators: lists the model, did not say, up but model not listed; never unreachable", async () => {
    const need = { kind: "network", model: "m" } as const;
    const lists: CapacityReport = { reachable: true, agentModels: ["m"] };
    const unlisted: CapacityReport = { reachable: true, agentModels: ["other"] };
    expect((await directory({ [US]: unlisted, [EU]: lists }).dir.pick(need)).url).toBe(EU);
    expect((await directory({ [US]: unlisted, [EU]: OLD_BUILD }).dir.pick(need)).url).toBe(EU);
    // Nobody lists it: the primary is still asked, so the user gets its exact refusal.
    expect((await directory({ [US]: unlisted, [EU]: unlisted }).dir.pick(need)).url).toBe(US);
    expect(await directory({ [US]: DOWN, [EU]: DOWN }).dir.pick(need)).toEqual({ url: null, known: 2 });
  });
});

describe("capacity cache", () => {
  it("asks each coordinator once within the TTL and again after it", async () => {
    const { dir, probe, advance } = directory({ [US]: WITH_MODEL, [EU]: WITH_MODEL });
    await dir.pick({ kind: "chat" });
    await dir.pick({ kind: "chat" });
    advance(14_999);
    await dir.pick({ kind: "chat" });
    expect(probe.mock.calls.filter(([u]) => u === US)).toHaveLength(1);
    advance(2);
    await dir.pick({ kind: "chat" });
    expect(probe.mock.calls.filter(([u]) => u === US)).toHaveLength(2);
  });

  it("keeps default-chat and network answers apart", async () => {
    const { dir, probe } = directory({ [US]: { reachable: true, ownModelCount: 1, agentModels: ["m"] } });
    await dir.pick({ kind: "chat" });
    await dir.pick({ kind: "network", model: "m" });
    await dir.pick({ kind: "network", model: "other" });
    expect(probe.mock.calls.map(([, kind]) => kind)).toEqual(["chat", "network"]);
  });

  it("shares one probe between concurrent chats", async () => {
    let release!: (r: CapacityReport) => void;
    const { dir, probe } = directory({ [US]: () => new Promise<CapacityReport>((r) => (release = r)) });
    const picks = [dir.pick({ kind: "chat" }), dir.pick({ kind: "chat" }), dir.pick({ kind: "chat" })];
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    release(WITH_MODEL);
    expect((await Promise.all(picks)).map((p) => p.url)).toEqual([US, US, US]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("follows a coordinator that gains or loses its model after the TTL", async () => {
    const reports: Record<string, CapacityReport> = { [US]: WITH_MODEL, [EU]: WITH_MODEL };
    const { dir, advance } = directory(reports);
    expect((await dir.pick({ kind: "chat" })).url).toBe(US);
    reports[US] = NO_MODEL;
    expect((await dir.pick({ kind: "chat" })).url).toBe(US); // cached
    advance(15_001);
    expect((await dir.pick({ kind: "chat" })).url).toBe(EU);
  });

  it("asks again before refusing when the cached 'no' is not fresh", async () => {
    const reports: Record<string, CapacityReport> = { [US]: NO_MODEL };
    const { dir, probe, advance } = directory(reports);
    expect((await dir.pick({ kind: "chat" })).url).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
    // Within 3 s the answer stands: an outage does not turn every chat into a probe.
    advance(2_000);
    expect((await dir.pick({ kind: "chat" })).url).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
    // Later (still inside the 15 s TTL) the model has been pulled: the chat is not refused on stale news.
    reports[US] = WITH_MODEL;
    advance(2_000);
    expect((await dir.pick({ kind: "chat" })).url).toBe(US);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("a probe that throws counts as unreachable", async () => {
    const { dir } = directory({ [US]: () => Promise.reject(new Error("boom")), [EU]: WITH_MODEL });
    expect((await dir.pick({ kind: "chat" })).url).toBe(EU);
  });

  it("serves the coordinator list from memory and refreshes it in the background", async () => {
    let t = 0;
    let urls = [US];
    const candidates = vi.fn(async () => urls);
    const dir = createChatCapacityDirectory({ candidates, allowed: () => true, now: () => t, probe: async () => WITH_MODEL });
    expect(await dir.pick({ kind: "chat" })).toEqual({ url: US, known: 1 });
    await dir.pick({ kind: "chat" });
    expect(candidates).toHaveBeenCalledTimes(1);
    urls = [EU, US];
    t += 60_001;
    expect((await dir.pick({ kind: "chat" })).url).toBe(US); // the stale list answers this one
    await vi.waitFor(() => expect(candidates).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect(await dir.pick({ kind: "chat" })).toEqual({ url: EU, known: 2 }));
  });

  it("knows no coordinator when the list cannot be read, and reads it again next time", async () => {
    const candidates = vi.fn<() => Promise<string[]>>().mockRejectedValueOnce(new Error("control plane down")).mockResolvedValue([US]);
    const dir = createChatCapacityDirectory({ candidates, allowed: () => true, probe: async () => WITH_MODEL });
    expect(await dir.pick({ kind: "chat" })).toEqual({ url: null, known: 0 });
    expect(await dir.pick({ kind: "chat" })).toEqual({ url: US, known: 1 });
  });
});

describe("coordinator URL policy", () => {
  const policy = coordinatorUrlPolicyFromEnv({ NODE_ENV: "production" }, [US, EU]);
  const allowed = (u: string) => coordinatorUrlAllowed(u, policy);

  it("never probes or returns a URL the policy refuses", async () => {
    const refused = [
      "http://us.example.com", // not https
      "https://evil.example.net", // not allowlisted (e.g. from discovery data)
      "https://169.254.169.254", // link-local metadata address
      "https://10.0.0.5", // private address
      "http://localhost:4301",
      "https://user:pw@us.example.com", // userinfo
      "not a url",
    ];
    const reports = Object.fromEntries([...refused, EU].map((u) => [u, WITH_MODEL]));
    const { dir, probe } = directory(reports, { urls: [...refused, EU], allowed });
    expect(await dir.pick({ kind: "chat" })).toEqual({ url: EU, known: 1 });
    // The fixed report does not list agent models, so the allowed coordinator is the "did not say" pick.
    expect(await dir.pick({ kind: "network", model: "m" })).toEqual({ url: EU, known: 1 });
    expect(new Set(probe.mock.calls.map(([u]) => u))).toEqual(new Set([EU]));
  });

  it("answers 'no coordinator' when discovery only yields refused URLs", async () => {
    const { dir, probe } = directory({}, { urls: ["https://evil.example.net", "http://127.0.0.1:4301"], allowed });
    expect(await dir.pick({ kind: "chat" })).toEqual({ url: null, known: 0 });
    expect(probe).not.toHaveBeenCalled();
  });

  it("treats the same coordinator written twice as one", async () => {
    const { dir, probe } = directory({ [US]: WITH_MODEL }, { urls: [US, `${US}/`, ` ${US} `], allowed });
    expect(await dir.pick({ kind: "chat" })).toEqual({ url: US, known: 1 });
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("httpCapacityProbe against a coordinator", () => {
  const servers: Array<{ close: () => Promise<unknown> }> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  async function coordinator(routes: { health?: unknown | "hang" | number; models?: unknown | number }) {
    const seen: Array<{ path: string; token: unknown }> = [];
    const co = Fastify({ forceCloseConnections: true });
    co.get("/health/runtime", async (req, reply) => {
      seen.push({ path: req.url, token: req.headers["x-portal-service-token"] });
      if (routes.health === "hang") return new Promise(() => undefined);
      if (typeof routes.health === "number") return reply.code(routes.health).send({ error: "x" });
      return routes.health ?? { ok: true };
    });
    co.get("/inference/models", async (req, reply) => {
      seen.push({ path: req.url, token: req.headers["x-portal-service-token"] });
      if (typeof routes.models === "number") return reply.code(routes.models).send({ error: "x" });
      return routes.models ?? { models: [] };
    });
    await co.listen({ port: 0, host: "127.0.0.1" });
    servers.push(co);
    return { url: `http://127.0.0.1:${(co.server.address() as { port: number }).port}`, seen };
  }
  const probe = httpCapacityProbe({ serviceToken: "svc", timeoutMs: 250 });

  it("reads the coordinator's own model count from /health/runtime, without sending the service token", async () => {
    const withModel = await coordinator({ health: { ok: true, ollama: { reachable: true, modelCount: 2 } } });
    const noOllama = await coordinator({ health: { ok: true, ollama: { reachable: false, modelCount: 0, error: "ECONNREFUSED" } } });
    const empty = await coordinator({ health: { ok: true, ollama: { reachable: true, modelCount: 0 } } });
    const old = await coordinator({ health: { ok: true } });
    expect(await probe(`${withModel.url}/`, "chat")).toEqual({ reachable: true, ownModelCount: 2 });
    expect(await probe(noOllama.url, "chat")).toEqual({ reachable: true, ownModelCount: 0 });
    expect(await probe(empty.url, "chat")).toEqual({ reachable: true, ownModelCount: 0 });
    expect(await probe(old.url, "chat")).toEqual({ reachable: true });
    expect(withModel.seen).toEqual([{ path: "/health/runtime", token: undefined }]);
  });

  it("reads the models agents can run from /inference/models, as the portal", async () => {
    const co = await coordinator({ models: { models: [{ model: "a", agents: 2 }, { model: "gone", agents: 0 }, { model: 7, agents: 1 }, null] } });
    // rttMs: the portal <-> coordinator round trip of this probe (latency-aware choice).
    expect(await probe(co.url, "network")).toEqual({ reachable: true, rttMs: expect.any(Number), agentModels: ["a"] });
    expect(co.seen).toEqual([{ path: "/inference/models", token: "svc" }]);
    expect(await probe((await coordinator({ models: 401 })).url, "network")).toEqual({ reachable: true });
    expect(await probe((await coordinator({ models: { nope: true } })).url, "network")).toEqual({ reachable: true, rttMs: expect.any(Number) });
    // Newer coordinators: queueing signals and the round trip to agents holding the model.
    const loaded = await coordinator({ models: { models: [{ model: "a", agents: 2, idleAgents: 1, freeSlots: 3, waiting: 1, agentRttMs: 41 }], load: { pickupP90Ms: 350, callP50Ms: null } } });
    expect(await probe(loaded.url, "network")).toEqual({ reachable: true, rttMs: expect.any(Number), agentModels: ["a"], modelLoad: { a: { agents: 2, idle: 1, free: 3, waiting: 1, agentRttMs: 41 } }, pickupP90Ms: 350 });
    expect(await probe((await coordinator({ models: 503 })).url, "network")).toEqual({ reachable: false });
  });

  it("gives up after the timeout, on an error status, and on a closed port", async () => {
    const hanging = await coordinator({ health: "hang" });
    const started = Date.now();
    expect(await probe(hanging.url, "chat")).toEqual({ reachable: false });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await probe((await coordinator({ health: 500 })).url, "chat")).toEqual({ reachable: false });
    const closed = await coordinator({});
    await servers.pop()!.close();
    expect(await probe(closed.url, "chat")).toEqual({ reachable: false });
    expect(await probe(closed.url, "network")).toEqual({ reachable: false });
  });
});

describe("chatCapacityOptionsFromEnv", () => {
  it("defaults, reads and clamps the two settings", () => {
    expect(chatCapacityOptionsFromEnv({})).toEqual({ timeoutMs: CHAT_CAPACITY_DEFAULT_TIMEOUT_MS, ttlMs: CHAT_CAPACITY_DEFAULT_TTL_MS, portalRegion: null });
    expect(chatCapacityOptionsFromEnv({ PORTAL_CHAT_CAPACITY_TIMEOUT_MS: "750", PORTAL_CHAT_CAPACITY_TTL_MS: "0" })).toEqual({ timeoutMs: 750, ttlMs: 0, portalRegion: null });
    expect(chatCapacityOptionsFromEnv({ FLY_REGION: "cdg" }).portalRegion).toBe("cdg");
    expect(chatCapacityOptionsFromEnv({ PORTAL_CHAT_CAPACITY_TIMEOUT_MS: "1", PORTAL_CHAT_CAPACITY_TTL_MS: "99999999" })).toEqual({ timeoutMs: 100, ttlMs: 600_000, portalRegion: null });
    expect(chatCapacityOptionsFromEnv({ PORTAL_CHAT_CAPACITY_TIMEOUT_MS: "soon", PORTAL_CHAT_CAPACITY_TTL_MS: " " })).toEqual({ timeoutMs: CHAT_CAPACITY_DEFAULT_TIMEOUT_MS, ttlMs: CHAT_CAPACITY_DEFAULT_TTL_MS, portalRegion: null });
  });
});
