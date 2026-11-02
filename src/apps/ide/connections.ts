// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Connections: each one is a local port that any tool can point at (OpenAI or Anthropic API), fixed
 * to one place to run: this computer's Ollama, your own machines, a reserved machine, or any agent
 * on the network (optionally one class, under a price ceiling). Several run at once, so different
 * tools (or several copies of one) can use different compute in parallel. Each has its own key and
 * an optional cSat budget. The tool's model name is ignored: the connection decides what runs.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { localBackend, networkBackend } from "../../inference-api/backends.js";
import { apiKeyOf, registerCompatRoutes } from "../../inference-api/routes.js";
import type { ChatBackend, ChatPiece } from "../../inference-api/types.js";
import type { NetworkDeps } from "./network-inference.js";

export type ConnectionTarget = "local" | "mine" | "network" | "reserved";

export interface Connection {
  id: string;
  name: string;
  port: number;
  key: string;
  target: ConnectionTarget;
  model: string;
  /** network: cpu | apple | gpu | gpu.dc, or any. */
  computeClass?: string;
  /** reserved: the lease to run on. */
  reservationId?: string;
  /** network: the most to pay, cSats per second on the class's base tier. */
  maxCSatsPerSecond?: number;
  /** Stop once this much has been spent through the connection (cSats). */
  budgetCSats?: number;
  spentCSats: number;
  enabled: boolean;
  createdAtMs: number;
}

export interface ConnectionStatus extends Connection {
  url: string;
  listening: boolean;
  error?: string;
}

export const FIRST_CONNECTION_PORT = 4310;
const RESERVED_PORTS = new Set([4301, 4302, 4303, 4304, 4305, 4306]);

export function connectionsFile(): string {
  return process.env.EDGECODER_CONNECTIONS_FILE ?? join(homedir(), ".edgecoder", "connections.json");
}

export const newKey = () => `ec-${randomBytes(24).toString("base64url")}`;

/** The display name of what a connection runs, also what /v1/models lists. */
export function connectionModelId(c: Pick<Connection, "target" | "model" | "computeClass">): string {
  if (c.target === "local") return c.model;
  if (c.target === "mine") return `mine/${c.model}`;
  if (c.target === "reserved") return `reserved/${c.model}`;
  return `network/${c.model}${c.computeClass && c.computeClass !== "any" ? `@${c.computeClass}` : ""}`;
}

export class ConnectionManager {
  private conns: Connection[] = [];
  private servers = new Map<string, { app: FastifyInstance; error?: string; listening: boolean }>();
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly deps: {
      ollamaHost: string;
      network?: NetworkDeps;
      file?: string;
      log?: (msg: string, extra?: unknown) => void;
    },
  ) {}

  private get file() {
    return this.deps.file ?? connectionsFile();
  }

  load(): void {
    try {
      if (existsSync(this.file)) this.conns = (JSON.parse(readFileSync(this.file, "utf8")).connections as Connection[]) ?? [];
    } catch (err) {
      this.deps.log?.("connections_load_failed", err);
      this.conns = [];
    }
  }

  private saveNow(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ connections: this.conns }, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // best effort
    }
  }

  private saveSoon(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 500);
    this.saveTimer.unref?.();
  }

  list(): ConnectionStatus[] {
    return this.conns.map((c) => {
      const s = this.servers.get(c.id);
      return { ...c, url: `http://127.0.0.1:${c.port}/v1`, listening: !!s?.listening, ...(s?.error ? { error: s.error } : {}) };
    });
  }

  get(id: string): Connection | undefined {
    return this.conns.find((c) => c.id === id);
  }

  /** The next free port from 4310 that no connection uses. */
  nextPort(): number {
    const used = new Set(this.conns.map((c) => c.port));
    let p = FIRST_CONNECTION_PORT;
    while (used.has(p) || RESERVED_PORTS.has(p)) p++;
    return p;
  }

  validate(c: Partial<Connection>): string | null {
    if (!c.name?.trim()) return "Give the connection a name.";
    if (!c.model?.trim()) return "Pick a model.";
    if (!c.target || !["local", "mine", "network", "reserved"].includes(c.target)) return "Pick where it runs.";
    if (c.target === "reserved" && !c.reservationId) return "Pick a reservation.";
    if (c.port !== undefined && (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535 || RESERVED_PORTS.has(c.port))) return "Use a port from 1024 to 65535 that EdgeCoder doesn't already use (4301–4306).";
    if (c.port !== undefined && this.conns.some((o) => o.port === c.port && o.id !== c.id)) return `Port ${c.port} is used by another connection.`;
    if (c.target !== "local" && !this.deps.network) return "This computer's agent isn't connected to the network.";
    return null;
  }

  async create(input: Omit<Connection, "id" | "key" | "spentCSats" | "createdAtMs" | "port" | "enabled"> & { port?: number; enabled?: boolean }): Promise<ConnectionStatus> {
    const c: Connection = {
      ...input,
      id: randomUUID().slice(0, 8),
      key: newKey(),
      port: input.port ?? this.nextPort(),
      spentCSats: 0,
      enabled: input.enabled ?? true,
      createdAtMs: Date.now(),
    };
    const bad = this.validate(c);
    if (bad) throw new Error(bad);
    this.conns.push(c);
    this.saveNow();
    if (c.enabled) await this.start(c);
    return this.list().find((x) => x.id === c.id)!;
  }

  async update(id: string, patch: Partial<Connection> & { rotateKey?: boolean; resetSpent?: boolean }): Promise<ConnectionStatus> {
    const c = this.get(id);
    if (!c) throw new Error("unknown connection");
    const { rotateKey, resetSpent, id: _id, key: _key, spentCSats: _s, createdAtMs: _c, ...fields } = patch;
    const next: Connection = { ...c, ...fields, ...(rotateKey ? { key: newKey() } : {}), ...(resetSpent ? { spentCSats: 0 } : {}) };
    const bad = this.validate(next);
    if (bad) throw new Error(bad);
    Object.assign(c, next);
    this.saveNow();
    await this.stop(id);
    if (c.enabled) await this.start(c);
    return this.list().find((x) => x.id === id)!;
  }

  async remove(id: string): Promise<void> {
    await this.stop(id);
    this.conns = this.conns.filter((c) => c.id !== id);
    this.saveNow();
  }

  async startAll(): Promise<void> {
    for (const c of this.conns) if (c.enabled) await this.start(c);
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.servers.keys()]) await this.stop(id);
  }

  private async stop(id: string): Promise<void> {
    const s = this.servers.get(id);
    this.servers.delete(id);
    if (s) await s.app.close().catch(() => undefined);
  }

  /** What runs a connection's requests (its spend is counted against its budget). */
  backendFor(c: Connection): ChatBackend {
    const inner =
      c.target === "local"
        ? localBackend(this.deps.ollamaHost, c.model)
        : networkBackend(this.deps.network!, {
            model: c.model,
            computeClass: c.target === "network" ? c.computeClass ?? "any" : "any",
            ...(c.target === "mine" ? { target: "mine" as const } : {}),
            ...(c.target === "reserved" ? { reservationId: c.reservationId } : {}),
            ...(c.target === "network" && c.maxCSatsPerSecond ? { maxCSatsPerSecond: c.maxCSatsPerSecond } : {}),
          });
    const self = this;
    return async function* (req, signal) {
      for await (const p of inner(req, signal) as AsyncGenerator<ChatPiece>) {
        if ("done" in p && p.cSatsSpent) {
          c.spentCSats = Number((c.spentCSats + p.cSatsSpent).toFixed(6));
          self.saveSoon();
        }
        yield p;
      }
    };
  }

  private async start(c: Connection): Promise<void> {
    const app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });
    registerCompatRoutes(app, {
      authenticate: async (req) => (apiKeyOf(req) === c.key ? c : null),
      models: async () => [connectionModelId(c)],
      resolve: async () => {
        if (c.budgetCSats !== undefined && c.spentCSats >= c.budgetCSats)
          return { status: 402, error: `This connection has used its budget (${c.budgetCSats} cSats). Raise it or reset it on the Connect to compute page.` };
        return { backend: this.backendFor(c), model: connectionModelId(c) };
      },
    });
    app.get("/health", async () => ({ ok: true, connection: c.name, model: connectionModelId(c) }));
    const entry: { app: FastifyInstance; error?: string; listening: boolean } = { app, listening: false };
    this.servers.set(c.id, entry);
    try {
      await app.listen({ host: "127.0.0.1", port: c.port });
      entry.listening = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      entry.error = code === "EADDRINUSE" ? `Port ${c.port} is in use by another program. Pick another port.` : (err as Error).message;
      this.deps.log?.("connection_listen_failed", { id: c.id, port: c.port, error: entry.error });
    }
  }
}
