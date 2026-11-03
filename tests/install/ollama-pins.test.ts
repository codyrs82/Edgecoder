// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OLLAMA_ASSETS, OLLAMA_VERSION, ollamaAssetUrl } from "../../src/install/ollama-pins.js";
import { installPinnedOllama } from "../../src/model/ollama-installer.js";

const read = (p: string) => readFileSync(p, "utf8");

describe("Ollama pins stay in sync (src/install/ollama-pins.ts is the source of truth)", () => {
  it("the Linux package script pins the same version and Linux checksums", () => {
    const sh = read("scripts/linux/payload/bin/edgecoder-install-ollama.sh");
    expect(sh).toContain(`OLLAMA_VERSION=${OLLAMA_VERSION}\n`);
    for (const t of ["linux-x64", "linux-arm64"] as const) {
      expect(sh).toContain(`${OLLAMA_ASSETS[t].name} ${OLLAMA_ASSETS[t].sha256}`);
    }
  });

  it("the macOS package script pins the same version and macOS checksum", () => {
    const sh = read("scripts/macos/payload/bin/edgecoder-install-ollama.sh");
    expect(sh).toContain(`OLLAMA_VERSION=${OLLAMA_VERSION}\n`);
    expect(sh).toContain(`OLLAMA_ASSET="${OLLAMA_ASSETS.darwin.name}"`);
    expect(sh).toContain(`OLLAMA_SHA256="${OLLAMA_ASSETS.darwin.sha256}"`);
  });

  // deploy/install.{sh,ps1} gain their pins in PR #241; from then on they must match too.
  it("deploy/install.sh, when it pins Ollama, pins the same release", () => {
    const sh = read("deploy/install.sh");
    const m = sh.match(/^OLLAMA_VERSION=(\S+)$/m);
    if (!m) return;
    expect(m[1]).toBe(OLLAMA_VERSION);
    for (const t of ["linux-x64", "linux-arm64", "darwin"] as const) {
      expect(sh).toContain(`${OLLAMA_ASSETS[t].name} ${OLLAMA_ASSETS[t].sha256}`);
    }
  });

  it("deploy/install.ps1, when it pins Ollama, pins the same release", () => {
    const ps = read("deploy/install.ps1");
    const v = ps.match(/^\$OllamaVersion\s*=\s*'([^']+)'/m);
    if (!v) return;
    expect(v[1]).toBe(OLLAMA_VERSION);
    expect(ps).toMatch(new RegExp(`^\\$OllamaSha256\\s*=\\s*'${OLLAMA_ASSETS["win-x64"].sha256}'`, "m"));
    expect(ps).toContain(OLLAMA_ASSETS["win-x64"].name);
  });

  it("the desktop app's own Ollama pin is a separate, checksummed artifact (left as is)", () => {
    const rs = read("desktop/src-tauri/src/local_compute.rs");
    expect(rs).toMatch(/github\.com\/ollama\/ollama\/releases\/download\/v[\d.]+\/ollama-darwin\.tgz/);
    expect(rs).toMatch(/sha256/i);
  });
});

describe("nothing pipes downloaded content into a shell", () => {
  const PIPE_TO_SHELL = [
    /\|\s*(sudo\s+(-\S+\s+)*)?(ba|z|da)?sh\b(?![.\w-])/,
    /\b(ba|z)?sh\s+(-c\s+)?["']?\$\(\s*(curl|wget)\b/,
    /\b(ba|z)?sh\s+<\(\s*(curl|wget)\b/,
    /\|\s*iex\b/i,
    /\bInvoke-Expression\b/i
  ];
  // Until PR #241 lands, these still carry the old bootstrap; once they say so, they are checked too.
  const PENDING_241 = ["deploy/install.sh", "deploy/install.ps1", "docs/install.md"];
  const isPending = (f: string) => PENDING_241.includes(f) && !read("deploy/install.sh").includes("Nothing downloaded is piped into a shell");

  // Hostile-input fixtures: tests that feed \`curl … | sh\` to the app to check it is escaped or refused.
  const FIXTURES = new Set([
    "tests/ide/bot-github.test.ts",
    "tests/portal/output-escaping.test.ts",
    "tests/repo/dockerfiles.test.ts",
    "tests/trust/response-signing.test.ts"
  ]);

  it("finds no pipe-to-shell outside --from-source notes", () => {
    const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
    const offenders: string[] = [];
    for (const f of files) {
      if (f === "tests/install/ollama-pins.test.ts" || FIXTURES.has(f) || isPending(f)) continue;
      if (!/\.(sh|ps1|psm1|ts|js|mjs|cjs|md|ya?ml|rs|toml|json|html|txt|service|plist)$|(^|\/)(preinst|postinst|postinstall|preinstall|prerm|postrm|Dockerfile[^/]*)$/.test(f)) continue;
      if (!existsSync(f)) continue;
      const lines = read(f).split("\n");
      lines.forEach((line, i) => {
        if (line.includes("--from-source")) return;
        if (/\.not\.toMatch\(/.test(line)) return; // tests asserting the pattern is absent
        if (PIPE_TO_SHELL.some((re) => re.test(line))) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the TS Ollama installer has no script path left", () => {
    const src = read("src/model/ollama-installer.ts");
    expect(src).not.toContain("ollama.com/install.sh");
    expect(src).not.toContain("OllamaSetup.exe");
    expect(src).not.toMatch(/\/bin\/sh/);
  });
});

describe("installPinnedOllama", () => {
  let tmp: string | undefined;
  afterEach(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = undefined; });

  it("aborts on a checksum mismatch before unpacking or touching an existing install", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "ollama-pin-test-"));
    const destDir = path.join(tmp, "ollama");
    execFileSync("mkdir", ["-p", destDir]);
    writeFileSync(path.join(destDir, "keep"), "existing");
    const urls: string[] = [];
    let extracted = false;
    await expect(installPinnedOllama({
      platform: "linux",
      arch: "x64",
      destDir,
      download: async (url, dest) => { urls.push(url); writeFileSync(dest, "not the real archive"); },
      extract: async () => { extracted = true; }
    })).rejects.toThrow(/ollama_checksum_mismatch/);
    expect(urls).toEqual([ollamaAssetUrl(OLLAMA_ASSETS["linux-x64"])]);
    expect(urls[0]).toBe(`https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/ollama-linux-amd64.tar.zst`);
    expect(extracted).toBe(false);
    expect(read(path.join(destDir, "keep"))).toBe("existing");
  });

  it("unpacks only when the archive matches its pin", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "ollama-pin-test-"));
    const body = "pretend archive";
    const realSha = createHash("sha256").update(body).digest("hex");
    let extractedFrom = "";
    const bin = await installPinnedOllama({
      platform: "darwin", arch: "arm64", destDir: path.join(tmp, "o"),
      asset: { name: "ollama-darwin.tgz", sha256: realSha },
      download: async (_u, dest) => { writeFileSync(dest, body); },
      extract: async (archive) => { extractedFrom = read(archive); }
    });
    expect(extractedFrom).toBe(body);
    expect(bin).toBe(path.join(tmp, "o", "ollama"));
  });

  it("refuses platforms with no pinned build", async () => {
    await expect(installPinnedOllama({ platform: "win32", arch: "arm64", download: async () => {} }))
      .rejects.toThrow(/ollama_install_unsupported/);
  });
});
