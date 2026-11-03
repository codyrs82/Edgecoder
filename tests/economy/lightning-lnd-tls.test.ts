import { describe, expect, it } from "vitest";
import { Agent } from "undici";
import { lndDispatcher } from "../../src/economy/lightning.js";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

describe("lndDispatcher (LND tls.cert pinning)", () => {
  it("uses the system CA store when no cert is configured", () => {
    expect(lndDispatcher(undefined)).toBeUndefined();
    expect(lndDispatcher("  ")).toBeUndefined();
  });
  it("pins a base64 PEM cert", () => {
    expect(lndDispatcher(Buffer.from(PEM).toString("base64"))).toBeInstanceOf(Agent);
  });
  it("rejects a value that is not a PEM certificate", () => {
    expect(() => lndDispatcher(Buffer.from("not a cert").toString("base64"))).toThrow("lnd_tls_cert_invalid");
  });
});
