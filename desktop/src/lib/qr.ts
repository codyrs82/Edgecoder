// QR codes for Lightning invoices (docs/design/wallet-and-market.md), drawn in the app with
// qrcode-generator. The payload is `LIGHTNING:<BOLT11>` in upper case: BOLT11 is case insensitive and
// upper case fits QR alphanumeric mode, a denser code that wallets expect. Same encoding as the
// portal's src/portal/invoice-qr.ts.
import qrcode from "qrcode-generator";

/** Scanners need dark modules on a light ground in either theme, so these are not theme tokens. */
export const QR_LIGHT = "#ffffff";
export const QR_DARK = "#000000";
/** Quiet zone around the code, in modules (the QR spec asks for 4). */
export const QR_QUIET = 4;

const BOLT11 = /^ln[a-z0-9]{1,40}1[02-9ac-hj-np-z]{20,4000}$/i;

/** `LIGHTNING:LNBC...` for a BOLT11 invoice; null for anything else. */
export function lightningQrPayload(bolt11: string): string | null {
  const inv = bolt11.trim().replace(/^lightning:/i, "");
  return BOLT11.test(inv) ? `LIGHTNING:${inv.toUpperCase()}` : null;
}

/** The module matrix as one SVG path (runs of dark modules per row), and its side in modules. */
export function qrPath(payload: string): { size: number; d: string } {
  const qr = qrcode(0, "M");
  qr.addData(payload, /^[0-9A-Z $%*+\-./:]*$/.test(payload) ? "Alphanumeric" : "Byte");
  qr.make();
  const size = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!qr.isDark(r, c)) continue;
      let run = 1;
      while (c + run < size && qr.isDark(r, c + run)) run++;
      d += `M${c} ${r}h${run}v1h-${run}z`;
      c += run - 1;
    }
  }
  return { size, d };
}

/** Everything the invoice QR needs to draw; null when the string is not a BOLT11 invoice. */
export function invoiceQr(bolt11: string): { size: number; d: string } | null {
  const payload = lightningQrPayload(bolt11);
  return payload ? qrPath(payload) : null;
}

/** `BITCOIN:BC1...` for a bech32 deposit address (upper case for alphanumeric mode); null otherwise. Same as the portal's. */
export function bitcoinQrPayload(address: string): string | null {
  const a = address.trim().replace(/^bitcoin:/i, "");
  return /^(bc|tb|bcrt)1[02-9ac-hj-np-z]{8,87}$/i.test(a) ? `BITCOIN:${a.toUpperCase()}` : null;
}

/** The QR for a Bitcoin deposit address; null when the string is not a bech32 address. */
export function addressQr(address: string): { size: number; d: string } | null {
  const payload = bitcoinQrPayload(address);
  return payload ? qrPath(payload) : null;
}
