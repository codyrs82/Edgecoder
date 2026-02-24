import Fastify, { FastifyInstance } from "fastify";
import { z } from "zod";
import { MeshPeer } from "./mesh-peer.js";

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

  private requireMeshToken(req: { headers: Record<string, string | string[] | undefined> }): boolean {
    if (!this.config.meshToken) return true;
    const token = req.headers["x-mesh-token"];
    return typeof token === "string" && token === this.config.meshToken;
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
    await this.app.listen({ port: this.config.port, host: this.config.host ?? "0.0.0.0" });
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
