import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolExecutor, evaluateShellCommand, isWithin } from "../../src/apps/ide/tool-executor.js";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

// #17: path traversal and symlink escape for the IDE tool executor.
const canSymlink = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), "ec-sl-"));
    try {
      symlinkSync(d, join(d, "l"), "dir");
      return true;
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  } catch {
    return false; // Windows without developer mode
  }
})();

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "ec-paths-"));
  made.push(base);
  const root = join(base, "proj");
  const outside = join(base, "outside");
  const sibling = join(base, "proj-evil");
  for (const d of [root, outside, sibling]) mkdirSync(d);
  writeFileSync(join(root, "ok.txt"), "inside\n");
  writeFileSync(join(outside, "secret.txt"), "secret\n");
  writeFileSync(join(sibling, "x.txt"), "evil\n");
  return { base, root, outside, sibling, exec: new ToolExecutor(root) };
}

describe("isWithin (#17)", () => {
  it("has no prefix confusion", () => {
    expect(isWithin("/a/proj", "/a/proj")).toBe(true);
    expect(isWithin("/a/proj", "/a/proj/x/y")).toBe(true);
    expect(isWithin("/a/proj", "/a/proj-evil/x")).toBe(false);
    expect(isWithin("/a/proj", "/a")).toBe(false);
    expect(isWithin("/a/proj", "/a/proj/..foo")).toBe(true);
  });
});

describe("ToolExecutor path safety (#17)", () => {
  it("reads inside the root", async () => {
    const { exec } = fixture();
    expect((await exec.execute("read_file", { path: "ok.txt" })).result).toContain("inside");
  });

  it("rejects ../ traversal, absolute paths and sibling-prefix dirs", async () => {
    const { exec, outside, sibling } = fixture();
    for (const path of ["../outside/secret.txt", join(outside, "secret.txt"), "../proj-evil/x.txt", join(sibling, "x.txt"), "a/../../outside/secret.txt"]) {
      const r = await exec.execute("read_file", { path });
      expect(r.error, path).toMatch(/escapes project root/);
    }
  });

  it.skipIf(!canSymlink)("rejects reading through a symlink that points outside", async () => {
    const { exec, root, outside } = fixture();
    symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt"));
    expect((await exec.execute("read_file", { path: "leak.txt" })).error).toMatch(/Symlink escapes/);
  });

  it.skipIf(!canSymlink)("rejects writing a new file under a symlinked dir that points outside", async () => {
    const { exec, root, outside } = fixture();
    symlinkSync(outside, join(root, "out"), "dir");
    const r = await exec.execute("write_file", { path: "out/new.txt", content: "pwn" }, { approved: true });
    expect(r.error).toMatch(/Symlink escapes/);
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
  });

  it.skipIf(!canSymlink)("rejects writing through a dangling symlink", async () => {
    const { exec, root, outside } = fixture();
    symlinkSync(join(outside, "created-by-link.txt"), join(root, "dangling.txt"));
    const r = await exec.execute("write_file", { path: "dangling.txt", content: "pwn" }, { approved: true });
    expect(r.error).toMatch(/Dangling symlink|Symlink escapes/);
    expect(existsSync(join(outside, "created-by-link.txt"))).toBe(false);
  });

  it.skipIf(!canSymlink)("allows symlinks that stay inside, and a root that is itself behind a symlink", async () => {
    const { base, root } = fixture();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "export {}\n");
    symlinkSync(join(root, "src"), join(root, "alias"), "dir");
    const exec = new ToolExecutor(root);
    expect((await exec.execute("read_file", { path: "alias/a.ts" })).result).toContain("export");
    const linkedRoot = join(base, "linked-root");
    symlinkSync(root, linkedRoot, "dir");
    const viaLink = new ToolExecutor(linkedRoot);
    expect((await viaLink.execute("read_file", { path: "ok.txt" })).result).toContain("inside");
    const w = await viaLink.execute("write_file", { path: "new/deep.txt", content: "hi" }, { approved: true });
    expect(w.error).toBeUndefined();
    expect(readFileSync(join(realpathSync(root), "new", "deep.txt"), "utf8")).toBe("hi");
  });

  it.skipIf(!canSymlink)("run_shell: an unapproved command can't read through a committed symlink (#121 review)", () => {
    const { root, outside } = fixture();
    symlinkSync(outside, join(root, "link"), "dir");
    expect(evaluateShellCommand("cat link/secret.txt", { root })).toMatchObject({ allowed: false });
    expect(evaluateShellCommand("cat ok.txt", { root })).toMatchObject({ allowed: true });
  });

  it("search_files: a pattern starting with '-' is a pattern, not a grep option (#121 review)", async () => {
    const { exec, root } = fixture();
    writeFileSync(join(root, "flags.txt"), "use -f carefully\n");
    const r = await exec.execute("search_files", { pattern: "-f", path: "." });
    expect(r.error).toBeUndefined();
    expect(r.result).toContain("flags.txt");
  });
});
