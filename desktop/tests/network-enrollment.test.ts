import { describe, expect, it, vi } from "vitest";
import { ensureNetworkEnrollment, type EnrollmentDeps } from "../src/lib/network-enrollment";

function deps(over: Partial<EnrollmentDeps> & { enrolled?: { nodeId: string; coordinatorUrl: string } | null } = {}) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const d: EnrollmentDeps = {
    invoke: (async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "get_network_enrollment") return over.enrolled ?? null;
      if (cmd === "get_network_node_id") return "desktop-mac-1a2b3c4d";
      if (cmd === "save_network_enrollment") return { nodeId: "desktop-mac-1a2b3c4d", coordinatorUrl: "https://coordinator.edgecoder.io" };
      throw new Error(cmd);
    }) as EnrollmentDeps["invoke"],
    fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true, nodeId: "desktop-mac-1a2b3c4d", registrationToken: "f".repeat(64) }), { status: 200 })) as unknown as typeof fetch,
    portal: "https://edgecoder.io/",
    coordinator: "https://coordinator.edgecoder.io",
    sessionToken: "sess",
    ...over,
  };
  return { d, calls };
}

describe("ensureNetworkEnrollment", () => {
  it("enrolls a verified user's machine once and hands the token to the app", async () => {
    const { d, calls } = deps();
    expect(await ensureNetworkEnrollment({ emailVerified: true }, d)).toEqual({ state: "enrolled", nodeId: "desktop-mac-1a2b3c4d", coordinatorUrl: "https://coordinator.edgecoder.io" });
    const [url, init] = (d.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://edgecoder.io/nodes/enroll");
    expect(JSON.parse(init.body)).toEqual({ nodeId: "desktop-mac-1a2b3c4d", nodeKind: "agent" });
    expect(init.headers.Authorization).toBe("Bearer sess");
    const save = calls.find((c) => c.cmd === "save_network_enrollment");
    expect(save?.args).toEqual({ enrollment: { nodeId: "desktop-mac-1a2b3c4d", registrationToken: "f".repeat(64), coordinatorUrl: "https://coordinator.edgecoder.io", portalUrl: "https://edgecoder.io" } });
  });

  it("does nothing when already enrolled", async () => {
    const { d } = deps({ enrolled: { nodeId: "n1", coordinatorUrl: "https://c" } });
    expect(await ensureNetworkEnrollment({ emailVerified: true }, d)).toEqual({ state: "enrolled", nodeId: "n1", coordinatorUrl: "https://c" });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("waits for a verified email and reports portal refusals", async () => {
    const a = deps();
    expect(await ensureNetworkEnrollment({ emailVerified: false }, a.d)).toEqual({ state: "needs_verified_email" });
    const b = deps({ fetch: vi.fn(async () => new Response(JSON.stringify({ error: "node_owned_by_another_user" }), { status: 409 })) as unknown as typeof fetch });
    expect(await ensureNetworkEnrollment({ emailVerified: true }, b.d)).toEqual({ state: "error", message: "node_owned_by_another_user" });
  });
});
