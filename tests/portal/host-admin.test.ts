import Fastify from "fastify";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { HOST_ADMIN_JS } from "../../src/portal/pages/host-admin.js";
import { CLIENT_ESCAPE_JS } from "../../src/portal/pages/escape.js";
import { autoRequestHosting, AUTO_HOST_REQUEST_SOURCE, type HostRequestRecord } from "../../src/portal/host-requests.js";
import { registerPortalPages } from "../../src/portal/pages/index.js";

function hostScript(opts: { confirm?: boolean; fail?: string } = {}) {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const toasts: Array<[string, boolean]> = [];
  let clickHandler: ((e: unknown) => void) | undefined;
  const ctx = vm.createContext({
    document: { addEventListener: (_t: string, fn: (e: unknown) => void) => { clickHandler = fn; } },
    confirm: () => opts.confirm ?? true,
    showToast: (m: string, err = false) => toasts.push([m, err]),
    statusBadge: (text: string, tone: string) => `[${tone}:${text}]`,
    api: async (path: string, o: { body?: string } = {}) => {
      calls.push({ path, body: o.body ? JSON.parse(o.body) : undefined });
      if (opts.fail && path !== "/portal/api/admin/host-requests") throw new Error(opts.fail);
      return { required: true, allowlist: ["boss@x.io"], hosts: [{ email: "host@x.io" }] };
    }
  });
  vm.runInContext(CLIENT_ESCAPE_JS + HOST_ADMIN_JS + "\nthis.hostAdmin = hostAdmin;", ctx);
  return { ctx: ctx as any, calls, toasts, click: (email: string, action: string) => clickHandler!({ preventDefault() {}, target: { closest: () => ({ getAttribute: (a: string) => (a === "data-host-email" ? encodeURIComponent(email) : action) }) } }) };
}
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

describe("one-click host approval (host-admin.ts)", () => {
  it("renders nothing until the admin host list loads", () => {
    const { ctx } = hostScript();
    expect(ctx.hostBadge("a@x.io")).toBe("");
    expect(ctx.hostButton("a@x.io")).toBe("");
  });

  it("shows Host / Own work only with Approve or Revoke, none for allowlisted emails", async () => {
    const { ctx } = hostScript();
    await ctx.loadHostDirectory();
    expect(ctx.hostBadge("host@x.io")).toBe("[ok:Host]");
    expect(ctx.hostBadge("new@x.io")).toBe("[warn:Own work only]");
    expect(ctx.hostButton("new@x.io", "Approve owner as host")).toContain("data-host-action='approve'>Approve owner as host</button>");
    expect(ctx.hostButton("HOST@x.io")).toContain("data-host-action='revoke'>Revoke host</button>");
    expect(ctx.hostButton("boss@x.io")).toBe("");
    expect(ctx.hostBadge("boss@x.io")).toBe("[ok:Host]");
  });

  it("approves with a confirm and a toast, then re-renders", async () => {
    const { ctx, calls, toasts, click } = hostScript();
    await ctx.loadHostDirectory();
    const changed = vi.fn();
    ctx.onHostDirectoryChange(changed);
    click("new@x.io", "approve");
    await flush();
    expect(calls.find((c) => c.path === "/portal/api/admin/hosts")?.body).toMatchObject({ email: "new@x.io" });
    expect(toasts).toEqual([["Approved host: new@x.io", false]]);
    expect(changed).toHaveBeenCalled();
    click("host@x.io", "revoke");
    await flush();
    expect(calls.find((c) => c.path === "/portal/api/admin/hosts/revoke")?.body).toEqual({ email: "host@x.io" });
    expect(toasts[1]).toEqual(["Revoked host: host@x.io", false]);
  });

  it("does nothing when the confirm is cancelled, and names the failure", async () => {
    const cancelled = hostScript({ confirm: false });
    await cancelled.ctx.loadHostDirectory();
    cancelled.click("new@x.io", "approve");
    await flush();
    expect(cancelled.calls.map((c) => c.path)).toEqual(["/portal/api/admin/host-requests"]);
    const failing = hostScript({ fail: "admin_only" });
    await failing.ctx.loadHostDirectory();
    failing.click("new@x.io", "approve");
    await flush();
    expect(failing.toasts).toEqual([["Approve host failed: admin_only", true]]);
  });

  it("is on the admin user and node rows, Settings > Nodes and Settings > Network", async () => {
    const app = Fastify();
    registerPortalPages(app);
    const admin = (await app.inject({ url: "/portal/settings/admin" })).body;
    expect(admin).toContain('hostButton(u.email, "Approve host")');
    expect(admin).toContain('hostButton(n.ownerEmail, "Approve owner as host")');
    expect(admin).toMatch(/<details class="u-mt-10">\s*<summary>Add by email<\/summary>[\s\S]*id="hostApproveEmail"[\s\S]*<\/details>/);
    const nodes = (await app.inject({ url: "/portal/settings/nodes" })).body;
    expect(nodes).toContain('hostButton(nodeOwnerEmail, "Approve owner as host")');
    const network = (await app.inject({ url: "/portal/settings/network" })).body;
    expect(network).toContain('hostButton(a.email, "Approve owner as host")');
    expect(network).toContain("function loadHostDirectory");
    await app.close();
  });
});

describe("automatic host requests", () => {
  function store(requests: HostRequestRecord[] = [], hosts: string[] = []) {
    const created: HostRequestRecord[] = [];
    return {
      created,
      store: {
        createHostRequest: async (r: HostRequestRecord) => { created.push(r); requests.push(r); },
        listHostRequests: async () => requests,
        getHostApproval: async (email: string) => (hosts.includes(email) ? ({ email } as never) : null)
      }
    };
  }
  const policy = { required: true, allowlist: new Set(["boss@x.io"]) };
  const node = { nodeId: "lambda-a100-gpu", nodeKind: "agent" as const, ownerEmail: "New@X.io", lastCountryCode: "US", hardware: "NVIDIA A100" };

  it("files one pending request per email for a non-host owner", async () => {
    const s = store();
    const filed = await autoRequestHosting({ store: s.store, policy, now: () => 1000 }, node);
    expect(filed).toMatchObject({ email: "new@x.io", status: "new", hostKinds: ["compute_agent"], hardwareDetails: "Machine: lambda-a100-gpu · NVIDIA A100", region: "US", message: `Source: ${AUTO_HOST_REQUEST_SOURCE}` });
    expect(AUTO_HOST_REQUEST_SOURCE).toBe("auto (machine enrolled)");
    expect(await autoRequestHosting({ store: s.store, policy }, { ...node, nodeId: "second" })).toBeNull();
    expect(s.created).toHaveLength(1);
  });

  it("files nothing for hosts, allowlisted owners, or with the gate off", async () => {
    const s = store([], ["new@x.io"]);
    expect(await autoRequestHosting({ store: s.store, policy }, node)).toBeNull();
    expect(await autoRequestHosting({ store: s.store, policy }, { ...node, ownerEmail: "boss@x.io" })).toBeNull();
    expect(await autoRequestHosting({ store: store().store, policy: { ...policy, required: false } }, node)).toBeNull();
    expect(s.created).toEqual([]);
  });
});
