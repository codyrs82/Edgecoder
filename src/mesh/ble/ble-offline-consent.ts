// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * Which nearby devices may run this computer's model calls over Bluetooth while the network can't
 * be reached (src/inference-api/bluetooth-failover.ts), and whether that is on at all.
 *
 * The BLE mesh can't prove that a nearby device belongs to the same owner account: a device's agent
 * id is read from its own identity characteristic (self-asserted), there is no pairing, and the
 * co-sign step (ble-cosign.ts) only signs after the prompt was already sent. So nothing is trusted
 * by default: only devices the user allowed by hand are used, and an empty list means no Bluetooth
 * failover at all. The setting itself ("Use my nearby devices over Bluetooth when offline") is on
 * by default.
 *
 * Kept in ~/.edgecoder/ble-offline.json (EDGECODER_BLE_OFFLINE_FILE overrides), read by both the
 * app's local server (which edits it) and this computer's agent (which sends the calls and checks
 * the list again before sending anything).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface BleOfflineDevice {
  /** The device's EdgeCoder agent id, as it advertises it over Bluetooth. */
  agentId: string;
  /** What the user calls it ("Cody's iPhone"); shown as "Over Bluetooth: <name>". */
  name: string;
}

export interface BleOfflineConsent {
  /** "Use my nearby devices over Bluetooth when offline" (default on). */
  enabled: boolean;
  /** Devices the user allowed. Nothing else is ever sent a prompt. */
  devices: BleOfflineDevice[];
}

export const DEFAULT_BLE_OFFLINE_CONSENT: BleOfflineConsent = { enabled: true, devices: [] };
export const MAX_BLE_OFFLINE_DEVICES = 32;
const AGENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** A short name for a device the user didn't name: its Bluetooth name, "EC-" and the id's first 8 characters. */
export function defaultDeviceName(agentId: string): string {
  return `EC-${agentId.slice(0, 8)}`;
}

/** A consent from untrusted JSON: anything malformed is dropped, never widened. */
export function parseBleOfflineConsent(raw: unknown): BleOfflineConsent {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const enabled = typeof o.enabled === "boolean" ? o.enabled : DEFAULT_BLE_OFFLINE_CONSENT.enabled;
  const devices: BleOfflineDevice[] = [];
  const seen = new Set<string>();
  for (const d of Array.isArray(o.devices) ? (o.devices as Array<Record<string, unknown> | null>) : []) {
    const agentId = typeof d?.agentId === "string" ? d.agentId.trim() : "";
    if (!AGENT_ID_RE.test(agentId) || seen.has(agentId)) continue;
    seen.add(agentId);
    // eslint-disable-next-line no-control-regex
    const name = typeof d?.name === "string" ? d.name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) : "";
    devices.push({ agentId, name: name || defaultDeviceName(agentId) });
    if (devices.length >= MAX_BLE_OFFLINE_DEVICES) break;
  }
  return { enabled, devices };
}

export function bleOfflineConsentFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.EDGECODER_BLE_OFFLINE_FILE?.trim() || join(homedir(), ".edgecoder", "ble-offline.json");
}

/** The saved consent; the default (on, no devices) when there is no file or it can't be read. */
export function loadBleOfflineConsent(file = bleOfflineConsentFile()): BleOfflineConsent {
  try {
    return parseBleOfflineConsent(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return { ...DEFAULT_BLE_OFFLINE_CONSENT, devices: [] };
  }
}

export function saveBleOfflineConsent(consent: unknown, file = bleOfflineConsentFile()): BleOfflineConsent {
  const clean = parseBleOfflineConsent(consent);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(clean, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  return clean;
}

/**
 * The nearby peers a call may go to: only those the user allowed, with the name the user gave them.
 * None when the setting is off.
 */
export function allowedBlePeers<T extends { agentId: string }>(peers: readonly T[], consent: BleOfflineConsent): Array<T & { name: string }> {
  if (!consent.enabled) return [];
  const names = new Map(consent.devices.map((d) => [d.agentId, d.name]));
  return peers.filter((p) => names.has(p.agentId)).map((p) => ({ ...p, name: names.get(p.agentId)! }));
}

/** Whether a call may go to `agentId` right now. */
export function bleOfflineAllowed(agentId: string, consent: BleOfflineConsent): boolean {
  return consent.enabled && consent.devices.some((d) => d.agentId === agentId);
}
