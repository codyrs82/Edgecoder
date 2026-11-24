// The tentacle routes: list, config, cancel, merge decisions.
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "../../src/apps/ide/checkpoints.js";
import { registerTentacleRoutes } from "../../src/apps/ide/tentacle-routes.js";
import { TentacleManager } from "../../src/apps/ide/tentacles.js";
import { makeHub } from "../helpers/sessions.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tent-routes-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("tentacle routes", () => {
  it("lists, configures (any attached client) and refuses unknown tentacles and frontier workers", async () => {
    const { hub } = makeHub([]);
    const tentacles = new TentacleManager({
      host: { session: (id) => hub.peek(id), publishEvent: (id, ev) => hub.publishEvent(id, ev), recordNote: (id, n) => hub.recordNote(id, n) },
      workerBackend: () => async function* () { yield { done: true as const }; },
      checkpoints: new CheckpointStore(),
      config: { enabled: false },
    });
    const app = Fastify();
    registerTentacleRoutes(app, hub, tentacles);
    const term = { clientId: "term-1", kind: "terminal" as const };
    const s = hub.create({ projectRoot: root, client: term });
    const list = await app.inject({ method: "GET", url: `/v1/ide/sessions/${s.id}/tentacles` });
    expect(list.json()).toMatchObject({ config: { enabled: false }, spentCSats: 0, tentacles: [] });
    // Co-editing: any attached client may change the settings; never a frontier worker.
    const other = await app.inject({ method: "POST", url: `/v1/ide/sessions/${s.id}/tentacles/config`, payload: { clientId: "desk-1", kind: "desktop", enabled: false } });
    expect(other.statusCode).toBe(200);
    const frontier = await app.inject({ method: "POST", url: `/v1/ide/sessions/${s.id}/tentacles/config`, payload: { ...term, workerModel: "frontier/anthropic/claude-opus-5-5" } });
    expect(frontier.statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: `/v1/ide/sessions/${s.id}/tentacles/config`, payload: { ...term, enabled: true, maxParallel: 3, workerModel: "network/qwen3-coder:30b" } });
    expect(ok.json().config).toMatchObject({ enabled: true, maxParallel: 3, workerModel: "network/qwen3-coder:30b" });
    expect(tentacles.enabled(s.id)).toBe(true);
    const merge = await app.inject({ method: "POST", url: `/v1/ide/sessions/${s.id}/tentacles/t0000000/merge`, payload: { ...term, approved: true } });
    expect(merge.statusCode).toBe(404);
    await app.close();
  });

  it("serves a Code view chat's helpers by its id (no hub session), and still 404s unknown ids", async () => {
    const { hub } = makeHub([]);
    const chatId = "6f1c2f9e-8d1b-4c1a-9a43-2b1a3c4d5e6f";
    const tentacles = new TentacleManager({
      host: { session: (id) => hub.peek(id), publishEvent: () => {}, recordNote: () => null },
      workerBackend: () => async function* () { yield { done: true as const }; },
      checkpoints: new CheckpointStore(),
      config: { enabled: false },
    });
    const app = Fastify();
    registerTentacleRoutes(app, hub, tentacles, { isChat: (id) => id === chatId });
    const desk = { clientId: "desk-1", kind: "desktop" as const };
    const list = await app.inject({ method: "GET", url: `/v1/ide/sessions/${chatId}/tentacles` });
    expect(list.statusCode).toBe(200);
    const cfg = await app.inject({ method: "POST", url: `/v1/ide/sessions/${chatId}/tentacles/config`, payload: { ...desk, enabled: true, maxParallel: 2, budgetCSats: 50, localFirst: false } });
    expect(cfg.json().config).toMatchObject({ enabled: true, maxParallel: 2, budgetCSats: 50, localFirst: false });
    const unknown = await app.inject({ method: "GET", url: `/v1/ide/sessions/7f1c2f9e-8d1b-4c1a-9a43-2b1a3c4d5e6f/tentacles` });
    expect(unknown.statusCode).toBe(404);
    await app.close();
  });
});
