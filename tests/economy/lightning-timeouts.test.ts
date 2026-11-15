// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClnRestProvider, LIGHTNING_RPC_TIMEOUT_MS, LndRestProvider } from "../../src/economy/lightning.js";

// A node that accepts the request and never answers: what an unsynced or stuck LND looked like
// on regtest (the coordinator held /account/buy open until the portal's 70 s limit).
let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer(() => {
    /* never respond */
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const invoice = { amountSats: 1000, memo: "t", expiresInSeconds: 900 } as const;
const within = async (p: Promise<unknown>, ms: number) => {
  const t = Date.now();
  const outcome = await p.then(() => "resolved", (e) => `rejected:${String(e?.code ?? e?.message ?? e)}`);
  return { outcome, elapsed: Date.now() - t, ms };
};

describe("Lightning calls that answer a user have a time limit", () => {
  it("the default limit is 15 s", () => {
    expect(LIGHTNING_RPC_TIMEOUT_MS).toBe(15_000);
  });

  it("LND: creating an invoice fails instead of hanging", async () => {
    const r = await within(new LndRestProvider(base, "macaroon", undefined, 300).createInvoice(invoice), 300);
    expect(r.outcome).toMatch(/^rejected:/);
    expect(r.elapsed).toBeLessThan(5_000);
  });

  it("LND: an invoice lookup fails instead of hanging", async () => {
    const r = await within(new LndRestProvider(base, "macaroon", undefined, 300).checkSettlement("lnbcrt1", "ab".repeat(32)), 300);
    expect(r.outcome).toMatch(/^rejected:/);
    expect(r.elapsed).toBeLessThan(5_000);
  });

  it("Core Lightning: creating an invoice and looking one up fail instead of hanging", async () => {
    const cln = new ClnRestProvider(base, "token", 300);
    for (const p of [cln.createInvoice(invoice), cln.checkSettlement("lnbcrt1", "ab".repeat(32))]) {
      const r = await within(p, 300);
      expect(r.outcome).toMatch(/^rejected:/);
      expect(r.elapsed).toBeLessThan(5_000);
    }
  });
});
