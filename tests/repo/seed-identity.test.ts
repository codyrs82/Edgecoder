import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// A coordinator's peerId is derived from COORDINATOR_PUBLIC_URL (loadCoordinatorKeys in
// src/swarm/coordinator.ts), and desktop agents pin each seed as `peerId:keyFingerprint` in strict
// mode (EDGECODER_SEED_KEYS in desktop/src-tauri/src/network_enrollment.rs). Deploying a seed with a
// different public URL renames it, and every desktop agent then refuses it (2026-11-03 outage).
const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n");

function publicUrl(toml: string): string {
  const m = /^\s*COORDINATOR_PUBLIC_URL\s*=\s*"([^"]+)"/m.exec(toml);
  if (!m) throw new Error("COORDINATOR_PUBLIC_URL not set");
  return m[1];
}

const peerIdFor = (url: string) => `coord-${createHash("sha256").update(url).digest("hex").slice(0, 12)}`;

describe("seed identities match the keys the desktop app pins", () => {
  const pinned = [...read("desktop/src-tauri/src/network_enrollment.rs").matchAll(/"(coord-[0-9a-f]{12}):[0-9a-f]{64}"/g)].map((m) => m[1]);

  it.each(["deploy/fly/fly.seed-node.toml", "deploy/fly/fly.seed-eu.toml"])("%s keeps its pinned peerId", (file) => {
    expect(pinned.length).toBeGreaterThan(0);
    expect(pinned).toContain(peerIdFor(publicUrl(read(file))));
  });
});
