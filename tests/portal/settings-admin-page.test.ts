import Fastify from "fastify";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { formatAdminDate } from "../../src/portal/pages/settings-ops.js";
import { CLIENT_ESCAPE_JS } from "../../src/portal/pages/escape.js";

async function adminHtml(): Promise<string> {
  const app = Fastify();
  registerPortalPages(app);
  const res = await app.inject({ url: "/portal/settings/admin" });
  await app.close();
  expect(res.statusCode).toBe(200);
  return res.body;
}

/** The admin page's helper functions, run on their own. */
function adminHelpers(html: string) {
  const script = [...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("function pendingActions"))!;
  const grab = (name: string) => {
    const start = script.indexOf(`function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = script.indexOf("{", start); i < script.length; i++) {
      if (script[i] === "{") depth++;
      if (script[i] === "}" && --depth === 0) return script.slice(start, i + 1);
    }
    throw new Error(name);
  };
  const noOwnerTip = /const NO_OWNER_TIP = [^;]+;/.exec(script)![0];
  const ctx = vm.createContext({});
  vm.runInContext([CLIENT_ESCAPE_JS, noOwnerTip, grab("encodeAttr"), grab("pendingActions"), grab("approvalToast"), grab("formatAdminDate")].join("\n"), ctx);
  return ctx as unknown as {
    pendingActions: (n: Record<string, unknown>) => string;
    approvalToast: (approved: boolean, err?: string) => string;
    formatAdminDate: (ms: number) => string;
  };
}

describe("Settings > Admin layout", () => {
  it("uses the full settings pane and wraps every table in a scroll container", async () => {
    const html = await adminHtml();
    expect(html).toContain('class="settings-layout wide"');
    const pane = html.slice(html.indexOf('<h2 class="set-title">Admin</h2>'));
    const tables = (pane.match(/<table>/g) ?? []).length;
    expect(tables).toBeGreaterThanOrEqual(6);
    expect((pane.match(/<div class="table-scroll( wide)?">\s*<table>/g) ?? []).length).toBe(tables);
    expect(html).toContain('<th>Balance</th><th class="sticky-actions">Actions</th>');
    expect(html).toContain('<th>Last seen</th><th class="sticky-actions">Actions</th>');
    expect(html).toMatch(/\.table-scroll \{ overflow-x: auto;/);
    expect(html).toMatch(/\.table-scroll > table \{ min-width:/);
    expect(html).toContain('" · " + Number(u.approvedMachines) + " approved"');
  });

  it("formats dates compactly with the ISO time in a tooltip, on one line", async () => {
    const ms = Date.parse("2026-11-16T21:02:09.482Z");
    const out = formatAdminDate(ms);
    expect(out).toBe("<time class='nowrap' datetime='2026-11-16T21:02:09.482Z' title='2026-11-16T21:02:09.482Z'>Nov 16, 21:02</time>");
    expect(formatAdminDate(Date.parse("2026-01-05T03:04:00Z"))).toContain(">Jan 5, 03:04<");
    expect(formatAdminDate(0)).toBe("n/a");
    expect(formatAdminDate(undefined)).toBe("n/a");
    // The copy serialised into the page behaves the same.
    expect(adminHelpers(await adminHtml()).formatAdminDate(ms)).toBe(out);
  });
});

describe("Settings > Admin enrollment requests", () => {
  it("never offers Approve for a row with no owner account, and rejects it by dismissal", async () => {
    const h = adminHelpers(await adminHtml());
    const ownerless = h.pendingActions({ nodeId: "lambda-a100-gpu", nodeKind: "agent" });
    expect(ownerless).toContain("<button class='approveBtn' disabled title='No owner: the machine must be enrolled with a token from a signed-in account'");
    expect(ownerless).not.toContain("data-approved='true'");
    expect(ownerless).toContain("data-approved='false' data-owned='false'>Reject</button>");
    const owned = h.pendingActions({ nodeId: "n1", nodeKind: "agent", ownerEmail: "a@b.io" });
    expect(owned).toContain("data-approved='true'>Approve</button>");
    expect(owned).toContain("data-owned='true'>Reject</button>");
  });

  it("names the action in its toast", async () => {
    const h = adminHelpers(await adminHtml());
    expect(h.approvalToast(false)).toBe("Rejected");
    expect(h.approvalToast(true)).toBe("Approved");
    expect(h.approvalToast(false, "no_coordinator")).toBe("Reject failed: no_coordinator");
    expect(h.approvalToast(true, "node_has_no_owner")).toBe("Approve failed: node_has_no_owner");
  });
});
