import { describe, expect, it } from "vitest";
import { renderResultHtml, type RunResult } from "../../extensions/vscode/src/result-html.js";

const base: RunResult = {
  plan: "p",
  generatedCode: "c",
  runResult: { stdout: "", stderr: "", exitCode: 0 },
  route: "swarm",
  latencyMs: 12,
};

describe("VS Code result webview", () => {
  it("escapes server fields it shows, and drops a non-numeric creditsSpent", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const html = renderResultHtml(
      { ...base, route: evil as RunResult["route"], latencyMs: evil as unknown as number, creditsSpent: evil as unknown as number, swarmTaskId: evil },
      "task",
      true,
      "NONCE",
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("credits spent");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(renderResultHtml({ ...base, creditsSpent: 3 }, "t", true, "N")).toContain("3 credits spent");
  });

  it("has a CSP that only runs the page's own nonce'd script, and no inline handlers", () => {
    const html = renderResultHtml(base, "t", true, "abc123");
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-abc123';"/>`);
    expect(html).toContain(`<script nonce="abc123">`);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });
});
