// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The agent's side of "Code from your phone" (src/common/code-relay.ts has the chain), modelled on
 * bot-relay-agent.ts.
 *
 * Publishing: every few seconds it reads this computer's trusted projects and visible sessions from
 * the local IDE provider (IDE token, loopback) for the account that owns this machine, and sends the
 * snapshot to its coordinator when it changed, and at least every heartbeat while nothing changes.
 *
 * Commands: a code_control frame from the mesh WebSocket is checked against the coordinator identity
 * this agent pinned (signature, its own agent id, lifetime, replay), then AGENT_CODE_RELAY (only
 * "on" takes commands) and a local rate limit, and only then handed to the provider with
 * requestedBy = the frame's account; the provider checks that account is the one signed in on the
 * Mac. The result goes back signed.
 */

import { createHash } from "node:crypto";
import {
  CODE_READ_ACTIONS, CommandReplayGuard, MAX_CODE_RESULT_BYTES, MAX_CODE_SNAPSHOT_BYTES, verifyCodeControlFrame,
  type CodeControlResult, type CodeProject, type CodeRelayControls, type CodeRelayMode, type CodeSessionSummary, type CodeSnapshot
} from "../common/code-relay.js";

/** How often the provider's sessions are read (only a change is sent). */
export const CODE_POLL_MS = 4_000;
/** A snapshot is re-sent at least this often while nothing changes (the phone's "online" signal). */
export const CODE_HEARTBEAT_MS = 2 * 60_000;
/** Changes this agent runs per window; reads count separately; creates per hour (they count as changes too). */
export const AGENT_CODE_CHANGES_PER_WINDOW = 120;
export const AGENT_CODE_READS_PER_WINDOW = 600;
export const AGENT_CODE_CREATES_PER_HOUR = 20;
const WINDOW_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;

/** What the provider's snapshot route answers (code-remote.ts CodeRemoteSnapshot). */
export interface ProviderCodeSnapshot {
  v: 1;
  generatedAtMs: number;
  projects: CodeProject[];
  sessions: CodeSessionSummary[];
}

export interface CodeProviderClient {
  /** null: the provider refused (another account is signed in on the Mac, or none). */
  snapshot(account: string): Promise<ProviderCodeSnapshot | null>;
  command(body: Record<string, unknown> & { requestedBy: string; action: string }): Promise<Omit<CodeControlResult, "commandId">>;
}

export interface CodeRelayAgentDeps {
  agentId: string;
  mode: CodeRelayMode;
  machineName: string;
  /** The account the coordinator says owns this machine (null until registered, or with no owner). */
  account: () => string | null;
  provider: CodeProviderClient;
  /** Signed POST to the coordinator this agent is registered with. */
  report: (body: { snapshot?: CodeSnapshot; result?: CodeControlResult }) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
}

export class CodeRelayAgent {
  private readonly replay = new CommandReplayGuard();
  private lastHash = "";
  private lastSentMs = 0;
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | null = null;
  private readonly recent = { change: [] as number[], read: [] as number[], create: [] as number[] };

  constructor(private readonly deps: CodeRelayAgentDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private log(m: string) {
    this.deps.log?.(m);
  }
  get controls(): CodeRelayControls {
    return this.deps.mode === "on" ? "on" : "view";
  }

  start(intervalMs = CODE_POLL_MS): void {
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

  /** Reads the sessions and sends them when they changed or the heartbeat is due. One at a time. */
  publish(force = false): Promise<void> {
    if (this.deps.mode === "off") return Promise.resolve();
    if (this.polling) return force ? this.polling.then(() => this.publish(true)) : this.polling;
    this.polling = (async () => {
      const account = this.deps.account();
      if (!account) return; // no owner known yet: nobody could read it
      let snap: ProviderCodeSnapshot | null;
      try {
        snap = await this.deps.provider.snapshot(account);
      } catch {
        return; // the app's provider isn't up (yet)
      }
      if (!snap) return;
      const out: CodeSnapshot = {
        v: 1,
        machineName: this.deps.machineName,
        controls: this.controls,
        account,
        generatedAtMs: snap.generatedAtMs,
        projects: snap.projects ?? [],
        sessions: snap.sessions ?? []
      };
      // Changes only: the generation time is not part of the comparison.
      const text = JSON.stringify({ ...out, generatedAtMs: 0 });
      if (Buffer.byteLength(text) > MAX_CODE_SNAPSHOT_BYTES) return;
      const hash = createHash("sha256").update(text).digest("hex");
      const now = this.now();
      if (!force && hash === this.lastHash && now - this.lastSentMs < CODE_HEARTBEAT_MS) return;
      try {
        await this.deps.report({ snapshot: out });
        this.lastHash = hash;
        this.lastSentMs = now;
      } catch (e) {
        this.log(`code report failed: ${String(e).slice(0, 160)}`);
      }
    })().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private limited(kind: "change" | "read" | "create"): boolean {
    const now = this.now();
    const max = { read: AGENT_CODE_READS_PER_WINDOW, change: AGENT_CODE_CHANGES_PER_WINDOW, create: AGENT_CODE_CREATES_PER_HOUR };
    const kinds = kind === "create" ? (["create", "change"] as const) : ([kind] as const);
    for (const k of kinds) {
      const list = this.recent[k];
      const window = k === "create" ? HOUR_MS : WINDOW_MS;
      while (list.length && now - list[0] > window) list.shift();
      if (list.length >= max[k]) return true;
    }
    for (const k of kinds) this.recent[k].push(now);
    return false;
  }

  /** A code_control frame from the mesh WebSocket. `coordinator` is the identity this agent proved (pinned key). */
  async handleFrame(frame: unknown, coordinator: { peerId: string; publicKeyPem: string } | null): Promise<CodeControlResult | { status: "ignored"; error: string }> {
    const verdict = verifyCodeControlFrame(frame, { agentId: this.deps.agentId, coordinator, replay: this.replay, nowMs: this.now() });
    if (!verdict.ok) {
      this.log(`code_control refused: ${verdict.reason}`);
      // Nothing is reported for a frame that didn't verify (it may not be from our coordinator).
      return { status: "ignored", error: verdict.reason };
    }
    const { command, request } = verdict;
    const read = CODE_READ_ACTIONS.has(request.action);
    const finish = async (r: Omit<CodeControlResult, "commandId">): Promise<CodeControlResult> => {
      // Only the known fields (the coordinator's report schema is strict).
      let result: CodeControlResult = {
        commandId: command.id,
        status: r.status === "done" || r.status === "refused" ? r.status : "failed",
        ...(typeof r.error === "string" ? { error: r.error.slice(0, 80) } : {}),
        ...(typeof r.message === "string" ? { message: r.message.slice(0, 300) } : {}),
        ...(r.data !== undefined ? { data: r.data } : {})
      };
      if (result.data !== undefined && Buffer.byteLength(JSON.stringify(result.data)) > MAX_CODE_RESULT_BYTES) {
        result = { commandId: command.id, status: "failed", error: "result_too_large" };
      }
      try {
        await this.deps.report({ result });
      } catch (e) {
        this.log(`code result report failed: ${String(e).slice(0, 160)}`);
      }
      // A change shows on the phone right away.
      if (!read && result.status === "done") void this.publish(true);
      return result;
    };
    if (this.deps.mode === "off") return finish({ status: "refused", error: "relay_off", message: "Code from your phone is off on this Mac." });
    if (this.deps.mode !== "on") return finish({ status: "refused", error: "view_only", message: "This Mac shows its sessions on the phone but takes no commands (Code from your phone: View only)." });
    if (this.limited(read ? "read" : request.action === "create" ? "create" : "change")) return finish({ status: "refused", error: "agent_rate_limited" });
    this.log(`code: ${request.action} for ${command.requestedBy} (command ${command.id})`);
    try {
      // The provider's body is flat ({ requestedBy, action, ...args }); args never carry those two keys (strict schemas).
      const r = await this.deps.provider.command({ ...(request.args as Record<string, unknown>), requestedBy: command.requestedBy, action: request.action });
      return finish(r);
    } catch (e) {
      return finish({ status: "failed", error: "provider_unreachable", message: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }
}

/** The local IDE provider over loopback with the IDE token (the same token the bot relay uses). */
export function httpCodeProviderClient(input: { baseUrl: string; token: () => string; request: typeof import("undici").request; timeoutMs?: number }): CodeProviderClient {
  const t = input.timeoutMs ?? 10_000;
  const headers = () => ({ authorization: `Bearer ${input.token()}`, "content-type": "application/json" });
  return {
    async snapshot(account) {
      const q = new URLSearchParams({ account });
      const res = await input.request(`${input.baseUrl}/v1/ide/code/remote/snapshot?${q}`, { method: "GET", headers: headers(), headersTimeout: t, bodyTimeout: t });
      if (res.statusCode !== 200) {
        await res.body.dump();
        return null;
      }
      return (await res.body.json()) as ProviderCodeSnapshot;
    },
    async command(body) {
      const res = await input.request(`${input.baseUrl}/v1/ide/code/remote/command`, { method: "POST", headers: headers(), body: JSON.stringify(body), headersTimeout: t, bodyTimeout: t });
      const j = (await res.body.json().catch(() => ({}))) as Omit<CodeControlResult, "commandId">;
      if (j && typeof j.status === "string") return j;
      return { status: "failed", error: `provider_${res.statusCode}` };
    }
  };
}
