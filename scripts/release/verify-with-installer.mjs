#!/usr/bin/env node
// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1
//
// Check a release directory exactly as the installers will: run the verify-release.js embedded
// in deploy/install.sh, with the public key pinned there, against every tarball listed in
// SHA256SUMS. The release workflow runs this before publishing, so a release signed by a key
// the installers do not pin (or a placeholder key) is never published.
//
//   node scripts/release/verify-with-installer.mjs <release-dir> <tag>
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The verify-release.js text embedded in an installer. */
export function extractVerifier(installerText) {
  const m = /\/\/ ---- BEGIN verify-release\.js ----\r?\n[\s\S]*?\/\/ ---- END verify-release\.js ----/.exec(installerText);
  if (!m) throw new Error("no verify-release.js block found");
  return m[0].replace(/\r\n/g, "\n");
}

/** The release public key pinned in deploy/install.sh. */
export function pinnedPublicKey(installSh) {
  const m = /^RELEASE_PUBKEY="([^"]*)" # release-pubkey$/m.exec(installSh);
  if (!m) throw new Error("no RELEASE_PUBKEY line in deploy/install.sh");
  return m[1];
}

function main([dir, tag]) {
  if (!dir || !tag) throw new Error("usage: verify-with-installer.mjs <release-dir> <tag>");
  const sh = readFileSync(join(root, "deploy", "install.sh"), "utf8");
  const pub = pinnedPublicKey(sh);
  const work = mkdtempSync(join(tmpdir(), "verify-"));
  try {
    const js = join(work, "verify-release.js");
    writeFileSync(js, extractVerifier(sh));
    const names = readFileSync(join(dir, "SHA256SUMS"), "utf8").split("\n").map((l) => l.split(/ [ *]/)[1]).filter(Boolean);
    if (names.length === 0) throw new Error("SHA256SUMS lists no files");
    for (const name of names) {
      execFileSync(process.execPath, [js, pub, join(dir, "SHA256SUMS"), join(dir, "SHA256SUMS.minisig"), join(dir, name), tag], { stdio: "inherit" });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
