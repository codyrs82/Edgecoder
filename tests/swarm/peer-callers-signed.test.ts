import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * Every coordinator-to-coordinator caller signs its requests with the coordinator key
 * (src/swarm/coordinator/peer-auth.ts; the token, while set, travels with the signature). Live
 * checks: tests/swarm/signed-peer-auth.test.ts (bootstrap registration, price quotes, world
 * views), tests/swarm/cross-coordinator-grants.test.ts (gossip, forwarded results),
 * tests/mesh/gossip.test.ts and tests/receipts/replication.test.ts. The stats-ledger sync needs
 * Postgres to run, so it is held to the same rule here.
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const src = (p: string) => readFileSync(`${root}${p}`, "utf8");

const CALLERS: Array<[file: string, signs: RegExp]> = [
  ["src/swarm/coordinator/peers.ts", /peerRequestHeaders\("POST", registerUrl, registerBody\)/],
  ["src/swarm/coordinator/results.ts", /peerRequestHeaders\("POST", `\$\{origin\.coordinatorUrl\}\/result`, forwardJson\)/],
  ["src/swarm/coordinator/routes/pricing.ts", /peerRequestHeaders\("GET", url\.toString\(\)\)/],
  ["src/swarm/coordinator/routes/network-world.ts", /peerRequestHeaders\("GET", url\)/],
  ["src/swarm/coordinator/stats-ledger.ts", /peerRequestHeaders\("GET", headUrl\)[\s\S]*peerRequestHeaders\("GET", rangeUrl\)/],
  ["src/swarm/coordinator.ts", /mesh\.setRequestSigner\([\s\S]*signRequest: \(method, url\) => peerSignatureHeaders\(method, url\)|signRequest: \(method, url\) => peerSignatureHeaders\(method, url\)[\s\S]*mesh\.setRequestSigner\(/]
];

describe("outbound peer callers sign their requests", () => {
  it.each(CALLERS)("%s", (file, signs) => {
    expect(src(file)).toMatch(signs);
  });

  it("gossip and receipt replication sign each request when given a signer", () => {
    expect(src("src/mesh/gossip.ts")).toMatch(/this\.requestSigner\("POST", url, body\)/);
    expect(src("src/receipts/replication.ts")).toMatch(/opts\.signRequest\("GET", url\)/);
  });
});
