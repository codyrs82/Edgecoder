import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
  it("python syntax errors (real interpreter output)", () => {
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
      const r = await checkProject(dir, ["a.ts"]);
      expect(r.checkers).toEqual(["tsc"]);
      expect(r.byPath["a.ts"]?.[0]).toMatchObject({ line: 1, severity: "error", source: "tsc" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
