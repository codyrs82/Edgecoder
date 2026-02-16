import { generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { MeshPeerIdentity, MeshMessage, NetworkMode } from "../common/types.js";

export interface PeerKeys {
  peerId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export function createPeerKeys(peerId?: string): PeerKeys {
  const finalPeerId = peerId ?? randomUUID();
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { peerId: finalPeerId, publicKeyPem, privateKeyPem };
}

export function createPeerIdentity(
  keys: PeerKeys,
  coordinatorUrl: string,
  networkMode: NetworkMode
): MeshPeerIdentity {
  return {
    peerId: keys.peerId,
    publicKeyPem: keys.publicKeyPem,
    coordinatorUrl,
    networkMode
  };
}

export function signPayload(payload: string, privateKeyPem: string): string {
  return sign(null, Buffer.from(payload), privateKeyPem).toString("base64");
}

export function verifyPayload(payload: string, signature: string, publicKeyPem: string): boolean {
  try {
    return verify(null, Buffer.from(payload), publicKeyPem, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export function canonicalizeMessage(message: Omit<MeshMessage, "signature">): string {
  return JSON.stringify({
    id: message.id,
    type: message.type,
    fromPeerId: message.fromPeerId,
    issuedAtMs: message.issuedAtMs,
    ttlMs: message.ttlMs,
    payload: message.payload
  });
}
