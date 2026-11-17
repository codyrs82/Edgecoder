import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { portalActionHeaders } from "../../src/portal/portal-action-signer.js";
import { createInternalAuth } from "../../src/portal/internal-auth.js";
import { parseSigningKey, parseVerifyKeys, publicKeyBase64, verifyPortalAction } from "../../src/security/portal-action.js";

describe("portal side: action assertions and rotation", () => {
  test("with PORTAL_ACTION_SIGNING_KEY each request gets a fresh assertion the coordinators verify", async () => {
    const pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const env = { PORTAL_ACTION_SIGNING_KEY: pem };
    const keys = parseVerifyKeys(publicKeyBase64(parseSigningKey(pem)));
    const a = portalActionHeaders("acct-u1", "payout.withdraw", { bolt11: "lntbs1abc" }, env);
    const b = portalActionHeaders("acct-u1", "payout.withdraw", { bolt11: "lntbs1abc" }, env);
    expect(a["x-portal-action"]).toBeTruthy();
    expect(a["x-portal-action"]).not.toBe(b["x-portal-action"]);
    const seen = new Set<string>();
    const r = await verifyPortalAction(a["x-portal-action"], { accountId: "acct-u1", action: "payout.withdraw", body: { bolt11: "lntbs1abc" } }, { keys, nonceOnce: async (n) => !seen.has(n) && Boolean(seen.add(n)) });
    expect(r.ok).toBe(true);
  });

  test("without the key no header is added (coordinators accept that only during the transition)", () => {
    expect(portalActionHeaders("acct-u1", "payout.withdraw", { bolt11: "x" }, {})).toEqual({});
  });

  test("/internal/*: the previous service and admin tokens work only inside TOKEN_PREVIOUS_UNTIL", () => {
    const reply = () => {
      const r: any = {};
      r.code = (n: number) => ((r.status = n), { send: () => undefined });
      return r;
    };
    const mk = (until: string) =>
      createInternalAuth({ serviceToken: "svc-new", serviceTokenPrevious: "svc-old", adminToken: "adm-new", adminTokenPrevious: "adm-old", previousUntil: until, allowOpenWhenUnset: false });
    const open = mk(new Date(Date.now() + 3_600_000).toISOString());
    expect(open.requireInternalToken({ headers: { "x-portal-service-token": "svc-old" } }, reply())).toBe(true);
    expect(open.requireInternalToken({ headers: { "x-portal-service-token": "svc-new" } }, reply())).toBe(true);
    expect(open.requireControlPlaneAdmin({ headers: { "x-admin-token": "adm-old" } }, reply())).toBe(true);
    const closed = mk(new Date(Date.now() - 1_000).toISOString());
    expect(closed.requireInternalToken({ headers: { "x-portal-service-token": "svc-old" } }, reply())).toBe(false);
    expect(closed.requireControlPlaneAdmin({ headers: { "x-admin-token": "adm-old" } }, reply())).toBe(false);
    expect(closed.requireControlPlaneAdmin({ headers: { "x-admin-token": "adm-new" } }, reply())).toBe(true);
  });
});
