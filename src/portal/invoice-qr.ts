// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * QR codes for Lightning invoices (docs/design/wallet-and-market.md), drawn server-side as SVG from
 * the BOLT11 string alone. The payload is `LIGHTNING:<BOLT11>` in upper case: BOLT11 is case
 * insensitive and upper case fits QR alphanumeric mode, a denser code that wallets expect.
 *
 * The SVG is built here from the module matrix (numbers only), never from library markup or from
 * the invoice text, so nothing in it is caller-controlled: one white rect and one black path.
 */
import qrcode from "qrcode-generator";

/** A BOLT11 invoice: hrp `ln` + network + optional amount, the `1` separator, bech32 data. */
const BOLT11 = /^ln[a-z0-9]{1,40}1[02-9ac-hj-np-z]{20,4000}$/i;

/** `LIGHTNING:LNBC...`: the URI a wallet scans, upper-cased for alphanumeric mode. */
export function lightningQrPayload(bolt11: string): string | null {
  const inv = bolt11.trim().replace(/^lightning:/i, "");
  return BOLT11.test(inv) ? `LIGHTNING:${inv.toUpperCase()}` : null;
}

/** The QR module matrix as one SVG path (each dark module a 1×1 square), plus the side length in modules. */
export function qrPath(payload: string): { size: number; d: string } {
  const qr = qrcode(0, "M");
  qr.addData(payload, /^[0-9A-Z $%*+\-./:]*$/.test(payload) ? "Alphanumeric" : "Byte");
  qr.make();
  const size = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      // Runs of dark modules on a row become one rectangle, which keeps the path short.
      if (!qr.isDark(r, c)) continue;
      let run = 1;
      while (c + run < size && qr.isDark(r, c + run)) run++;
      d += `M${c} ${r}h${run}v1h-${run}z`;
      c += run - 1;
    }
  }
  return { size, d };
}

/** Quiet zone around the code, in modules (the QR spec asks for 4). */
const QUIET = 4;

/** An SVG QR code for a BOLT11 invoice; null when the string is not one. Black on white in both themes, since scanners need it. */
export function invoiceQrSvg(bolt11: string): string | null {
  const payload = lightningQrPayload(bolt11);
  if (!payload) return null;
  const { size, d } = qrPath(payload);
  const full = size + QUIET * 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" width="${full * 4}" height="${full * 4}" shape-rendering="crispEdges">` +
    `<rect width="${full}" height="${full}" fill="#ffffff"/>` +
    `<path transform="translate(${QUIET} ${QUIET})" d="${d}" fill="#000000"/>` +
    `</svg>`
  );
}

/** A top-up answer with `qrSvg` added when it carries an invoice (optional field; everything else unchanged). */
export function withInvoiceQr(status: number, json: unknown): unknown {
  if (status !== 200 || !json || typeof json !== "object") return json;
  const invoice = (json as { invoice?: unknown }).invoice;
  const qrSvg = typeof invoice === "string" ? invoiceQrSvg(invoice) : null;
  return qrSvg ? { ...(json as object), qrSvg } : json;
}
