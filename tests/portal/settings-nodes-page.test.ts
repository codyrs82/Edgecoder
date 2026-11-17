import Fastify from "fastify";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { nodeInstallCommand, renderRejectedAttempts } from "../../src/portal/pages/settings-ops.js";
import { CLIENT_ESCAPE_JS } from "../../src/portal/pages/escape.js";

async function nodesHtml(): Promise<string> {
  const app = Fastify();
  registerPortalPages(app);
  const res = await app.inject({ url: "/portal/settings/nodes" });
  await app.close();
  expect(res.statusCode).toBe(200);
  return res.body;
}

/** The page script's functions, run the way the browser runs them. */
function pageFns(html: string) {
  const script = [...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("function renderRejectedAttempts"))!;
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
  const ctx = vm.createContext({});
  vm.runInContext([CLIENT_ESCAPE_JS, grab("nodeInstallCommand"), grab("serverInstallCommand"), grab("renderRejectedAttempts")].join("\n"), ctx);
  return ctx as unknown as {
    nodeInstallCommand: typeof nodeInstallCommand;
    renderRejectedAttempts: typeof renderRejectedAttempts;
  };
}

describe("Settings > Nodes: the name the installer uses", () => {
  it("the install command carries the node id with the token", () => {
    expect(nodeInstallCommand("https://edgecoder.io/", "RTXA2000-Laptop", "abc123")).toBe("curl -fsSLo install.sh https://edgecoder.io/install.sh && sudo bash install.sh --token RTXA2000-Laptop=abc123");
  });

  it("the page shows it after Generate node token, and recommends the install key first", async () => {
    const html = await nodesHtml();
    const fns = pageFns(html);
    expect(fns.nodeInstallCommand("https://edgecoder.io", "lambda-a100-gpu0", "t0k")).toBe("curl -fsSLo install.sh https://edgecoder.io/install.sh && sudo bash install.sh --token lambda-a100-gpu0=t0k");
    expect(html).toContain('id="newInstallCmd"');
    expect(html).toContain("nodeInstallCommand(location.origin, payload.nodeId, payload.registrationToken)");
    expect(html).toContain("The installer names the agent");
    expect(html.indexOf("Easiest: an install key")).toBeLessThan(html.indexOf("Enroll a node"));
    expect(html).toContain('serverInstallCommand(location.origin, "YOUR_INSTALL_KEY")');
  });

  it("lists refused names with Enroll it and How to fix, escaped", async () => {
    const fns = pageFns(await nodesHtml());
    expect(fns.renderRejectedAttempts([], "https://g")).toBe("");
    const out = fns.renderRejectedAttempts([{ nodeId: "nvidia-1-gpu", lastAttemptMs: Date.parse("2026-11-17T08:00:00Z") }], "https://guide/#node-names");
    expect(out).toContain("A machine named <code>nvidia-1-gpu</code> tried to connect with one of your node tokens but isn't enrolled under that name");
    expect(out).toContain("<button type='button' class='enrollAttemptBtn' data-node-id='nvidia-1-gpu'>Enroll it</button>");
    expect(out).toContain("<a href='https://guide/#node-names' target='_blank' rel='noreferrer'>How to fix</a>");
    expect(out).toContain("2026-11-17 08:00 UTC");
    const evil = fns.renderRejectedAttempts([{ nodeId: "<img src=x onerror='alert(1)'>" }], "https://g");
    expect(evil).not.toContain("<img");
    expect(evil).toContain("data-node-id='%3Cimg%20src%3Dx%20onerror%3D%27alert(1)%27%3E'");
  });
});
