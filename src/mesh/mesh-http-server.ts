// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import Fastify, { FastifyInstance } from "fastify";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { MeshPeer } from "./mesh-peer.js";
import { LISTEN_HOST } from "../common/env-guard.js";

export interface MeshHttpServerConfig {
  port: number;
  host?: string;
  meshPeer: MeshPeer;
  meshToken?: string;
}

const peerSchema = z.object({
  peerId: z.string(),
  publicKeyPem: z.string(),
  coordinatorUrl: z.string().url(),
  networkMode: z.enum(["public_mesh", "enterprise_overlay"]),
  role: z.enum(["coordinator", "agent", "phone"]).optional()
});

const messageSchema = z.object({
  id: z.string(),
  type: z.string(),
  fromPeerId: z.string(),
  issuedAtMs: z.number(),
  ttlMs: z.number(),
  payload: z.record(z.string(), z.unknown()),
  signature: z.string()
});

export class MeshHttpServer {
  private app: FastifyInstance;
  private actualPort = 0;

  constructor(private config: MeshHttpServerConfig) {
    this.app = Fastify({ logger: false });
    this.registerRoutes();
  }

  /** Set (or rotate) the mesh token once the coordinator provisions it. */
  setMeshToken(token: string | undefined): void {
    this.config.meshToken = token || undefined;
  }

  /** Fails closed: until a mesh token is set, only GET /identity answers. */
  private requireMeshToken(req: { headers: Record<string, string | string[] | undefined> }): boolean {
    const expected = this.config.meshToken;
    if (!expected) return false;
    const token = req.headers["x-mesh-token"];
    if (typeof token !== "string") return false;
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private registerRoutes(): void {
    const { meshPeer } = this.config;

    this.app.get("/identity", async () => ({
      peerId: meshPeer.identity.peerId,
      publicKeyPem: meshPeer.identity.publicKeyPem,
      coordinatorUrl: meshPeer.config.publicUrl,
      networkMode: meshPeer.identity.networkMode,
      role: meshPeer.config.role
    }));

    this.app.get("/mesh/peers", async (req, reply) => {
      if (!this.requireMeshToken(req as any)) {
        return reply.code(401).send({ error: "mesh_unauthorized" });
      }
      return {
        peers: meshPeer.listPeers().map(e => ({
          peerId: e.identity.peerId,
          publicKeyPem: e.identity.publicKeyPem,
          coordinatorUrl: e.identity.coordinatorUrl,
          networkMode: e.identity.networkMode,
          role: e.role
        }))
      };
    });

    this.app.post("/mesh/register-peer", async (req, reply) => {
      if (!this.requireMeshToken(req as any)) {
        return reply.code(401).send({ error: "mesh_unauthorized" });
      }
      const body = peerSchema.parse(req.body);
      meshPeer.addPeer(
        { peerId: body.peerId, publicKeyPem: body.publicKeyPem, coordinatorUrl: body.coordinatorUrl, networkMode: body.networkMode },
        body.role ?? "agent"
      );
      return { ok: true, peerCount: meshPeer.peerCount() };
    });

    this.app.post("/mesh/ingest", async (req, reply) => {
      if (!this.requireMeshToken(req as any)) {
        return reply.code(401).send({ error: "mesh_unauthorized" });
      }
      const raw = messageSchema.parse(req.body);
      const result = await meshPeer.handleIngest(raw as any);
      if (!result.ok) {
        return reply.code(400).send({ error: result.reason });
      }
      return { ok: true };
    });
  }

  async start(): Promise<number> {
    await this.app.listen({ port: this.config.port, host: this.config.host ?? LISTEN_HOST });
    const addr = this.app.server.address();
    this.actualPort = typeof addr === "object" && addr ? addr.port : this.config.port;
    return this.actualPort;
  }

  get port(): number {
    return this.actualPort;
  }

  async stop(): Promise<void> {
    await this.app.close();
  }
}
