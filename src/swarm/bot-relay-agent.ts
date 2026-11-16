// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The agent's side of bots on the web (src/common/bot-relay.ts has the chain).
 *
 * Publishing: every few seconds it reads this computer's bots from the local IDE provider (IDE
 * token, loopback) and sends the snapshot to its coordinator when it changed, and at least every
 * heartbeat while nothing changes (signed request: the coordinator files it under this agent and
 * serves it only to the agent's verified owner).
 *
 * Commands: a bot_control frame from the mesh WebSocket is checked against the coordinator identity
 * this agent pinned (signature, its own agent id, lifetime, replay), then the host policy
 * (AGENT_BOT_RELAY / AGENT_REMOTE_CONTROL) and a local rate limit, and only then handed to the
 * provider, which checks the account and the bot's own rules. The result goes back signed.
 */

import { createHash } from "node:crypto";
import { BOT_READ_ACTIONS, CommandReplayGuard, MAX_RESULT_BYTES, MAX_SNAPSHOT_BYTES, verifyBotControlFrame, type BotControlResult, type BotsSnapshot, type RelayControls } from "../common/bot-relay.js";

/** How often the provider's bots are read (only a change is sent). */
export const BOT_POLL_MS = 4_000;
/** A snapshot is re-sent at least this often while nothing changes (the web's "online" signal). */
export const BOT_HEARTBEAT_MS = 2 * 60_000;
/** Commands this agent runs per window (reads count separately). */
export const AGENT_BOT_COMMANDS_PER_WINDOW = 30;
export const AGENT_BOT_READS_PER_WINDOW = 120;
const WINDOW_MS = 10 * 60_000;

export interface ProviderClient {
  snapshot(machine: string, controls: RelayControls): Promise<BotsSnapshot | null>;
  command(body: { requestedBy: string; botId: string; action: string; args: unknown; controls: RelayControls }): Promise<Omit<BotControlResult, "commandId">>;
}

export interface BotRelayAgentDeps {
  agentId: string;
  mode: "off" | RelayControls;
  machineName: string;
  provider: ProviderClient;
  /** Signed POST to the coordinator this agent is registered with. */
  report: (body: { snapshot?: BotsSnapshot; result?: BotControlResult }) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
}

export class BotRelayAgent {
  private readonly replay = new CommandReplayGuard();
  private lastHash = "";
  private lastSentMs = 0;
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | null = null;
  private readonly recent = { change: [] as number[], read: [] as number[] };

  constructor(private readonly deps: BotRelayAgentDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private log(m: string) {
    this.deps.log?.(m);
  }
  get controls(): RelayControls {
    return this.deps.mode === "on" ? "on" : "view";
  }

  start(intervalMs = BOT_POLL_MS): void {
    if (this.deps.mode === "off" || this.timer) return;
    this.timer = setInterval(() => void this.publish(), intervalMs);
    this.timer.unref?.();
  }
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
  /** Re-send on the next publish (the socket reconnected, or the coordinator changed). */
  invalidate(): void {
    this.lastHash = "";
  }

  /** Reads the bots and sends them when they changed or the heartbeat is due. One at a time. */
  publish(force = false): Promise<void> {
    if (this.deps.mode === "off") return Promise.resolve();
    // A forced publish (a change just happened) runs after the one in flight, which may predate it.
    if (this.polling) return force ? this.polling.then(() => this.publish(true)) : this.polling;
    this.polling = (async () => {
      let snap: BotsSnapshot | null;
      try {
        snap = await this.deps.provider.snapshot(this.deps.machineName, this.controls);
      } catch {
        return; // the app's provider isn't up (yet); nothing to publish
      }
      if (!snap) return;
      // Changes only: the generation time is not part of the comparison.
      const text = JSON.stringify({ ...snap, generatedAtMs: 0 });
      if (Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES) return;
      const hash = createHash("sha256").update(text).digest("hex");
      const now = this.now();
      if (!force && hash === this.lastHash && now - this.lastSentMs < BOT_HEARTBEAT_MS) return;
      try {
        await this.deps.report({ snapshot: snap });
        this.lastHash = hash;
        this.lastSentMs = now;
      } catch (e) {
        this.log(`bots report failed: ${String(e).slice(0, 160)}`);
      }
    })().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private limited(kind: "change" | "read"): boolean {
    const now = this.now();
    const list = this.recent[kind];
    while (list.length && now - list[0] > WINDOW_MS) list.shift();
    if (list.length >= (kind === "read" ? AGENT_BOT_READS_PER_WINDOW : AGENT_BOT_COMMANDS_PER_WINDOW)) return true;
    list.push(now);
    return false;
  }

  /** A bot_control frame from the mesh WebSocket. `coordinator` is the identity this agent proved (pinned key). */
  async handleFrame(frame: unknown, coordinator: { peerId: string; publicKeyPem: string } | null): Promise<BotControlResult | { status: "ignored"; error: string }> {
    const verdict = verifyBotControlFrame(frame, { agentId: this.deps.agentId, coordinator, replay: this.replay, nowMs: this.now() });
    if (!verdict.ok) {
      this.log(`bot_control refused: ${verdict.reason}`);
      // Nothing is reported for a frame that didn't verify (it may not be from our coordinator).
      return { status: "ignored", error: verdict.reason };
    }
    const { command, request } = verdict;
    const finish = async (r: Omit<BotControlResult, "commandId">): Promise<BotControlResult> => {
      let result: BotControlResult = { commandId: command.id, ...r };
      if (result.data !== undefined && Buffer.byteLength(JSON.stringify(result.data)) > MAX_RESULT_BYTES) {
        result = { commandId: command.id, status: "failed", error: "result_too_large" };
      }
      try {
        await this.deps.report({ result });
      } catch (e) {
        this.log(`bots result report failed: ${String(e).slice(0, 160)}`);
      }
      // A change shows on the web right away.
      if (!BOT_READ_ACTIONS.has(request.action) && result.status === "done") void this.publish(true);
      return result;
    };
    if (this.deps.mode === "off") return finish({ status: "refused", error: "relay_off" });
    const read = BOT_READ_ACTIONS.has(request.action);
    if (!read && this.controls !== "on") return finish({ status: "refused", error: "view_only", message: "This Mac shows its bots on the web read-only (AGENT_BOT_RELAY=view or AGENT_REMOTE_CONTROL=off)." });
    if (this.limited(read ? "read" : "change")) return finish({ status: "refused", error: "agent_rate_limited" });
    this.log(`bot ${command.botId}: ${request.action} for ${command.requestedBy} (command ${command.id})`);
    try {
      const r = await this.deps.provider.command({ requestedBy: command.requestedBy, botId: command.botId, action: request.action, args: request.args, controls: this.controls });
      return finish(r);
    } catch (e) {
      return finish({ status: "failed", error: "provider_unreachable", message: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }
}

/** The local IDE provider over loopback with the IDE token (the same token the forwarder takes). */
export function httpProviderClient(input: { baseUrl: string; token: () => string; request: typeof import("undici").request; timeoutMs?: number }): ProviderClient {
  const t = input.timeoutMs ?? 10_000;
  const headers = () => ({ authorization: `Bearer ${input.token()}`, "content-type": "application/json" });
  return {
    async snapshot(machine, controls) {
      const q = new URLSearchParams({ machine, controls });
      const res = await input.request(`${input.baseUrl}/v1/ide/bots/remote/snapshot?${q}`, { method: "GET", headers: headers(), headersTimeout: t, bodyTimeout: t });
      if (res.statusCode !== 200) {
        await res.body.dump();
        return null;
      }
      return (await res.body.json()) as BotsSnapshot;
    },
    async command(body) {
      const res = await input.request(`${input.baseUrl}/v1/ide/bots/remote/command`, { method: "POST", headers: headers(), body: JSON.stringify(body), headersTimeout: t, bodyTimeout: t });
      const j = (await res.body.json().catch(() => ({}))) as Omit<BotControlResult, "commandId">;
      if (j && typeof j.status === "string") return j;
      return { status: "failed", error: `provider_${res.statusCode}` };
    },
  };
}
