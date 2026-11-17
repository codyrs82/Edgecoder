import { afterEach, describe, expect, it, vi } from "vitest";
import { keepEnrolledAgentId, lookupTokenNode, resolveTokenNodeId, runInstaller, type HttpGet } from "../../src/install/cli.js";
import { detectHardware, type Probe } from "../../src/install/hardware.js";
import { parseInstallArgs } from "../../src/install/options.js";
import { planInstall, renderEnvFile } from "../../src/install/plan.js";
import { defaultPaths, type Host } from "../../src/install/services.js";

const probe: Probe = () => null;
// Patrick's laptop: hostname nvidia-1, so the installer's own id is nvidia-1-cpu here (no GPU probe).
const hw = detectHardware({ probe, platform: "linux", arch: "x64", ramGb: 32, cpuModel: "x", cpuCores: 8, hostname: "nvidia-1" });

/** A portal that knows one token. */
function portal(tokens: Record<string, { nodeId: string; nodeKind?: string }>): HttpGet & { calls: string[] } {
  const calls: string[] = [];
  const get = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push(url);
    const token = (init.headers.authorization ?? "").replace(/^Bearer /, "");
    const node = tokens[token];
    return node ? { status: 200, json: async () => ({ nodeKind: "agent", ...node }) } : { status: 401, json: async () => ({ error: "registration_token_invalid" }) };
  }) as HttpGet & { calls: string[] };
  get.calls = calls;
  return get;
}
const offline: HttpGet = async () => { throw new Error("ECONNREFUSED"); };

afterEach(() => vi.restoreAllMocks());

describe("edgecoder-install names the agent after its token's node id", () => {
  it("a bare --token: the agent takes the enrolled node id, not the hostname's", async () => {
    const opts = parseInstallArgs(["apply", "--token", "tok.patrick"]);
    const plan = planInstall(hw, opts, true);
    expect(plan.instances[0].agentId).toBe("nvidia-1-cpu");
    const get = portal({ "tok.patrick": { nodeId: "RTXA2000-Laptop" } });
    const r = await resolveTokenNodeId(opts, plan, get);
    expect(r.error).toBeUndefined();
    expect(get.calls).toEqual(["https://edgecoder.io/nodes/token-node"]);
    expect(r.notes.join("\n")).toMatch(/would be "nvidia-1-cpu", but its registration token was issued for "RTXA2000-Laptop"/);
    const again = planInstall(hw, opts, true);
    expect(again.instances[0].agentId).toBe("RTXA2000-Laptop");
    expect(again.instances[0].env.AGENT_ID).toBe("RTXA2000-Laptop");
    expect(again.instances[0].env.AGENT_REGISTRATION_TOKEN).toBe("tok.patrick");
  });

  it("--token ID=TOKEN with another id than the computed one: uses ID when the portal can't say", async () => {
    const opts = parseInstallArgs(["apply", "--agent-id-prefix", "lambda-a100", "--token", "lambda-a100-gpu0=tok.owner"]);
    const plan = planInstall(hw, opts, true);
    expect(plan.instances[0].agentId).toBe("lambda-a100-cpu");
    const r = await resolveTokenNodeId(opts, plan, offline);
    expect(r.notes.join("\n")).toMatch(/could not check/);
    const again = planInstall(hw, opts, true);
    expect(again.instances[0].agentId).toBe("lambda-a100-gpu0");
    expect(again.instances[0].env.AGENT_REGISTRATION_TOKEN).toBe("tok.owner");
  });

  it("the portal's answer wins over a mistyped ID=", async () => {
    const opts = parseInstallArgs(["apply", "--token", "wrong-name=tok.a"]);
    await resolveTokenNodeId(opts, planInstall(hw, opts, true), portal({ "tok.a": { nodeId: "right-name" } }));
    expect(planInstall(hw, opts, true).instances[0].agentId).toBe("right-name");
  });

  it("keeps the computed id when it already matches, and asks nothing without a token", async () => {
    const opts = parseInstallArgs(["apply", "--token", "tok.same"]);
    const r = await resolveTokenNodeId(opts, planInstall(hw, opts, true), portal({ "tok.same": { nodeId: "nvidia-1-cpu" } }));
    expect(r.notes).toEqual([]);
    expect(opts.agentIdOverride).toBeUndefined();
    const none = portal({});
    const o2 = parseInstallArgs(["apply"]);
    expect(await resolveTokenNodeId(o2, planInstall(hw, o2, true), none)).toEqual({ notes: [] });
    expect(none.calls).toEqual([]);
  });

  it("refuses a coordinator's token for an agent, and a malformed node id from the portal", async () => {
    const opts = parseInstallArgs(["apply", "--token", "tok.c"]);
    const r = await resolveTokenNodeId(opts, planInstall(hw, opts, true), portal({ "tok.c": { nodeId: "coord-1", nodeKind: "coordinator" } }));
    expect(r.error).toMatch(/coordinator node "coord-1", not an agent/);
    expect(await lookupTokenNode("https://p.example", "tok", portal({ tok: { nodeId: "bad id; rm -rf" } }))).toBeNull();
  });

  it("several agents: a bare token is an error, an unmatched ID= a warning", async () => {
    const opts = parseInstallArgs(["apply", "--instances", "2", "--token", "tok.one"]);
    const plan = planInstall(hw, opts, true);
    const get = portal({ "tok.one": { nodeId: "x" } });
    const r = await resolveTokenNodeId(opts, plan, get);
    expect(r.error).toMatch(/belongs to one node id, but this host runs 2 agents \(nvidia-1-gpu0, nvidia-1-gpu1\)/);
    expect(r.error).toMatch(/--token <id>=<token>/);
    expect(get.calls).toEqual([]);
    const o2 = parseInstallArgs(["apply", "--instances", "2", "--token", "nvidia-1-gpu0=t0", "--token", "other-box=t9"]);
    const r2 = await resolveTokenNodeId(o2, planInstall(hw, o2, true), get);
    expect(r2.error).toBeUndefined();
    expect(r2.notes.join("\n")).toMatch(/token for "other-box" matches none/);
  });

  it("runInstaller apply stops before writing anything on a bare token for several agents", async () => {
    const writes: string[] = [];
    const host: Host = { platform: "linux", writeFile: (p) => { writes.push(p); }, removeFile: () => undefined, run: () => ({ code: 1, stdout: "", stderr: "" }), exists: () => false };
    const err: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m: unknown) => { err.push(String(m)); });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runInstaller(["apply", "--instances", "2", "--sandbox", "docker", "--token", "tok.one", "--config-dir", "/nonexistent-ec"], {}, host, undefined, undefined, portal({}))).toBe(2);
    expect(err.join("\n")).toMatch(/this host runs 2 agents/);
    expect(writes).toEqual([]);
  });

  it("runInstaller plan shows the token's node id", async () => {
    const host: Host = { platform: "linux", writeFile: () => undefined, removeFile: () => undefined, run: () => ({ code: 1, stdout: "", stderr: "" }), exists: () => false };
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => { out.push(String(m)); });
    vi.spyOn(console, "error").mockImplementation((m: unknown) => { out.push(String(m)); });
    expect(await runInstaller(["plan", "--json", "--sandbox", "docker", "--single", "--token", "tok.p", "--config-dir", "/nonexistent-ec"], {}, host, undefined, undefined, portal({ "tok.p": { nodeId: "RTXA2000-Laptop" } }))).toBe(0);
    const json = JSON.parse(out.find((l) => l.startsWith("{"))!);
    expect(json.plan.instances.map((i: { agentId: string }) => i.agentId)).toEqual(["RTXA2000-Laptop"]);
    expect(out.join("\n")).toMatch(/registration token was issued for "RTXA2000-Laptop"/);
  });

  it("a re-run without a token keeps the previous install's enrolled id and token", () => {
    const p = defaultPaths("linux", { appDir: "/opt/edgecoder" });
    const prev = (agentId: string, token: string) => (f: string) => (f === `${p.configDir}/agent-0.env` ? renderEnvFile({ AGENT_ID: agentId, AGENT_REGISTRATION_TOKEN: token }) : undefined);
    const opts = parseInstallArgs(["apply"]);
    expect(keepEnrolledAgentId(opts, planInstall(hw, opts, true), p, prev("RTXA2000-Laptop", "tok.kept"))).toBe("RTXA2000-Laptop");
    expect(planInstall(hw, opts, true).instances[0].agentId).toBe("RTXA2000-Laptop");
    // Not over a token or install key given now, nor from a malformed file.
    const withToken = parseInstallArgs(["apply", "--token", "t"]);
    expect(keepEnrolledAgentId(withToken, planInstall(hw, withToken, true), p, prev("RTXA2000-Laptop", "tok"))).toBeUndefined();
    const withKey = parseInstallArgs(["apply", "--enroll", "eck_x"]);
    expect(keepEnrolledAgentId(withKey, planInstall(hw, withKey, true), p, prev("RTXA2000-Laptop", "tok"))).toBeUndefined();
    const bad = parseInstallArgs(["apply"]);
    expect(keepEnrolledAgentId(bad, planInstall(hw, bad, true), p, prev("RTXA2000-Laptop", "bad token"))).toBeUndefined();
    const multi = parseInstallArgs(["apply", "--instances", "2"]);
    expect(keepEnrolledAgentId(multi, planInstall(hw, multi, true), p, prev("RTXA2000-Laptop", "tok"))).toBeUndefined();
  });
});
