// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Where a model call ran, as the requester sees it with the reply's end: the serving agent's masked
 * label (network-world.ts; the caller's own machine is named as theirs), its compute class and tier
 * with their friendly names, the GPU model and count when the agent reported one, its region, and
 * how long the call waited for pickup, read the prompt and wrote the reply, with the token counts.
 * Nothing here names an agent id, account, host or address.
 */

import { DEFAULT_COMPUTE_CLASSES, type ComputeClassId, type HardwareProfile } from "../economy/compute-classes.js";
import { maskedId, maskedLabel, osFamily, regionInfo } from "./network-world.js";

export interface ServedBy {
  /** `lin-•••3f2a`, or "your machine (mac)" for the caller's own. */
  label: string;
  own: boolean;
  computeClass: string;
  tier: string | null;
  /** "Datacenter GPU (gpu.dc40)". */
  hardware: string;
  /** "2× NVIDIA A16". */
  gpu?: string;
  region: string | null;
  /** The region's city when it is a known hosting region ("Chicago" for ord). */
  city?: string;
  country: string | null;
  pickupMs?: number;
  promptMs?: number;
  genMs?: number;
  promptTokens?: number;
  outputTokens?: number;
  /** A frontier call on the user's own key (computeClass "frontier"): estimated USD, billed by the provider. */
  usd?: number;
}

export interface ServedFacts {
  agentId: string;
  ownerAccountId: string | null;
  requesterAccountId: string;
  os?: string;
  clientType?: string;
  computeClass: string;
  tier: string | null;
  hardwareProfile?: HardwareProfile;
  region?: string | null;
  countryCode?: string | null;
  timings?: { pickupMs?: number; promptMs?: number; genMs?: number; promptTokens?: number; outputTokens?: number };
}

/** Hosting regions (Fly codes) by city, for display. */
export const REGION_CITY: Record<string, string> = {
  iad: "Ashburn", ord: "Chicago", chi: "Chicago", lax: "Los Angeles", sjc: "San Jose", sea: "Seattle", dfw: "Dallas", den: "Denver", ewr: "Secaucus",
  atl: "Atlanta", mia: "Miami", bos: "Boston", phx: "Phoenix", yyz: "Toronto", yul: "Montreal", qro: "Querétaro", gru: "São Paulo", gig: "Rio de Janeiro",
  scl: "Santiago", eze: "Buenos Aires", bog: "Bogotá", lhr: "London", ams: "Amsterdam", fra: "Frankfurt", cdg: "Paris", mad: "Madrid", arn: "Stockholm",
  waw: "Warsaw", otp: "Bucharest", sin: "Singapore", nrt: "Tokyo", hkg: "Hong Kong", bom: "Mumbai", syd: "Sydney", jnb: "Johannesburg",
};

const VENDOR: Record<string, string> = { nvidia: "NVIDIA", amd: "AMD", apple: "Apple", intel: "Intel" };

/** "2× NVIDIA A16" from a hardware profile (undefined without a GPU model). */
export function gpuLine(hw: HardwareProfile | undefined): string | undefined {
  const g = hw?.gpu;
  if (!g?.model) return undefined;
  const model = String(g.model).replace(/\s+/g, " ").trim().slice(0, 60);
  const vendor = g.vendor && VENDOR[g.vendor] && !model.toLowerCase().startsWith(g.vendor.toLowerCase()) ? `${VENDOR[g.vendor]} ` : "";
  const count = typeof g.count === "number" && g.count > 1 ? `${Math.floor(g.count)}× ` : "";
  return `${count}${vendor}${model}`;
}

export function describeServed(key: Buffer, f: ServedFacts): ServedBy {
  const family = osFamily(f.os, f.clientType);
  const own = !!f.ownerAccountId && f.ownerAccountId === f.requesterAccountId;
  const spec = DEFAULT_COMPUTE_CLASSES[f.computeClass as ComputeClassId];
  const hardware = `${spec?.label ?? f.computeClass}${f.tier ? ` (${f.tier})` : ""}`;
  const where = regionInfo(f.region, f.countryCode);
  const gpu = gpuLine(f.hardwareProfile);
  const t = f.timings ?? {};
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
  const out: ServedBy = {
    label: own ? `your machine (${family === "macos" ? "Mac" : family})` : maskedLabel(family, maskedId(key, f.agentId)),
    own,
    computeClass: f.computeClass,
    tier: f.tier,
    hardware,
    ...(gpu ? { gpu } : {}),
    region: where.region,
    ...(where.region && REGION_CITY[where.region] ? { city: REGION_CITY[where.region] } : {}),
    country: where.country,
  };
  for (const k of ["pickupMs", "promptMs", "genMs", "promptTokens", "outputTokens"] as const) {
    const v = n(t[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}
