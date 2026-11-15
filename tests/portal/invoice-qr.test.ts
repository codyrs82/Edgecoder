import { describe, expect, it } from "vitest";
import qrcode from "qrcode-generator";
import { invoiceQrSvg, lightningQrPayload, qrPath, withInvoiceQr } from "../../src/portal/invoice-qr.js";

// A regtest BOLT11 shape (hrp, separator, bech32 data); the QR code never looks inside it.
const BOLT11 = "lnbcrt200u1pnz8kq0pp5qy7d3xw6r0mnt9vxk2c8a0l4ghs3e5u7wqzq3jf2ky6v8s0n9pxsdqqcqzzsxqyz5vqsp5h7e2d9k6c0w3m8xr5qv4n2t7l9s6f3a7g8j0p5q2z4y7x6c3";

describe("invoice QR codes", () => {
  it("encodes LIGHTNING:<BOLT11> in upper case, for alphanumeric mode", () => {
    expect(lightningQrPayload(BOLT11)).toBe(`LIGHTNING:${BOLT11.toUpperCase()}`);
    expect(lightningQrPayload(`  lightning:${BOLT11}  `)).toBe(`LIGHTNING:${BOLT11.toUpperCase()}`);
  });

  it("refuses anything that is not a BOLT11 invoice", () => {
    for (const bad of ["", "hello", "lnbc1short", `${BOLT11}<script>`, `${BOLT11}"`, "bitcoin:bc1qxyz", `ln${"x".repeat(50)}`]) {
      expect(lightningQrPayload(bad), bad).toBeNull();
      expect(invoiceQrSvg(bad), bad).toBeNull();
    }
  });

  it("draws exactly the library's module matrix", () => {
    const payload = lightningQrPayload(BOLT11)!;
    const { size, d } = qrPath(payload);
    const ref = qrcode(0, "M");
    ref.addData(payload, "Alphanumeric");
    ref.make();
    expect(size).toBe(ref.getModuleCount());
    // Rebuild the grid from the path's row runs and compare it cell by cell.
    const dark = new Set<string>();
    for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) for (let i = 0; i < Number(m[3]); i++) dark.add(`${Number(m[1]) + i},${m[2]}`);
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) expect(dark.has(`${c},${r}`), `${r},${c}`).toBe(ref.isDark(r, c));
  });

  it("is plain SVG with nothing from the invoice in it", () => {
    const svg = invoiceQrSvg(BOLT11)!;
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).not.toMatch(/style=|<script|<foreignObject|href=|on\w+=/i);
    expect(svg.toLowerCase()).not.toContain(BOLT11.slice(10, 30).toLowerCase());
    // Only these elements and the path's numeric drawing commands.
    expect(svg.replace(/d="[^"]*"/, "").match(/<(\w+)/g)).toEqual(["<svg", "<rect", "<path"]);
    expect(svg.match(/ d="([^"]*)"/)![1]).toMatch(/^[Mhvz0-9 -]+$/);
  });

  it("adds qrSvg only to a successful invoice answer", () => {
    const ok = withInvoiceQr(200, { intentId: "pi-1", invoice: BOLT11, cSats: 20000 }) as Record<string, unknown>;
    expect(ok).toMatchObject({ intentId: "pi-1", invoice: BOLT11, cSats: 20000 });
    expect(String(ok.qrSvg)).toMatch(/^<svg/);
    expect(withInvoiceQr(503, { error: "payments_disabled" })).toEqual({ error: "payments_disabled" });
    expect(withInvoiceQr(200, { invoice: "not-an-invoice" })).toEqual({ invoice: "not-an-invoice" });
  });
});
