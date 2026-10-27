import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFlyConfigs } from "../../scripts/check-fly-configs.mjs";

// #33. Parsed with regexes rather than a YAML library to avoid a new dependency.
const root = resolve(__dirname, "../..");
// Normalise CRLF (Windows checkouts) so the line-anchored regexes work everywhere.
const wf = readFileSync(resolve(root, ".github/workflows/deploy-fly.yml"), "utf8").replace(/\r\n/g, "\n");

function jobs(yml: string): Map<string, string> {
  const body = yml.slice(yml.indexOf("\njobs:\n") + 7);
  const out = new Map<string, string>();
  const parts = body.split(/^ {2}(?=[\w-]+:\s*$)/m).filter((s) => s.trim());
  for (const p of parts) out.set(p.slice(0, p.indexOf(":")).trim(), p);
  return out;
}

describe("Fly deploy config (#33)", () => {
  it("every referenced config exists and every deploy/fly/*.toml is deployed", () => {
    const r = checkFlyConfigs(root);
    expect(r.missing).toEqual([]);
    expect(r.unreferenced).toEqual([]);
    expect(r.referenced).toEqual([
      "deploy/fly/fly.anchor-proxy.toml",
      "deploy/fly/fly.docs.toml",
      "deploy/fly/fly.portal.toml",
      "deploy/fly/fly.seed-eu.toml",
      "deploy/fly/fly.seed-node.toml",
    ]);
  });

  it("no job references the nonexistent fly.toml", () => {
    expect(wf).not.toMatch(/deploy\/fly\/fly\.toml\b/);
  });

  it("every deploy job needs the gate, runs on main only and stays disabled until #31", () => {
    const j = jobs(wf);
    expect(j.has("gate")).toBe(true);
    const deployJobs = [...j].filter(([name]) => name !== "gate");
    expect(deployJobs.length).toBeGreaterThan(0);
    for (const [name, body] of deployJobs) {
      expect(body, name).toMatch(/needs:\s*\[?\s*gate/);
      expect(body, name).toMatch(/vars\.DEPLOY_ENABLED == 'true'/);
      expect(body, name).toMatch(/refs\/heads\/main|head_branch == 'main'/);
      expect(body, name).toMatch(/environment:\s*production/);
    }
    expect(j.get("gate")).toMatch(/vars\.DEPLOY_ENABLED == 'true'/);
  });

  it("flyctl action is pinned to a commit SHA", () => {
    for (const m of wf.matchAll(/uses:\s*superfly\/flyctl-actions\/setup-flyctl@(\S+)/g)) expect(m[1]).toMatch(/^[0-9a-f]{40}$/);
  });
});
