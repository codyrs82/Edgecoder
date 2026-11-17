import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolExecutor } from "../../src/apps/ide/tool-executor.js";
import { closestNames, findPathVariant, isCloudFetchError, notFoundMessage } from "../../src/apps/ide/path-hints.js";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A bot workspace shaped like the one that hit the bug: work/security and work/oneleet, no INDEX/README. */
function workspace() {
  const base = mkdtempSync(join(tmpdir(), "ec-nf-"));
  made.push(base);
  const root = join(base, "Sallay cyber security");
  mkdirSync(join(root, "work", "security"), { recursive: true });
  mkdirSync(join(root, "work", "oneleet"), { recursive: true });
  writeFileSync(join(root, "README.md"), "top\n");
  writeFileSync(join(root, "work", "security", "2026-09-01-8am-exec-summary.md"), "summary\n");
  writeFileSync(join(root, "work", "security", "2026-11-11-cloudshell-apply-ocean-alerts-README.txt"), "alerts\n");
  writeFileSync(join(root, "work", "oneleet", "cody-steps.md"), "steps\n");
  writeFileSync(join(root, "work", "oneleet", "evidence-plan.md"), "plan\n");
  return { root, exec: new ToolExecutor(root) };
}

describe("read_file on a missing path", () => {
  it("returns a short, relative first line and points at real names", async () => {
    const { root, exec } = workspace();
    const r = await exec.execute("read_file", { path: "work/security/INDEX.md" });
    const lines = r.error!.split("\n");
    expect(lines[0]).toBe("File not found: work/security/INDEX.md");
    expect(r.error).not.toContain(root); // no absolute path in the UI or the model's context
    expect(r.error).toContain("list_directory on work/security");
  });

  it("suggests the closest sibling names", async () => {
    const { exec } = workspace();
    const r = await exec.execute("read_file", { path: "work/oneleet/cody_steps.md" });
    expect(r.error).toMatch(/Did you mean: work\/oneleet\/cody-steps\.md/);
  });

  it("names the missing folder when a directory segment is wrong", async () => {
    const { exec } = workspace();
    const r = await exec.execute("read_file", { path: "work/secrity/notes.md" });
    expect(r.error).toContain("There is no folder work/secrity.");
    expect(r.error).toContain("Did you mean: work/security");
  });

  it("says when a folder was given to read_file", async () => {
    const { exec } = workspace();
    const r = await exec.execute("read_file", { path: "work/security" });
    expect(r.error!.split("\n")[0]).toBe("work/security is a folder, not a file.");
  });

  it("list_directory on a missing folder gets the same help", async () => {
    const { exec } = workspace();
    const r = await exec.execute("list_directory", { path: "work/securty" });
    expect(r.error!.split("\n")[0]).toBe("Folder not found: work/securty");
    expect(r.error).toContain("Did you mean: work/security");
  });
});

describe("read_file finds the entry the model meant", () => {
  it("matches a name written in another Unicode normalization", async () => {
    const { root, exec } = workspace();
    const nfd = "résumé.md"; // "résumé" decomposed, as some providers store it
    writeFileSync(join(root, "work", nfd), "cv\n");
    const stored = readdirSync(join(root, "work")).find((n) => n.normalize("NFC") === "résumé.md")!;
    const other = stored === stored.normalize("NFC") ? stored.normalize("NFD") : stored.normalize("NFC");
    const r = await exec.execute("read_file", { path: `work/${other}` });
    expect(r.result).toContain("cv");
  });

  it("matches a unique case-insensitive name", async () => {
    const { exec } = workspace();
    const r = await exec.execute("read_file", { path: "WORK/OneLeet/Cody-Steps.md" });
    expect(r.result).toContain("steps");
  });

  it("drops a leading segment that repeats the workspace folder name", async () => {
    const { exec } = workspace();
    const r = await exec.execute("read_file", { path: "Sallay cyber security/work/oneleet/evidence-plan.md" });
    expect(r.result).toContain("plan");
  });

  it("still refuses paths outside the root", async () => {
    const { exec } = workspace();
    const r = await exec.execute("read_file", { path: "../outside.txt" });
    expect(r.error).toMatch(/escapes project root/);
  });
});

describe("path-hints helpers", () => {
  it("closestNames ranks shared stems and near spellings first", () => {
    expect(closestNames("readme.md", ["README.md", "notes.txt", "index.html"])[0]).toBe("README.md");
    expect(closestNames("INDEX.md", ["a.json", "b.txt"])).toEqual([]);
  });

  it("findPathVariant returns null when nothing matches", () => {
    const { root } = workspace();
    expect(findPathVariant(root, join(root, "work", "security", "INDEX.md"))).toBeNull();
  });

  it("notFoundMessage handles an empty folder", () => {
    const { root } = workspace();
    mkdirSync(join(root, "empty"));
    expect(notFoundMessage(root, join(root, "empty", "x.md"))).toContain("empty is empty.");
  });

  it("recognises online-only fetch failures", () => {
    expect(isCloudFetchError("EDEADLK")).toBe(true);
    expect(isCloudFetchError("ENOENT")).toBe(false);
  });
});
