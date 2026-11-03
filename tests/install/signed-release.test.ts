import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs release tooling, no type declarations
import { keygen, signMinisign, verifyMinisign } from "../../scripts/release/minisign.mjs";
// @ts-expect-error plain .mjs release tooling, no type declarations
import { extractVerifier, pinnedPublicKey } from "../../scripts/release/verify-with-installer.mjs";

/*
 * deploy/install.sh installs only a release whose SHA256SUMS is signed by the pinned key and whose
 * tarball matches it. These tests source the script (EDGECODER_INSTALL_LIB=1), point it at a
 * file:// fixture release signed by a throwaway key (via the test-only override), and run
 * install_release with this Node as the verifier.
 */
const root = resolve(__dirname, "../..");
const installSh = readFileSync(join(root, "deploy/install.sh"), "utf8");
const installPs1 = readFileSync(join(root, "deploy/install.ps1"), "utf8");
const TAG = "agent-v9.9.9";
const TARGET = "linux-x64";
const ASSET = `edgecoder-agent-${TAG}-${TARGET}.tar.gz`;
const posix = process.platform !== "win32";

let work: string;
let key: { publicKey: string; secretKeyPem: string };
let other: { publicKey: string; secretKeyPem: string };

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** A release dir under work/releases/<tag>/ built from a tiny app; `mutate` tampers with it. */
function makeRelease(name: string, opts: { signer?: typeof key; comment?: string; tamper?: "sums" | "tarball" | "comment" } = {}): string {
  const base = join(work, name);
  const dir = join(base, TAG);
  const app = join(work, `${name}-app`, "edgecoder");
  mkdirSync(join(app, "dist", "install"), { recursive: true });
  writeFileSync(join(app, "dist", "install", "cli.js"), "console.log('fixture installer');\n");
  writeFileSync(join(app, "package.json"), '{"name":"edgecoder-fixture"}\n');
  mkdirSync(dir, { recursive: true });
  const tar = spawnSync("tar", ["-czf", join(dir, ASSET), "-C", join(work, `${name}-app`), "edgecoder"]);
  expect(tar.status).toBe(0);
  const sums = `${sha256(join(dir, ASSET))}  ${ASSET}\n`;
  writeFileSync(join(dir, "SHA256SUMS"), sums);
  let sig = signMinisign(Buffer.from(sums), (opts.signer ?? key).secretKeyPem, opts.comment ?? `tag:${TAG} file:SHA256SUMS`);
  if (opts.tamper === "sums") writeFileSync(join(dir, "SHA256SUMS"), sums.replace(/^./, (c) => (c === "0" ? "1" : "0")));
  if (opts.tamper === "tarball") writeFileSync(join(dir, ASSET), Buffer.concat([readFileSync(join(dir, ASSET)), Buffer.from("x")]));
  if (opts.tamper === "comment") sig = sig.replace(`tag:${TAG}`, "tag:agent-v0.0.1");
  writeFileSync(join(dir, "SHA256SUMS.minisig"), sig);
  return base;
}

/** Source install.sh and run install_release against `base`, installing into a fresh dir. */
function install(base: string, env: Record<string, string> = {}) {
  const installDir = join(work, `installed-${Math.random().toString(36).slice(2)}`);
  const r = spawnSync(
    "bash",
    ["-c", `set -euo pipefail; source "$1"; TARGET=${TARGET}; NODE="$2"; FROM_SOURCE=0; install_release ${TAG}`, "_", join(root, "deploy/install.sh"), process.execPath],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: work,
        TMPDIR: work,
        EDGECODER_INSTALL_LIB: "1",
        EDGECODER_INSTALL_DIR: installDir,
        EDGECODER_RELEASE_BASE_URL: `file://${base}`,
        EDGECODER_INSECURE_TEST_ONLY_RELEASE_PUBKEY: key.publicKey,
        ...env
      }
    }
  );
  return { ...r, installDir, out: `${r.stdout}\n${r.stderr}` };
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "ec-signed-release-"));
  key = keygen();
  other = keygen();
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!posix)("install.sh: signed releases only", () => {
  it("a good release verifies and installs", () => {
    const r = install(makeRelease("good"));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`verified ${ASSET}`);
    expect(existsSync(join(r.installDir, "dist", "install", "cli.js"))).toBe(true);
    expect(r.out).toMatch(/INSECURE_TEST_ONLY_RELEASE_PUBKEY is set/);
  });

  it("a bad signature aborts before anything is unpacked", () => {
    const r = install(makeRelease("badsig", { tamper: "sums" }));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/BAD SIGNATURE on SHA256SUMS/);
    expect(existsSync(r.installDir)).toBe(false);
  });

  it("a release signed by another key aborts", () => {
    const r = install(makeRelease("otherkey", { signer: other }));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/signed by a different key/);
    expect(existsSync(r.installDir)).toBe(false);
  });

  it("a tarball that does not match the signed SHA256SUMS aborts", () => {
    const r = install(makeRelease("badsum", { tamper: "tarball" }));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/CHECKSUM MISMATCH/);
    expect(existsSync(r.installDir)).toBe(false);
  });

  it("a signature from another release (trusted comment names another tag) aborts", () => {
    expect(install(makeRelease("tc-edit", { tamper: "comment" })).out).toMatch(/BAD SIGNATURE on the trusted comment/);
    const r = install(makeRelease("tc-other", { comment: "tag:agent-v0.0.1 file:SHA256SUMS" }));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/not agent-v9\.9\.9/);
  });

  it("without the test override the pinned key is used (an unset key refuses every release)", () => {
    const r = install(makeRelease("nokey"), { EDGECODER_INSECURE_TEST_ONLY_RELEASE_PUBKEY: "" });
    expect(r.status).not.toBe(0);
    if (pinnedPublicKey(installSh) === "UNSET") expect(r.out).toMatch(/no valid release public key is pinned/);
    else expect(r.out).toMatch(/signed by a different key/);
  });

  it("a missing release aborts", () => {
    const r = install(join(work, "does-not-exist"));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/download failed/);
  });

  it("resolves versions to agent-v tags and picks the newest agent release, not the desktop one", () => {
    const api = join(work, "releases.json");
    writeFileSync(
      api,
      JSON.stringify([
        { tag_name: "desktop-v1.4.36", draft: false, prerelease: false },
        { tag_name: "agent-v2.0.0-rc.1", draft: false, prerelease: true },
        { tag_name: "agent-v1.3.0", draft: true, prerelease: false },
        { tag_name: "agent-v1.2.0", draft: false, prerelease: false },
        { tag_name: "agent-v1.1.0", draft: false, prerelease: false }
      ])
    );
    const r = spawnSync(
      "bash",
      ["-c", `source "$1"; NODE="$2"; normalize_tag 1.2.3; normalize_tag v1.2.3; normalize_tag agent-v1.2.3; latest_tag; (normalize_tag 'main; rm -rf /') || echo rejected`, "_", join(root, "deploy/install.sh"), process.execPath],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: work, EDGECODER_INSTALL_LIB: "1", EDGECODER_RELEASE_API_URL: `file://${api}` } }
    );
    expect(r.stdout.trim().split("\n")).toEqual(["agent-v1.2.3", "agent-v1.2.3", "agent-v1.2.3", "agent-v1.2.0", "rejected"]);
  });
});

describe("installers: pinned and verified dependencies, no piped scripts", () => {
  const code = (text: string) => text.split("\n").filter((l) => !/^\s*(#|\/\/)/.test(l)).join("\n");

  it("nothing downloaded is piped into a shell", () => {
    for (const [name, text] of [["install.sh", installSh], ["install.ps1", installPs1]] as const) {
      const c = code(text);
      expect(c, name).not.toMatch(/\|\s*(sudo\s+)?(ba|z|da)?sh\b/);
      expect(c, name).not.toMatch(/\|\s*(iex|Invoke-Expression)\b/i);
      expect(c, name).not.toMatch(/\b(ba)?sh\s+-c\s+"\$\(curl/);
      expect(c, name).not.toMatch(/Invoke-Expression|\biex\b/i);
      expect(c, name).not.toMatch(/get\.docker\.com|ollama\.com\/install|nodesource/);
      expect(c, name).not.toMatch(/winget/);
    }
  });

  it("the default path installs a signed release; git clone and npm builds are only in --from-source", () => {
    const fromSource = /install_from_source\(\) \{[\s\S]*?\n\}/.exec(installSh)![0];
    const rest = installSh.replace(fromSource, "");
    expect(code(rest)).not.toMatch(/git clone|npm ci|npm run build/);
    expect(fromSource).toMatch(/UNVERIFIED/);
    expect(fromSource).toMatch(/sudo -u "\$user" git clone/);
    const psFrom = /if \(\$FromSource\) \{[\s\S]*?\n\} else \{/.exec(installPs1)![0];
    expect(code(installPs1.replace(psFrom, ""))).not.toMatch(/git clone|npm\.cmd/);
    expect(psFrom).toMatch(/UNVERIFIED/);
    // Signature first, then unpack.
    expect(installSh.indexOf('"$NODE" "$tmp/verify-release.js"')).toBeLessThan(installSh.indexOf('tar -xzf "$tmp/$asset"'));
    expect(installPs1.indexOf('verify-release.js" $ReleasePubKey')).toBeLessThan(installPs1.indexOf('tar.exe" -xzf'));
  });

  it("both installers embed the same verifier, and it agrees with the release signer", () => {
    expect(extractVerifier(installPs1)).toBe(extractVerifier(installSh));
    const sig = signMinisign(Buffer.from("data"), keygen().secretKeyPem, "tag:x");
    expect(() => verifyMinisign(Buffer.from("data"), sig, keygen().publicKey)).toThrow(/different key/);
  });

  it("Node and Ollama are pinned to one version with SHA-256s, the same in both installers and the release workflow", () => {
    const nodeSh = /^NODE_VERSION=(\S+)$/m.exec(installSh)![1];
    expect(installPs1).toContain(`$NodeVersion   = '${nodeSh}'`);
    expect(readFileSync(join(root, ".github/workflows/agent-release.yml"), "utf8")).toContain(`NODE_VERSION: "${nodeSh}"`);
    const ollamaSh = /^OLLAMA_VERSION=(\S+)$/m.exec(installSh)![1];
    expect(installPs1).toContain(`$OllamaVersion = '${ollamaSh}'`);
    for (const t of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]) {
      expect(new RegExp(`^\\s+${t}\\)\\s+echo [0-9a-f]{64} ;;$`, "m").test(installSh), `node ${t}`).toBe(true);
    }
    expect(installSh.match(/ollama-(linux-(amd|arm)64\.tar\.zst|darwin\.tgz) [0-9a-f]{64}"/g)).toHaveLength(3);
    expect(installPs1).toMatch(/\$NodeSha256\s+= '[0-9a-f]{64}'/);
    expect(installPs1).toMatch(/\$OllamaSha256\s+= '[0-9a-f]{64}'/);
    expect(installSh).toMatch(/^NVIDIA_REPO_FINGERPRINT=[0-9A-F]{40}$/m);
  });

  it("the pinned public key is the same in install.sh, install.ps1 and docs/install.md", () => {
    const pub = pinnedPublicKey(installSh);
    expect(installPs1).toContain(`$ReleasePubKey = '${pub}' # release-pubkey`);
    const doc = readFileSync(join(root, "docs/install.md"), "utf8");
    expect(doc).toMatch(/<!-- release-pubkey -->[\s\S]*<!-- \/release-pubkey -->/);
    if (pub !== "UNSET") expect(doc).toContain(pub);
    // The test override is the only way around the pinned key, and it says so.
    expect(installSh.match(/EDGECODER_INSECURE_TEST_ONLY_RELEASE_PUBKEY/g)!.length).toBeGreaterThan(0);
    expect(installSh).not.toMatch(/RELEASE_PUBKEY="\$\{EDGECODER_/);
  });

  it("set-release-signing-key.sh pins a new key in all three places", () => {
    const script = readFileSync(join(root, "scripts/set-release-signing-key.sh"), "utf8");
    const pinJs = /<<'NODE'\n([\s\S]*?)\nNODE\n/.exec(script)![1];
    const copy = join(work, "pin-root");
    for (const rel of ["deploy/install.sh", "deploy/install.ps1", "docs/install.md"]) {
      mkdirSync(join(copy, rel, ".."), { recursive: true });
      const text = readFileSync(join(root, rel), "utf8");
      // install.ps1 is checked out with CRLF (.gitattributes) on every OS.
      writeFileSync(join(copy, rel), rel.endsWith(".ps1") ? text.replace(/\r?\n/g, "\r\n") : text);
    }
    const k = keygen();
    const r = spawnSync(process.execPath, ["-", copy, k.publicKey, k.keyId], { input: pinJs, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const sh = readFileSync(join(copy, "deploy/install.sh"), "utf8");
    expect(pinnedPublicKey(sh)).toBe(k.publicKey);
    expect(readFileSync(join(copy, "deploy/install.ps1"), "utf8")).toContain(`$ReleasePubKey = '${k.publicKey}' # release-pubkey\r\n`);
    expect(readFileSync(join(copy, "docs/install.md"), "utf8")).toContain(`untrusted comment: minisign public key ${k.keyId}\n${k.publicKey}`);
    // The script never writes the private key anywhere but the secret (and an explicit --backup).
    expect(script).toMatch(/field secretKeyPem \| gh secret set "\$SECRET"/);
    expect(script.match(/secretKeyPem/g)).toHaveLength(2);
  });
});
