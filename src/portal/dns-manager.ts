// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { request } from "undici";

// ── Config ──────────────────────────────────────────────────────
const GODADDY_API_KEY = process.env.GODADDY_API_KEY ?? "";
const GODADDY_API_SECRET = process.env.GODADDY_API_SECRET ?? "";
const DNS_BASE_DOMAIN = process.env.DNS_BASE_DOMAIN ?? "edgecoder.io";
const DNS_COORDINATOR_PREFIX = process.env.DNS_COORDINATOR_PREFIX ?? "coord";
const DNS_RECORD_TTL = Number(process.env.DNS_RECORD_TTL ?? "300");
const GODADDY_API_BASE = process.env.GODADDY_API_BASE ?? "https://api.godaddy.com";
const DNS_UPDATE_MIN_INTERVAL_MS = 60_000;

// ── Public IP detection ─────────────────────────────────────────

const IPV4_PRIVATE_RANGES: Array<{ start: number; end: number }> = [
  // 10.0.0.0/8
  { start: ipv4ToNum("10.0.0.0"), end: ipv4ToNum("10.255.255.255") },
  // 172.16.0.0/12
  { start: ipv4ToNum("172.16.0.0"), end: ipv4ToNum("172.31.255.255") },
  // 192.168.0.0/16
  { start: ipv4ToNum("192.168.0.0"), end: ipv4ToNum("192.168.255.255") },
  // 127.0.0.0/8 loopback
  { start: ipv4ToNum("127.0.0.0"), end: ipv4ToNum("127.255.255.255") },
  // 169.254.0.0/16 link-local
  { start: ipv4ToNum("169.254.0.0"), end: ipv4ToNum("169.254.255.255") },
  // 100.64.0.0/10 CGNAT
  { start: ipv4ToNum("100.64.0.0"), end: ipv4ToNum("100.127.255.255") },
];

function ipv4ToNum(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isValidIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255 && String(n) === p;
  });
}

function isPrivateIpv4(ip: string): boolean {
  const num = ipv4ToNum(ip);
  return IPV4_PRIVATE_RANGES.some((r) => num >= r.start && num <= r.end);
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return false;
}

export function isPublicIp(ip: string): boolean {
  if (!ip || typeof ip !== "string") return false;
  const trimmed = ip.trim();
  if (!trimmed) return false;

  // IPv4
  if (isValidIpv4(trimmed)) {
    return !isPrivateIpv4(trimmed);
  }

  // IPv6 — must contain a colon
  if (trimmed.includes(":")) {
    return !isPrivateIpv6(trimmed);
  }

  return false;
}

// ── DNS hostname helpers ────────────────────────────────────────

export function sanitizeNodeIdForDns(nodeId: string): string {
  const sanitized = nodeId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return sanitized || "node";
}

export function getCoordinatorHostname(nodeId: string): string {
  const label = sanitizeNodeIdForDns(nodeId);
  return `${label}.${DNS_COORDINATOR_PREFIX}.${DNS_BASE_DOMAIN}`;
}

export function getCoordinatorUrl(nodeId: string): string {
  return `https://${getCoordinatorHostname(nodeId)}`;
}

// ── GoDaddy API ─────────────────────────────────────────────────

function godaddyHeaders(): Record<string, string> {
  return {
    Authorization: `sso-key ${GODADDY_API_KEY}:${GODADDY_API_SECRET}`,
    "Content-Type": "application/json",
  };
}

function dnsRecordName(nodeId: string): string {
  const label = sanitizeNodeIdForDns(nodeId);
  return `${label}.${DNS_COORDINATOR_PREFIX}`;
}

export function isDnsConfigured(): boolean {
  return Boolean(GODADDY_API_KEY && GODADDY_API_SECRET);
}

export async function createOrUpdateDnsRecord(
  nodeId: string,
  ip: string
): Promise<{ ok: boolean; hostname: string; error?: string }> {
  const hostname = getCoordinatorHostname(nodeId);
  if (!isDnsConfigured()) {
    return { ok: false, hostname, error: "godaddy_credentials_not_configured" };
  }
  if (!isPublicIp(ip)) {
    return { ok: false, hostname, error: "ip_not_public" };
  }

  const recordName = dnsRecordName(nodeId);
  const recordType = ip.includes(":") ? "AAAA" : "A";
  const url = `${GODADDY_API_BASE}/v1/domains/${DNS_BASE_DOMAIN}/records/${recordType}/${recordName}`;

  try {
    const res = await request(url, {
      method: "PUT",
      headers: godaddyHeaders(),
      body: JSON.stringify([{ data: ip, ttl: DNS_RECORD_TTL }]),
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return { ok: true, hostname };
    }
    const body = await res.body.text();
    console.error(`[dns-manager] GoDaddy API error ${res.statusCode}: ${body}`);
    return { ok: false, hostname, error: `godaddy_api_${res.statusCode}` };
  } catch (err) {
    console.error("[dns-manager] GoDaddy API request failed:", err);
    return { ok: false, hostname, error: "godaddy_api_request_failed" };
  }
}

export async function deleteDnsRecord(
  nodeId: string
): Promise<{ ok: boolean; error?: string }> {
  if (!isDnsConfigured()) {
    return { ok: false, error: "godaddy_credentials_not_configured" };
  }

  const recordName = dnsRecordName(nodeId);

  // Delete both A and AAAA records (we may not know which type exists)
  const errors: string[] = [];
  for (const recordType of ["A", "AAAA"]) {
    const url = `${GODADDY_API_BASE}/v1/domains/${DNS_BASE_DOMAIN}/records/${recordType}/${recordName}`;
    try {
      const res = await request(url, {
        method: "DELETE",
        headers: godaddyHeaders(),
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      });
      // 404 is fine — record may not exist for that type
      if (res.statusCode >= 200 && res.statusCode < 300) continue;
      if (res.statusCode === 404 || res.statusCode === 422) continue;
      const body = await res.body.text();
      errors.push(`${recordType}: ${res.statusCode} ${body}`);
    } catch (err) {
      errors.push(`${recordType}: ${String(err)}`);
    }
  }

  if (errors.length > 0) {
    console.error("[dns-manager] DNS delete errors:", errors.join("; "));
    return { ok: false, error: errors.join("; ") };
  }
  return { ok: true };
}

// ── Heartbeat-based DNS sync ────────────────────────────────────

export async function syncCoordinatorDns(input: {
  nodeId: string;
  sourceIp: string;
  currentDnsIp: string | null;
  dnsLastUpdatedMs: number | null;
}): Promise<{
  dnsStatus: "active" | "nat" | "error";
  dnsIp: string | null;
}> {
  // Skip if IP hasn't changed
  if (input.sourceIp === input.currentDnsIp) {
    return { dnsStatus: "active", dnsIp: input.currentDnsIp };
  }

  // Rate limit: don't update more than once per minute
  if (
    input.dnsLastUpdatedMs &&
    Date.now() - input.dnsLastUpdatedMs < DNS_UPDATE_MIN_INTERVAL_MS
  ) {
    return {
      dnsStatus: input.currentDnsIp ? "active" : "nat",
      dnsIp: input.currentDnsIp,
    };
  }

  // Not a public IP — remove DNS record if one exists
  if (!isPublicIp(input.sourceIp)) {
    if (input.currentDnsIp) {
      await deleteDnsRecord(input.nodeId).catch(() => {});
    }
    return { dnsStatus: "nat", dnsIp: null };
  }

  // Public IP changed — update DNS
  const result = await createOrUpdateDnsRecord(input.nodeId, input.sourceIp);
  if (result.ok) {
    return { dnsStatus: "active", dnsIp: input.sourceIp };
  }
  return { dnsStatus: "error", dnsIp: input.currentDnsIp };
}
