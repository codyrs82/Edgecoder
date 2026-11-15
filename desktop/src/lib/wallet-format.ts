// Wallet formatting shared by the Wallet and Compute pages (docs/design/wallet-and-market.md).
// Pure functions: no money logic, only how the coordinator's numbers are shown.

export const fmtSats = (n: number) => Math.round(Number(n) || 0).toLocaleString("en-US");
/** msat as sats with up to 3 decimals, so earnings below 1 sat are not shown as 0. */
export const fmtMsat = (m: number) => ((Number(m) || 0) / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 });
export const fmtNum = (n: number, d = 2) => (Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: d });
export const pct = (bps: number) => `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} %`;

/** "≈ $19.69"; "" without a rate. */
export function fmtUsd(sats: number, btcUsd: number | null | undefined): string {
  if (!btcUsd || !Number.isFinite(sats)) return "";
  const usd = (sats / 1e8) * btcUsd;
  if (usd === 0) return "≈ $0.00";
  return "≈ $" + usd.toLocaleString("en-US", { minimumFractionDigits: usd < 1 ? 3 : 2, maximumFractionDigits: usd < 1 ? 4 : 2 });
}

/** The fee preview before an invoice exists, with the coordinator's rate: floor(amount × bps / 10000). The invoice's own figures replace it. */
export function purchasePreview(amountSats: number, feeBps: number): { fee: number; get: number } {
  const fee = Math.floor((amountSats * feeBps) / 10000);
  return { fee, get: amountSats - fee };
}

export interface NetworkInfo { label: string; tone: "main" | "test" | "unknown"; test: boolean; short: string }
/** Mainnet is real money; regtest, testnet and signet are test sats with no value. */
export function networkInfo(n: string | null | undefined): NetworkInfo {
  if (n === "bitcoin" || n === "mainnet") return { label: "Bitcoin mainnet · real sats", tone: "main", test: false, short: "mainnet" };
  if (n === "regtest") return { label: "Regtest · test sats, no value", tone: "test", test: true, short: "regtest" };
  if (n === "signet" || n === "testnet") return { label: `${n === "signet" ? "Signet" : "Testnet"} · test sats, no value`, tone: "test", test: true, short: n };
  return { label: "Network unknown", tone: "unknown", test: true, short: n || "unknown" };
}

const REASONS: Record<string, string> = {
  credit_purchase: "Bought cSats", inference_reserve: "Model call (set aside)", inference: "Model call", task_submit: "Code job (set aside)",
  task_submit_refund: "Unused set-aside returned", compute_reservation: "Reserved a machine", reservation_refund: "Reservation time returned",
  compute_contribution: "Earned running jobs", reservation_earning: "Earned from a reservation", payout: "Withdrawal",
  payout_refund: "Withdrawal returned", payout_fee_excess: "Withdrawal routing fee", fee_pool_distribution: "Infrastructure host share",
};
export function reasonText(r: string): string {
  if (/^credit_purchase:onchain:/.test(String(r || ""))) return "Bitcoin deposit";
  const base = String(r || "").replace(/:.*/, "");
  return REASONS[base] ?? (base.replace(/_/g, " ") || "–");
}

/** "Expires in 14:59". */
export function countdown(msLeft: number): string {
  const s = Math.max(0, Math.round(msLeft / 1000));
  return s > 0 ? `Expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "Expiring…";
}
