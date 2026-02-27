// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

export { safeTokenEqual } from "../common/crypto-utils.js";

export function normalizeIpCandidate(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (value.toLowerCase() === "unknown") return undefined;
  if (value.startsWith("::ffff:")) return value.slice(7);
  if (value.startsWith("[") && value.includes("]")) return value.slice(1, value.indexOf("]"));
  const colonCount = (value.match(/:/g) ?? []).length;
  if (colonCount === 1 && /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value)) {
    return value.split(":")[0];
  }
  return value;
}

export function readHeaderValue(headers: Record<string, unknown>, key: string): string | undefined {
  const raw = headers[key];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const first = raw.find((item) => typeof item === "string");
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

export function extractClientIp(headers: Record<string, unknown>, fallbackIp?: string): string | undefined {
  const priorityHeaders = ["fly-client-ip", "cf-connecting-ip", "x-real-ip", "true-client-ip"];
  for (const key of priorityHeaders) {
    const headerValue = readHeaderValue(headers, key);
    const normalized = headerValue ? normalizeIpCandidate(headerValue) : undefined;
    if (normalized) return normalized;
  }
  const forwarded = readHeaderValue(headers, "x-forwarded-for");
  if (forwarded) {
    for (const part of forwarded.split(",")) {
      const normalized = normalizeIpCandidate(part);
      if (normalized) return normalized;
    }
  }
  if (typeof fallbackIp === "string") {
    return normalizeIpCandidate(fallbackIp);
  }
  return undefined;
}

export function normalizeUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join("::");
}

export function weightedMedian(entries: Array<{ value: number; weight: number }>): number {
  if (entries.length === 0) return 0;
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  if (totalWeight <= 0) return sorted[Math.floor(sorted.length / 2)]?.value ?? 0;
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += Math.max(0, item.weight);
    if (cumulative >= totalWeight / 2) return item.value;
  }
  return sorted[sorted.length - 1]?.value ?? 0;
}

export function parseRecordPayload(record: { payloadJson?: string }): Record<string, unknown> {
  if (!record.payloadJson) return {};
  try {
    return JSON.parse(record.payloadJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function computeIntentFee(amountSats: number, feeBps: number): { feeSats: number; netSats: number } {
  const feeSats = Math.floor((amountSats * feeBps) / 10000);
  const netSats = Math.max(0, amountSats - feeSats);
  return { feeSats, netSats };
}
