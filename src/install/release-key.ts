// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The minisign (Ed25519) public key that signs agent releases: the same key as RELEASE_PUBKEY in
 * deploy/install.sh and $ReleasePubKey in deploy/install.ps1 (tests/install/release-verify.test.ts
 * checks they agree; scripts/set-release-signing-key.sh rewrites all of them). `edgecoder-install
 * update` checks every release against this constant only: it is never fetched, and there is no
 * environment or flag override, so whoever can publish a GitHub release cannot also choose the key.
 */
export const RELEASE_PUBKEY = "RWSpn4RH5/e5O8Qd9rasofZ9OVjMNPlvimRunFeWb0LEMylKCiS9kwgI"; // release-pubkey
