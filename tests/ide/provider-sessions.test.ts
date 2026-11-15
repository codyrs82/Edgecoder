import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The provider's shared-session and GitHub sign-in routes: behind the IDE token like the rest.
const TOKEN = "test-ide-token-sessions-0123456789";
const tmp = mkdtempSync(join(tmpdir(), "prov-sess-"));
const project = mkdtempSync(join(tmpdir(), "prov-proj-"));
const gh = join(tmp, "gh");
writeFileSync(gh, "#!/bin/sh\nif [ \"$1\" = auth ] && [ \"$2\" = login ]; then echo '! One-time code (ABCD-1234) copied to clipboard' >&2; sleep 2; exit 0; fi\nexit 1\n");
chmodSync(gh, 0o755);
process.env.IDE_PROVIDER_TOKEN = TOKEN;
process.env.EDGECODER_SESSIONS_DIR = join(tmp, "sessions");
process.env.EDGECODER_TRUST_FILE = join(tmp, "trusted.json");
process.env.EDGECODER_GH_BIN = gh;
delete process.env.IDE_PROVIDER_HOST;

const { ideProviderServer: app } = await import("../../src/apps/ide/provider-server.js");
const headers = { host: "127.0.0.1:4304", authorization: `Bearer ${TOKEN}` };
const who = { clientId: "term-x", kind: "terminal", label: "Terminal" };

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe("provider: shared sessions and GitHub sign-in", () => {
  it("needs the IDE token", async () => {
    for (const [method, url] of [["GET", "/v1/ide/sessions"], ["POST", "/v1/ide/sessions"], ["POST", "/v1/ide/github/login"]] as const) {
      const res = await app.inject({ method, url, headers: { host: "127.0.0.1:4304" }, payload: method === "POST" ? {} : undefined });
      expect(res.statusCode).toBe(401);
    }
  });

  it("creates a session, trusts its folder, publishes it and lists it as shown in the app", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/ide/sessions", headers, payload: { ...who, projectRoot: project, model: "network/qwen3-coder:30b" } });
    expect(created.statusCode).toBe(200);
    const snap = created.json();
    expect(snap).toMatchObject({ trusted: false, controller: who, session: { projectRoot: project, model: "qwen3-coder:30b", compute: { target: "network" } } });
    const id = snap.session.id;
    expect((await app.inject({ method: "POST", url: `/v1/ide/sessions/${id}/trust`, headers, payload: { ...who, trusted: true } })).json()).toMatchObject({ trusted: true });
    // Another client can't publish (or write) until it takes control.
    const desk = { clientId: "desk-y", kind: "desktop" };
    expect((await app.inject({ method: "POST", url: `/v1/ide/sessions/${id}/publish`, headers, payload: { ...desk, published: true } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/v1/ide/sessions/${id}/publish`, headers, payload: { ...who, published: true } })).statusCode).toBe(200);
    const list = (await app.inject({ method: "GET", url: "/v1/ide/sessions?published=1", headers })).json();
    expect(list.sessions.map((s: { id: string }) => s.id)).toEqual([id]);
    expect((await app.inject({ method: "POST", url: "/v1/ide/sessions", headers, payload: { ...who, projectRoot: "relative/path" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/ide/sessions/00000000-0000-4000-8000-000000000000", headers })).statusCode).toBe(404);
  });

  // The fake gh here is a shell script (EDGECODER_GH_BIN); the device flow itself is covered on every OS in github-device.test.ts.
  it.skipIf(process.platform === "win32")("starts gh's device flow and returns the code", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/ide/github/login", headers, payload: {} });
    expect(res.json()).toMatchObject({ state: "waiting", code: "ABCD-1234", url: "https://github.com/login/device" });
    const status = await app.inject({ method: "GET", url: `/v1/ide/github/login/${res.json().id}`, headers });
    expect(status.statusCode).toBe(200);
    await app.inject({ method: "POST", url: `/v1/ide/github/login/${res.json().id}/cancel`, headers, payload: {} });
  });
});
