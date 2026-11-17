import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs release tooling, no type declarations
import { keygen, signMinisign } from "../../scripts/release/minisign.mjs";
// @ts-expect-error plain .mjs release tooling, no type declarations
import { extractVerifier, pinnedPublicKey } from "../../scripts/release/verify-with-installer.mjs";
import { RELEASE_PUBKEY } from "../../src/install/release-key.js";
import { verifyRelease } from "../../src/install/release-verify.js";

/*
 * edgecoder-install update must accept exactly what deploy/install.sh accepts: the TypeScript port
 * and the installer's embedded verify-release.js get the same fixtures and must give the same
 * verdict, and the key the updater pins must be the installer's key.
 */
const root = resolve(__dirname, "../..");
const installSh = readFileSync(join(root, "deploy/install.sh"), "utf8");
const TAG = "agent-v9.9.9";
const ASSET = `edgecoder-agent-${TAG}-linux-x64.tar.gz`;

let work: string;
let key: { publicKey: string; secretKeyPem: string };
let other: { publicKey: string; secretKeyPem: string };
let shVerifier: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "ec-release-verify-"));
  key = keygen();
  other = keygen();
  shVerifier = join(work, "verify-release.js");
  writeFileSync(shVerifier, extractVerifier(installSh));
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

function fixture(name: string, opts: { signer?: typeof key; tamper?: "tarball" | "sums" | "comment"; noSig?: boolean; tag?: string } = {}) {
  const dir = mkdtempSync(join(work, `${name}-`));
  const tarball = join(dir, ASSET);
  writeFileSync(tarball, Buffer.from(`release bytes ${name}`));
  const sums = `${createHash("sha256").update(readFileSync(tarball)).digest("hex")}  ${ASSET}\n`;
  let sig = signMinisign(Buffer.from(sums), (opts.signer ?? key).secretKeyPem, `tag:${opts.tag ?? TAG} file:SHA256SUMS commit:abc`);
  writeFileSync(join(dir, "SHA256SUMS"), opts.tamper === "sums" ? sums.replace(/^./, (c) => (c === "0" ? "1" : "0")) : sums);
  if (opts.tamper === "tarball") writeFileSync(tarball, Buffer.from(`tampered ${name}`));
  if (opts.tamper === "comment") sig = sig.replace(`tag:${TAG}`, "tag:agent-v99.0.0");
  writeFileSync(join(dir, "SHA256SUMS.minisig"), opts.noSig ? "" : sig);
  return { dir, tarball, sums: readFileSync(join(dir, "SHA256SUMS")), sig: readFileSync(join(dir, "SHA256SUMS.minisig"), "utf8") };
}

function both(f: ReturnType<typeof fixture>, pub = key.publicKey, tag = TAG) {
  const ts = verifyRelease(pub, f.sums, f.sig, f.tarball, tag);
  const sh = spawnSync(process.execPath, [shVerifier, pub, join(f.dir, "SHA256SUMS"), join(f.dir, "SHA256SUMS.minisig"), f.tarball, tag], { encoding: "utf8" });
  return { ts, shOk: sh.status === 0, shOut: `${sh.stdout}${sh.stderr}` };
}

describe("release verification (TypeScript port of install.sh's verify-release.js)", () => {
  it("pins the same key as deploy/install.sh and deploy/install.ps1", () => {
    expect(RELEASE_PUBKEY).toBe(pinnedPublicKey(installSh));
    expect(readFileSync(join(root, "deploy/install.ps1"), "utf8")).toContain(`$ReleasePubKey = '${RELEASE_PUBKEY}' # release-pubkey`);
    expect(readFileSync(join(root, "src/install/release-key.ts"), "utf8")).toMatch(/^export const RELEASE_PUBKEY = "[^"]+"; \/\/ release-pubkey$/m);
  });

  it("accepts a good release, with the installer's message", () => {
    const r = both(fixture("good"));
    expect(r.ts.ok).toBe(true);
    expect(r.shOk).toBe(true);
    expect(r.ts.message).toBe(r.shOut.trim());
    expect(r.ts.message).toContain(`signed by release key, tag:${TAG}`);
  });

  const bad: Array<[string, () => ReturnType<typeof both>, RegExp]> = [
    ["a tampered tarball", () => both(fixture("tarball", { tamper: "tarball" })), /CHECKSUM MISMATCH/],
    ["a tampered SHA256SUMS", () => both(fixture("sums", { tamper: "sums" })), /BAD SIGNATURE on SHA256SUMS/],
    ["the wrong key", () => both(fixture("wrongkey", { signer: other })), /signed by a different key/],
    ["a missing signature", () => both(fixture("nosig", { noSig: true })), /malformed signature file/],
    ["a forged trusted comment", () => both(fixture("comment", { tamper: "comment" })), /BAD SIGNATURE on the trusted comment/],
    ["a signature for another tag", () => both(fixture("oldtag", { tag: "agent-v1.0.0" })), /the signature is for .*tag:agent-v1\.0\.0/],
    ["no pinned key", () => both(fixture("nokey"), ""), /no valid release public key/]
  ];
  for (const [name, run, why] of bad) {
    it(`refuses ${name}, as the installer does`, () => {
      const r = run();
      expect(r.ts.ok).toBe(false);
      expect(r.shOk).toBe(false);
      expect(r.ts.message).toMatch(why);
      expect(r.ts.message).toBe(r.shOut.trim());
    });
  }
});
