// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * The release check of deploy/install.sh (its embedded verify-release.js), ported line for line so
 * `edgecoder-install update` accepts exactly the releases the installer accepts:
 *   1. SHA256SUMS carries a valid minisign Ed25519 signature (prehashed, "ED") by the pinned key;
 *   2. the trusted comment is signed too, and names this exact tag ("tag:agent-v1.2.3"), so a
 *      validly signed older release cannot be passed off under a newer tag;
 *   3. the tarball's SHA-256 is the one SHA256SUMS lists for its file name.
 * tests/install/release-verify.test.ts runs this and the installer's verifier on the same good and
 * tampered fixtures and expects the same verdicts.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";

export interface VerifyResult {
  ok: boolean;
  /** "verified <file>: signed by release key, <comment>" or why it failed. */
  message: string;
}

const fail = (m: string): VerifyResult => ({ ok: false, message: `verify: ${m}; not installing it` });

/** SHA-256 of a file, streamed (release tarballs are hundreds of MB). */
export function sha256File(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0; ) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Check `file` against SHA256SUMS (`sums`) and its minisign signature (`sigText`) for `tag`, with
 * `pubkey` (base64 minisign public key). Pure apart from reading `file`.
 */
export function verifyRelease(pubkey: string, sums: Buffer, sigText: string, file: string, tag: string): VerifyResult {
  const pk = Buffer.from(pubkey || "", "base64");
  if (pk.length !== 42 || pk.toString("latin1", 0, 2) !== "Ed") return fail("no valid release public key is pinned in this installer");
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pk.subarray(10)]), format: "der", type: "spki" });
  const lines = sigText.split("\n").map((l) => l.replace(/\r$/, ""));
  if (lines.length < 4 || !lines[2].startsWith("trusted comment: ")) return fail("malformed signature file");
  const sig = Buffer.from(lines[1], "base64");
  if (sig.length !== 74 || sig.toString("latin1", 0, 2) !== "ED") return fail("unsupported signature algorithm");
  if (!sig.subarray(2, 10).equals(pk.subarray(2, 10))) return fail("SHA256SUMS is signed by a different key");
  if (!verify(null, createHash("blake2b512").update(sums).digest(), key, sig.subarray(10))) return fail("BAD SIGNATURE on SHA256SUMS");
  const comment = lines[2].slice("trusted comment: ".length);
  if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(comment, "utf8")]), key, Buffer.from(lines[3], "base64"))) return fail("BAD SIGNATURE on the trusted comment");
  if (!comment.split(/\s+/).includes("tag:" + tag)) return fail("the signature is for '" + comment + "', not " + tag);
  const name = basename(file);
  const entry = sums.toString("utf8").split("\n").map((l) => /^([0-9a-f]{64}) [ *](.+?)\r?$/.exec(l)).find((m) => m && m[2] === name);
  if (!entry) return fail(name + " is not listed in the signed SHA256SUMS");
  const got = sha256File(file);
  if (got !== entry[1]) return fail("CHECKSUM MISMATCH for " + name + " (signed " + entry[1] + ", downloaded " + got + ")");
  return { ok: true, message: "verified " + name + ": signed by release key, " + comment };
}
