import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { isProjectTrusted, setProjectTrusted } from "../../src/apps/ide/workspace-trust.js";
import { checkProject, parseCargo, parsePyCompile, parseRuff, parseTsc } from "../../src/apps/ide/diagnostics.js";

describe("checker output parsing", () => {
  it("tsc", () => {
    const d = parseTsc("src/a.ts(3,7): error TS2304: Cannot find name 'x'.\nnoise\n", "/p", "/p");
    expect(d).toEqual([{ path: "src/a.ts", line: 3, column: 7, severity: "error", message: "Cannot find name 'x'. (TS2304)", source: "tsc" }]);
  });
  it("tsc in a subproject maps paths to the project root", () => {
    expect(parseTsc("src/x.ts(1,1): error TS1005: ';' expected.", "/p", "/p/desktop")[0].path).toBe("desktop/src/x.ts");
  });
  it("ruff", () => {
    const json = JSON.stringify([{ filename: "/p/a.py", code: "F401", message: "`os` imported but unused", location: { row: 1, column: 8 }, end_location: { row: 1, column: 10 } }]);
    expect(parseRuff(json, "/p")).toEqual([{ path: "a.py", line: 1, column: 8, endLine: 1, endColumn: 10, severity: "warning", message: "`os` imported but unused (F401)", source: "ruff" }]);
  });
  it("cargo", () => {
    expect(parseCargo("src/main.rs:12:5: error[E0425]: cannot find value `x` in this scope", "/p", "/p/app")).toEqual([
      { path: "app/src/main.rs", line: 12, column: 5, severity: "error", message: "cannot find value `x` in this scope[E0425]", source: "cargo" },
    ]);
  });
  // Windows runners: `python3` is the Store alias or a cold interpreter that can outlast the test's
  // timeout (seen at 24 s in CI); the parser itself is covered on Linux and macOS.
  it.skipIf(process.platform === "win32")("python syntax errors (real interpreter output)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pyc-"));
    try {
      writeFileSync(join(dir, "bad.py"), "x = 1\ndef f(:\n    pass\n");
      let stderr = "";
      try {
        execFileSync("python3", ["-m", "py_compile", join(dir, "bad.py")], { stdio: ["ignore", "ignore", "pipe"] });
      } catch (e) {
        stderr = String((e as { stderr: Buffer }).stderr);
      }
      const d = parsePyCompile(stderr, "bad.py");
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({ path: "bad.py", line: 2, severity: "error", source: "python" });
      expect(d[0].message).toMatch(/SyntaxError/);
      expect(parsePyCompile("", "ok.py")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkProject", () => {
  it("runs the project's tsc and reports errors by file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsproj-"));
    try {
      writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["*.ts"] }));
      writeFileSync(join(dir, "a.ts"), "const n: number = 'text';\nexport {};\n");
      // Use this repo's tsc for the scratch project.
      const { symlinkSync, mkdirSync } = await import("node:fs");
      mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
      if (process.platform === "win32") {
        // A tsc.cmd shim, as npm installs on Windows, pointing at this repo's TypeScript.
        writeFileSync(join(dir, "node_modules", ".bin", "tsc.cmd"), `@node "${join(process.cwd(), "node_modules", "typescript", "bin", "tsc")}" %*\r\n`);
      } else {
        symlinkSync(join(process.cwd(), "node_modules", ".bin", "tsc"), join(dir, "node_modules", ".bin", "tsc"));
      }
      const r = await checkProject(dir, ["a.ts"], { trusted: true });
      expect(r.checkers).toEqual(["tsc"]);
      expect(r.byPath["a.ts"]?.[0]).toMatchObject({ line: 1, severity: "error", source: "tsc" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe.skipIf(process.platform === "win32")("checkProject in an untrusted folder", () => {
  it("does not run the project's own tsc or cargo build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "untrusted-"));
    const marker = join(dir, "MARKER");
    try {
      const { mkdirSync, chmodSync } = await import("node:fs");
      writeFileSync(join(dir, "tsconfig.json"), "{}");
      writeFileSync(join(dir, "a.ts"), "export {};\n");
      mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
      const fake = join(dir, "node_modules", ".bin", "tsc");
      writeFileSync(fake, `#!/bin/sh\ntouch "${marker}"\n`);
      chmodSync(fake, 0o755);
      writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "x"\nversion = "0.0.0"\nedition = "2021"\n');
      writeFileSync(join(dir, "build.rs"), `fn main() { std::fs::write(${JSON.stringify(marker)}, "").unwrap(); }\n`);
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "main.rs"), "fn main() {}\n");

      const r = await checkProject(dir, ["a.ts", "src/main.rs"]);
      expect(existsSync(marker)).toBe(false);
      expect(r.checkers).toEqual([]);
      expect(r.untrusted).toEqual(["tsc", "cargo"]);
      expect(r.byPath).toEqual({});

      // Explicitly trusted: the project's tsc runs (the user's decision).
      await checkProject(dir, ["a.ts"], { trusted: true });
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("python checks don't import modules from the project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "untrusted-py-"));
    const marker = join(dir, "MARKER");
    try {
      writeFileSync(join(dir, "py_compile.py"), `open(${JSON.stringify(marker)}, "w").close()\n`);
      writeFileSync(join(dir, "a.py"), "x = 1\n");
      await checkProject(dir, ["a.py"]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("workspace trust", () => {
  it("defaults to untrusted, is stored outside the project, and is per folder", () => {
    const home = mkdtempSync(join(tmpdir(), "trust-home-"));
    const proj = mkdtempSync(join(tmpdir(), "trust-proj-"));
    const prev = process.env.EDGECODER_TRUST_FILE;
    process.env.EDGECODER_TRUST_FILE = join(home, "trusted-projects.json");
    try {
      expect(isProjectTrusted(proj)).toBe(false);
      setProjectTrusted(proj, true);
      expect(isProjectTrusted(proj)).toBe(true);
      expect(isProjectTrusted(join(proj, "sub"))).toBe(false);
      expect(isProjectTrusted(join(proj, ".."))).toBe(false);
      setProjectTrusted(proj, false);
      expect(isProjectTrusted(proj)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.EDGECODER_TRUST_FILE;
      else process.env.EDGECODER_TRUST_FILE = prev;
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });
});
