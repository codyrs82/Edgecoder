// Test-only BOLT11 encoder: builds syntactically valid invoices (correct bech32 checksum,
// timestamp, p/x/d tags, dummy signature) so payout tests can mint invoices for any amount,
// network and payment hash. The signature is not valid; nothing here verifies it.
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i];
  }
  return chk;
}
function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}
function bytesToWords(bytes: Buffer): number[] {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}
function intToWords(n: number, count: number): number[] {
  const out: number[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(Math.floor(n / 32 ** i) % 32);
  return out;
}
function minWords(n: number): number[] {
  const out: number[] = [];
  do {
    out.unshift(n % 32);
    n = Math.floor(n / 32);
  } while (n > 0);
  return out;
}
function tag(type: number, data: number[]): number[] {
  return [type, Math.floor(data.length / 32), data.length % 32, ...data];
}

export interface EncodeOpts {
  network?: "bc" | "tb" | "tbs" | "bcrt";
  /** Omit for an amountless invoice. */
  amountMsat?: number;
  paymentHashHex: string;
  timestamp?: number;
  expirySeconds?: number;
  description?: string;
}

/** Amount suffix: pick the largest multiplier that represents amountMsat exactly. */
function amountHrp(amountMsat: number): string {
  if (amountMsat % 1e8 === 0) return `${amountMsat / 1e8}m`;
  if (amountMsat % 1e5 === 0) return `${amountMsat / 1e5}u`;
  if (amountMsat % 1e2 === 0) return `${amountMsat / 1e2}n`;
  return `${amountMsat * 10}p`;
}

export function encodeTestBolt11(opts: EncodeOpts): string {
  const hrp = `ln${opts.network ?? "bc"}${opts.amountMsat !== undefined ? amountHrp(opts.amountMsat) : ""}`;
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const words: number[] = [
    ...intToWords(ts, 7),
    ...tag(1, bytesToWords(Buffer.from(opts.paymentHashHex, "hex"))),
    ...tag(6, minWords(opts.expirySeconds ?? 3600)),
    ...(opts.description ? tag(13, bytesToWords(Buffer.from(opts.description, "utf8"))) : []),
    ...new Array(104).fill(0) // dummy 65-byte signature
  ];
  const checksum = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const cs: number[] = [];
  for (let i = 0; i < 6; i++) cs.push((checksum >>> (5 * (5 - i))) & 31);
  return hrp + "1" + [...words, ...cs].map((w) => CHARSET[w]).join("");
}
