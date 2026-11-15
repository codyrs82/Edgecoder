import { describe, expect, it } from "vitest";
import qrcode from "qrcode-generator";
import { invoiceQr, lightningQrPayload } from "../src/lib/qr";

const BOLT11 = "lnbcrt200u1pnz8kq0pp5qy7d3xw6r0mnt9vxk2c8a0l4ghs3e5u7wqzq3jf2ky6v8s0n9pxsdqqcqzzsxqyz5vqsp5h7e2d9k6c0w3m8xr5qv4n2t7l9s6f3a7g8j0p5q2z4y7x6c3";

describe("invoice QR (desktop)", () => {
  it("encodes LIGHTNING:<BOLT11> upper-cased, and refuses non-invoices", () => {
    expect(lightningQrPayload(BOLT11)).toBe(`LIGHTNING:${BOLT11.toUpperCase()}`);
    for (const bad of ["", "hello", `${BOLT11}<b>`, "bitcoin:bc1qxyz"]) expect(invoiceQr(bad), bad).toBeNull();
  });
  it("draws the library's module matrix in alphanumeric mode", () => {
    const q = invoiceQr(BOLT11)!;
    const ref = qrcode(0, "M");
    ref.addData(`LIGHTNING:${BOLT11.toUpperCase()}`, "Alphanumeric");
    ref.make();
    expect(q.size).toBe(ref.getModuleCount());
    const dark = new Set<string>();
    for (const m of q.d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) for (let i = 0; i < Number(m[3]); i++) dark.add(`${Number(m[1]) + i},${m[2]}`);
    for (let r = 0; r < q.size; r++) for (let c = 0; c < q.size; c++) expect(dark.has(`${c},${r}`)).toBe(ref.isDark(r, c));
  });
});
