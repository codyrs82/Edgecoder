import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { buildDashboardRoutes } from "../../src/inference/dashboard.js";

describe("Agent Dashboard", () => {
  it("serves HTML at /dashboard", async () => {
    const app = Fastify();
    const state = { activeModel: "qwen2.5-coder:latest", activeModelParamSize: 7.6 };
    buildDashboardRoutes(app, state);

    const res = await app.inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("EdgeCoder Agent Dashboard");
    expect(res.body).toContain("/dashboard/api/overview");
    expect(res.body).toContain("/model/swap");
  });

  it("escapes Ollama-supplied model fields instead of inlining them into HTML or handlers", async () => {
    const app = Fastify();
    buildDashboardRoutes(app, { activeModel: "m", activeModelParamSize: 1 });
    const res = await app.inject({ method: "GET", url: "/dashboard" });
    expect(res.body).not.toContain("onclick=\"swapModel(");
    expect(res.body).toContain("esc(m.modelId)");
    expect(res.body).toContain("esc(entry.from)");
    const src = /function esc\(v\) \{[\s\S]*?\n\}/.exec(res.body)?.[0];
    expect(src).toBeTruthy();
    const esc = new Function(`${src}; return esc;`)() as (v: unknown) => string;
    expect(esc(`x'); alert(1); ('<img src=x onerror=alert(1)>"`)).toBe("x&#39;); alert(1); (&#39;&lt;img src=x onerror=alert(1)&gt;&quot;");
    expect(esc(undefined)).toBe("");
    await app.close();
  });

  it("returns overview API data", async () => {
    const app = Fastify();
    const state = { activeModel: "test-model:3b", activeModelParamSize: 3.0 };
    buildDashboardRoutes(app, state);

    const res = await app.inject({ method: "GET", url: "/dashboard/api/overview" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.activeModel).toBe("test-model:3b");
    expect(body.activeModelParamSize).toBe(3.0);
    expect(typeof body.ollamaHealthy).toBe("boolean");
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(typeof body.memoryMB).toBe("number");
    expect(body.nodeVersion).toMatch(/^v\d+/);
  });

  it("reflects model state changes", async () => {
    const app = Fastify();
    const state = { activeModel: "model-a", activeModelParamSize: 1.5 };
    buildDashboardRoutes(app, state);

    const res1 = await app.inject({ method: "GET", url: "/dashboard/api/overview" });
    expect(JSON.parse(res1.body).activeModel).toBe("model-a");

    state.activeModel = "model-b";
    state.activeModelParamSize = 7.0;

    const res2 = await app.inject({ method: "GET", url: "/dashboard/api/overview" });
    expect(JSON.parse(res2.body).activeModel).toBe("model-b");
    expect(JSON.parse(res2.body).activeModelParamSize).toBe(7.0);
  });
});
