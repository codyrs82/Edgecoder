// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * The last step before waiting when a Network only call can't reach the network (backends.ts
 * autoBackend): after this computer's own models (thisComputer), a nearby device the user allowed
 * runs the call over the Bluetooth mesh (src/mesh/ble). Only devices on the user's list
 * (src/mesh/ble/ble-offline-consent.ts) are ever sent a prompt; the agent checks the list again
 * before it sends. Nothing is paid or charged for these calls: they are sent without the co-sign
 * step, so no credit record is made (cSatsSpent 0).
 *
 * The BLE task protocol carries one prompt and returns text, so the conversation is sent as plain
 * text (bluetoothPrompt) and the reply comes back as text: no tool calls over Bluetooth.
 */

import { request } from "undici";
import type { ServedBy } from "../swarm/served-by.js";
import { fitScore, paramsB, planRoutes, type RouteInputs, type Workload } from "./auto-route.js";
import { ChatBackendError, type ChatBackend, type ChatMessage } from "./types.js";

/** Said on a call Network only ran over Bluetooth because the network couldn't be reached. */
export const BLUETOOTH_FAILOVER_WHY = "ran over Bluetooth on your nearby device while the network was unavailable";

/** A nearby device the user allowed, as this computer's agent sees it. */
export interface BluetoothPeer {
  agentId: string;
  /** The name the user gave it. */
  name: string;
  model: string;
  modelParamSize: number;
  deviceType: "phone" | "laptop" | "workstation";
  rssi: number;
}

/** This computer's agent's Bluetooth side (local-forwarder.ts /forward/ble/*), or a fake in tests. */
export interface BluetoothLink {
  /** Allowed devices nearby now (the agent filters by the user's list). */
  peers(signal?: AbortSignal): Promise<BluetoothPeer[]>;
  /** Run one prompt on `agentId`; throws when it couldn't. */
  run(agentId: string, prompt: string, signal?: AbortSignal): Promise<{ output: string; ms?: number }>;
}

/** "Over Bluetooth: Cody's iPhone": a call that ran on a nearby device over Bluetooth. */
export function overBluetooth(name: string, t: { genMs?: number } = {}): ServedBy {
  const label = `Over Bluetooth: ${name}`;
  const out: ServedBy = { label, own: false, computeClass: "bluetooth", tier: null, hardware: label, region: null, country: null };
  if (typeof t.genMs === "number" && Number.isFinite(t.genMs) && t.genMs >= 0) out.genMs = Math.round(t.genMs);
  return out;
}

/** The most prompt bytes a device takes (iOS: 16 KiB; a Mac: 64 KiB, ble-request-guard.ts), with room to spare. */
export function bluetoothMaxPromptBytes(deviceType: BluetoothPeer["deviceType"]): number {
  return deviceType === "phone" ? 15_000 : 60_000;
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

function line(m: ChatMessage): string {
  const who = m.role === "system" ? "System" : m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : `Tool result${m.tool_name ? ` (${m.tool_name})` : ""}`;
  const calls = (m.tool_calls ?? []).map((c) => `[called ${c.function.name} ${JSON.stringify(c.function.arguments ?? {})}]`).join("\n");
  return `${who}: ${[m.content, calls].filter(Boolean).join("\n")}`;
}

/** Cut `s` to at most `max` UTF-8 bytes from the front (`fromEnd` keeps the end instead). */
function cut(s: string, max: number, fromEnd = false): string {
  if (bytes(s) <= max) return s;
  let out = fromEnd ? s.slice(-max) : s.slice(0, max);
  while (bytes(out) > max) out = fromEnd ? out.slice(1) : out.slice(0, -1);
  return fromEnd ? `…${out}` : `${out}…`;
}

/**
 * The conversation as one plain-text prompt within `maxBytes`: the system prompt first (at most a
 * third of the room), then as many of the latest messages as fit, oldest first, ending with
 * "Assistant:". Tool calls and results are written out as text.
 */
export function bluetoothPrompt(messages: readonly ChatMessage[], maxBytes: number): string {
  const note = "(Answer in plain text: tools aren't available on this device.)";
  const tail = "\n\nAssistant:";
  const system = messages.filter((m) => m.role === "system").map(line).join("\n\n");
  const head = cut(system ? `${system}\n${note}` : note, Math.floor(maxBytes / 3));
  let room = maxBytes - bytes(head) - bytes(tail) - 2;
  const kept: string[] = [];
  const rest = messages.filter((m) => m.role !== "system");
  for (let i = rest.length - 1; i >= 0 && room > 0; i--) {
    const l = line(rest[i]);
    const size = bytes(l) + 2;
    if (size <= room) {
      kept.unshift(l);
      room -= size;
    } else {
      // The latest message always goes, cut to what's left; older ones that don't fit are left out.
      if (!kept.length) kept.unshift(cut(l, room - 2, true));
      break;
    }
  }
  return [head, ...kept].join("\n\n") + tail;
}

/**
 * Which allowed devices to try, in order: first the model this computer's failover would pick
 * among the models the devices have (planRoutes "local_only": the best fit, else the biggest usable
 * as the fallback), then the other devices, the nearest fit first (fitScore, then size). Never an
 * embedding model or one under 1B. The strongest signal first among devices with the same model.
 * The step never needs tools here (they can't go over Bluetooth).
 */
export function bluetoothCandidates(peers: readonly BluetoothPeer[], workload: Workload, inputs: Pick<RouteInputs, "classPrice">): Array<{ peer: BluetoothPeer; reason: string }> {
  const w: Workload = { ...workload, needsTools: false };
  const size = (p: BluetoothPeer) => paramsB(p.model) || p.modelParamSize || 0;
  const usable = peers.filter((p) => p.model && !/embed/i.test(p.model) && size(p) >= 1);
  if (!usable.length) return [];
  const models = [...new Set(usable.map((p) => p.model))];
  const pick = planRoutes(w, { localModels: models, myModels: [], leases: [], networkModels: [], classPrice: inputs.classPrice }, "local_only", {})[0]?.model;
  const rank = (p: BluetoothPeer) => (p.model === pick ? 1 : 0);
  return [...usable]
    .sort((a, b) => rank(b) - rank(a) || fitScore(b.model, w) - fitScore(a.model, w) || size(b) - size(a) || b.rssi - a.rssi)
    .map((peer) => ({ peer, reason: `over Bluetooth: ${peer.name} (free) · ${peer.model}` }));
}

/** One allowed device as a chat backend: the prompt goes as text, the reply comes back whole. Free. */
export function bluetoothBackend(link: BluetoothLink, peer: BluetoothPeer): ChatBackend {
  return async function* (req, signal) {
    const prompt = bluetoothPrompt(req.messages, bluetoothMaxPromptBytes(peer.deviceType));
    const started = Date.now();
    let res: { output: string; ms?: number };
    try {
      res = await link.run(peer.agentId, prompt, signal);
    } catch (err) {
      throw err instanceof ChatBackendError ? err : new ChatBackendError(`${peer.name} couldn't run it over Bluetooth: ${(err as Error)?.message ?? String(err)}`, 502);
    }
    if (res.output) yield { delta: res.output };
    yield { done: true, cSatsSpent: 0, stopReason: "stop", served: overBluetooth(peer.name, { genMs: res.ms ?? Date.now() - started }) };
  };
}

/**
 * This computer's agent's Bluetooth side over its local forwarder (local-forwarder.ts
 * /forward/ble/*). No agent, no Bluetooth or nothing allowed: no peers.
 */
export function forwarderBluetoothLink(deps: { forwarder: string; token: () => string }, http: typeof request = request): BluetoothLink {
  const headers = () => ({ "content-type": "application/json", authorization: `Bearer ${deps.token()}` });
  return {
    async peers(signal) {
      const res = await http(`${deps.forwarder}/forward/ble/peers`, { method: "GET", headers: headers(), headersTimeout: 3_000, bodyTimeout: 3_000, ...(signal ? { signal } : {}) });
      if (res.statusCode !== 200) {
        await res.body.dump().catch(() => undefined);
        return [];
      }
      const body = (await res.body.json()) as { peers?: Array<BluetoothPeer & { allowed?: boolean }> };
      return (body.peers ?? []).filter((p) => p && p.allowed === true && typeof p.agentId === "string" && typeof p.model === "string");
    },
    async run(agentId, prompt, signal) {
      // A Bluetooth exchange times out after 90 s on the agent's side.
      const res = await http(`${deps.forwarder}/forward/ble/run`, { method: "POST", headers: headers(), body: JSON.stringify({ agentId, prompt }), headersTimeout: 120_000, bodyTimeout: 120_000, ...(signal ? { signal } : {}) });
      const body = (await res.body.json().catch(() => ({}))) as { output?: string; ms?: number; error?: string; detail?: string };
      if (res.statusCode !== 200) throw new ChatBackendError(`Bluetooth: ${body.error ?? `status ${res.statusCode}`}${body.detail ? ` (${body.detail})` : ""}`, 502);
      return { output: String(body.output ?? ""), ...(typeof body.ms === "number" ? { ms: body.ms } : {}) };
    },
  };
}
