import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectFs, ProjectFsError } from "../../src/apps/ide/project-fs.js";

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pfs-root-"));
  outside = mkdtempSync(join(tmpdir(), "pfs-out-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "README.md"), "# hi\n");
  writeFileSync(join(outside, "secret.txt"), "nope");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof ProjectFsError ? e.code : `other:${String(e)}`;
  }
  return undefined;
}

describe("ProjectFs", () => {
  it("lists directories first and hides .git", () => {
    mkdirSync(join(root, ".git"));
    const names = new ProjectFs(root).list("").map((e) => `${e.kind}:${e.path}`);
    expect(names).toEqual(["dir:src", "file:README.md"]);
    expect(new ProjectFs(root).list("src")).toEqual([{ name: "a.ts", path: "src/a.ts", kind: "file", size: 20 }]);
  });

  it("refuses paths and symlinks that leave the project", () => {
    const fs = new ProjectFs(root);
    expect(code(() => fs.read("../" + outside.split("/").pop() + "/secret.txt"))).toBe("escape");
    expect(code(() => fs.read("/etc/hosts"))).toBe("escape");
    symlinkSync(outside, join(root, "link"));
    expect(code(() => fs.read("link/secret.txt"))).toBe("escape");
    expect(code(() => fs.write("link/new.txt", "x"))).toBe("escape");
    // The escaping symlink is not listed either.
    expect(fs.list("").some((e) => e.name === "link")).toBe(false);
  });

  it("reads, writes and refuses to overwrite a file changed on disk since it was opened", () => {
    const fs = new ProjectFs(root);
    const opened = fs.read("src/a.ts");
    expect(opened.content).toBe("export const a = 1;\n");
    const saved = fs.write("src/a.ts", "export const a = 2;\n", opened.mtimeMs);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
    // Someone else (the agent) writes; a save based on the old version is a conflict.
    writeFileSync(join(root, "src", "a.ts"), "agent edit\n");
    const later = new Date(Date.now() + 5000);
    utimesSync(join(root, "src", "a.ts"), later, later);
    expect(code(() => fs.write("src/a.ts", "stale\n", saved.mtimeMs))).toBe("conflict");
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("agent edit\n");
  });

  it("creates, renames and deletes; never the root", () => {
    const fs = new ProjectFs(root);
    fs.create("lib/util.ts", "file");
    expect(existsSync(join(root, "lib", "util.ts"))).toBe(true);
    expect(code(() => fs.create("lib/util.ts", "file"))).toBe("exists");
    fs.rename("lib/util.ts", "lib/helpers.ts");
    expect(existsSync(join(root, "lib", "helpers.ts"))).toBe(true);
    fs.remove("lib");
    expect(existsSync(join(root, "lib"))).toBe(false);
    expect(code(() => fs.remove(""))).toBe("invalid");
    expect(code(() => fs.remove("."))).toBe("invalid");
  });

  it("does not open binary files", () => {
    writeFileSync(join(root, "img.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    expect(code(() => new ProjectFs(root).read("img.bin"))).toBe("binary");
  });

  it("reports mtimes for open files, null for missing ones", () => {
    const m = new ProjectFs(root).stat(["src/a.ts", "gone.ts", "../x"]);
    expect(typeof m["src/a.ts"]).toBe("number");
    expect(m["gone.ts"]).toBeNull();
    expect(m["../x"]).toBeNull();
  });

  it("reads branch and per-file git status", () => {
    const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    writeFileSync(join(root, "README.md"), "# changed\n");
    writeFileSync(join(root, "new.txt"), "n\n");
    const st = new ProjectFs(root).gitStatus()!;
    expect(st.branch).toBe("main");
    expect(st.files).toEqual({ "README.md": "M", "new.txt": "U" });
    expect(new ProjectFs(outside).gitStatus()).toBeNull();
  });
});

describe("readProjectRules", () => {
  it("collects every rules file present, named, in order", async () => {
    const { readProjectRules } = await import("../../src/apps/ide/project-fs.js");
    expect(readProjectRules(root)).toBe("");
    writeFileSync(join(root, "AGENTS.md"), "Use tabs.\n");
    mkdirSync(join(root, ".edgecoder"));
    writeFileSync(join(root, ".edgecoder", "rules.md"), "Never touch deploy/.\n");
    expect(readProjectRules(root)).toBe("### AGENTS.md\nUse tabs.\n\n### .edgecoder/rules.md\nNever touch deploy/.");
  });

  it("caps the total size", async () => {
    const { readProjectRules } = await import("../../src/apps/ide/project-fs.js");
    writeFileSync(join(root, "AGENTS.md"), "x".repeat(40_000));
    const r = readProjectRules(root);
    expect(r.length).toBeLessThan(17_000);
    expect(r.endsWith("(truncated)")).toBe(true);
  });
});

describe("findPaths", () => {
  it("ranks file-name matches first and skips node_modules", async () => {
    const { findPaths } = await import("../../src/apps/ide/project-fs.js");
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    writeFileSync(join(root, "src", "lib", "api.ts"), "");
    writeFileSync(join(root, "src", "apples.ts"), "");
    mkdirSync(join(root, "node_modules", "x"), { recursive: true });
    writeFileSync(join(root, "node_modules", "x", "api.ts"), "");
    const r = findPaths(root, "api", 5).map((m) => m.path);
    expect(r[0]).toBe("src/lib/api.ts");
    expect(r.some((p) => p.startsWith("node_modules"))).toBe(false);
    expect(findPaths(root, "zzz", 5)).toEqual([]);
  });
});
