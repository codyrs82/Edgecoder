import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { verifyNostrEvent, type NostrEvent, type WsLike } from "../../../src/discovery/nostr.js";
import {
  buildNwcRequest, buildNwcResponse, decodeNwcRequest, describeNwcConnection, NwcClient, NwcError, parseNwcResponse, parseNwcUri, NWC_INFO_KIND, signEvent,
} from "../../../src/economy/direct/nwc.js";

const walletSecret = new Uint8Array(32).fill(9);
const walletPub = Buffer.from(schnorr.getPublicKey(walletSecret)).toString("hex");
const clientSecretHex = "11".repeat(32);
const uri = `nostr+walletconnect://${walletPub}?relay=wss%3A%2F%2Frelay.test&secret=${clientSecretHex}&lud16=buyer%40example.com`;

describe("NWC connection strings", () => {
  it("parses wallet pubkey, relay, secret and lud16", () => {
    const c = parseNwcUri(uri);
    expect(c.walletPubkey).toBe(walletPub);
    expect(c.relays).toEqual(["wss://relay.test"]);
    expect(c.clientPubkey).toBe(Buffer.from(schnorr.getPublicKey(Buffer.from(clientSecretHex, "hex"))).toString("hex"));
    expect(c.lud16).toBe("buyer@example.com");
  });

  it("never exposes the secret in its description", () => {
    expect(JSON.stringify(describeNwcConnection(parseNwcUri(uri)))).not.toContain(clientSecretHex);
  });

  it("rejects malformed strings", () => {
    expect(() => parseNwcUri("nostr+walletconnect://abc?relay=wss://x&secret=00")).toThrow();
    expect(() => parseNwcUri(`nostr+walletconnect://${walletPub}?secret=${clientSecretHex}`)).toThrow(/relay/);
  });
});

describe("NIP-47 request and response", () => {
  for (const encryption of ["nip44_v2", "nip04"] as const) {
    it(`round-trips pay_invoice (${encryption})`, () => {
      const conn = parseNwcUri(uri);
      const req = buildNwcRequest(conn, { method: "pay_invoice", params: { invoice: "lntbs1..." } }, { encryption, createdAtSec: 1_700_000_000 });
      expect(verifyNostrEvent(req)).toBe(true);
      expect(req.kind).toBe(23194);
      expect(req.tags).toContainEqual(["p", walletPub]);
      expect(req.tags.some((t) => t[0] === "encryption")).toBe(encryption === "nip44_v2");
      expect(req.content).not.toContain("pay_invoice");
      const decoded = decodeNwcRequest(req, walletSecret);
      expect(decoded.body).toEqual({ method: "pay_invoice", params: { invoice: "lntbs1..." } });
      const resp = buildNwcResponse(walletSecret, req, { result_type: "pay_invoice", result: { preimage: "ab".repeat(32) } }, decoded.encryption);
      expect(parseNwcResponse(resp, conn, req.id).result).toEqual({ preimage: "ab".repeat(32) });
    });
  }

  it("refuses a reply signed by someone other than the wallet", () => {
    const conn = parseNwcUri(uri);
    const req = buildNwcRequest(conn, { method: "get_info", params: {} });
    const imposter = new Uint8Array(32).fill(5);
    const resp = buildNwcResponse(imposter, req, { result_type: "get_info", result: {} }, "nip44_v2");
    expect(() => parseNwcResponse(resp, conn, req.id)).toThrow(/not_from_wallet/);
  });

  it("refuses a request not addressed to this wallet", () => {
    const conn = parseNwcUri(uri);
    const req = buildNwcRequest(conn, { method: "get_info", params: {} });
    expect(() => decodeNwcRequest(req, new Uint8Array(32).fill(4))).toThrow(/not_for_this_wallet/);
  });
});

/** An in-memory relay with a wallet service attached. */
function fakeRelay(handle: (method: string, params: Record<string, unknown>) => { result?: Record<string, unknown>; error?: { code: string; message: string } } | null) {
  const subs: Array<{ ws: FakeWs; id: string; filter: Record<string, unknown> }> = [];
  const info = signEvent({ pubkey: walletPub, created_at: 1, kind: NWC_INFO_KIND, tags: [["encryption", "nip44_v2 nip04"]], content: "pay_invoice get_balance lookup_invoice" }, walletSecret);
  class FakeWs implements WsLike {
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    constructor() {
      setTimeout(() => this.onopen?.({}), 0);
    }
    send(data: string) {
      const msg = JSON.parse(data);
      if (msg[0] === "REQ") {
        subs.push({ ws: this, id: msg[1], filter: msg[2] });
        if ((msg[2].kinds as number[]).includes(NWC_INFO_KIND)) {
          this.onmessage?.({ data: JSON.stringify(["EVENT", msg[1], info]) });
          this.onmessage?.({ data: JSON.stringify(["EOSE", msg[1]]) });
        }
      } else if (msg[0] === "EVENT") {
        const ev = msg[1] as NostrEvent;
        const { body, encryption, request } = decodeNwcRequest(ev, walletSecret);
        const out = handle(body.method, body.params);
        if (!out) return; // never answer: timeout
        const resp = buildNwcResponse(walletSecret, request, { result_type: body.method, ...out }, encryption);
        for (const s of subs) if ((s.filter["#e"] as string[] | undefined)?.includes(ev.id)) s.ws.onmessage?.({ data: JSON.stringify(["EVENT", s.id, resp]) });
      }
    }
    close() {}
  }
  return () => new FakeWs();
}

describe("NwcClient over a relay", () => {
  it("negotiates NIP-44 from the info event and returns the preimage", async () => {
    const seen: string[] = [];
    const client = new NwcClient(parseNwcUri(uri), {
      connect: fakeRelay((m, p) => {
        seen.push(`${m}:${p.invoice}`);
        return { result: { preimage: "cd".repeat(32), fees_paid: 1000 } };
      }),
    });
    expect(await client.negotiate()).toBe("nip44_v2");
    expect(await client.payInvoice("lntbs1abc")).toEqual({ preimage: "cd".repeat(32), feesPaidMsat: 1000 });
    expect(seen).toEqual(["pay_invoice:lntbs1abc"]);
  });

  it("surfaces wallet error codes (budget exhausted)", async () => {
    const client = new NwcClient(parseNwcUri(uri), { connect: fakeRelay(() => ({ error: { code: "QUOTA_EXCEEDED", message: "daily budget" } })) });
    await expect(client.payInvoice("lntbs1abc")).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("times out when the wallet never answers", async () => {
    const client = new NwcClient(parseNwcUri(uri), { connect: fakeRelay(() => null), encryption: "nip04" });
    const err = await client.payInvoice("lntbs1abc", 200).catch((e) => e);
    expect(err).toBeInstanceOf(NwcError);
    expect(err.code).toBe("TIMEOUT");
  });
});
