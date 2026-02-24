import { createHash, randomBytes, timingSafeEqual, scryptSync } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const segment of cookieHeader.split(";")) {
    const [rawKey, ...rest] = segment.trim().split("=");
    if (!rawKey || rest.length === 0) continue;
    out[rawKey] = decodeURIComponent(rest.join("="));
  }
  return out;
}

export function secureCompare(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function encodeCookie(name: string, value: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === "production" ? "Secure; " : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; ${secure}Max-Age=${maxAgeSeconds}`;
}

export function clearCookie(name: string): string {
  const secure = process.env.NODE_ENV === "production" ? "Secure; " : "";
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; ${secure}Max-Age=0`;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algo, salt, hashHex] = encoded.split("$");
  if (algo !== "scrypt" || !salt || !hashHex) return false;
  const derived = scryptSync(password, salt, 64).toString("hex");
  return secureCompare(derived, hashHex);
}

export function decodeJwtPayload<T extends Record<string, unknown>>(token: string): T | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(payloadJson) as T;
  } catch {
    return null;
  }
}

export function claimIsTrue(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

export function base64UrlFromBuffer(value: Uint8Array<ArrayBufferLike> | Buffer): string {
  return Buffer.from(value as any).toString("base64url");
}

export function bufferFromBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function normalizeBase64UrlString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function deriveWalletSecretRef(seedPhrase: string, accountId: string, pepper: string): string {
  const digest = createHash("sha256")
    .update(seedPhrase)
    .update(":")
    .update(accountId)
    .update(":")
    .update(pepper)
    .digest("hex");
  return `seed-sha256:${digest}`;
}

export function generateSixDigitCode(): string {
  const value = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return String(value).padStart(6, "0");
}

export function deriveIosDeviceIdFromNodeId(nodeId: string): string | undefined {
  const normalized = String(nodeId).trim().toLowerCase();
  if (!/^ios-|^iphone-/.test(normalized)) return undefined;
  const suffix = normalized.replace(/^ios-|^iphone-/, "").replace(/[^a-z0-9]/g, "");
  return suffix.length >= 6 ? suffix : undefined;
}

export function normalizePasskeyResponsePayload(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const response = source.response && typeof source.response === "object"
    ? { ...(source.response as Record<string, unknown>) }
    : {};
  const normalized: Record<string, unknown> = { ...source };
  const pick =
    normalizeBase64UrlString(source.rawId) ??
    normalizeBase64UrlString(source.credentialId) ??
    normalizeBase64UrlString(source.id);
  if (pick) {
    normalized.id = pick;
    normalized.rawId = pick;
  }
  if (response.clientDataJSON) {
    response.clientDataJSON = normalizeBase64UrlString(response.clientDataJSON) ?? response.clientDataJSON;
  }
  if (response.attestationObject) {
    response.attestationObject = normalizeBase64UrlString(response.attestationObject) ?? response.attestationObject;
  }
  if (response.authenticatorData) {
    response.authenticatorData = normalizeBase64UrlString(response.authenticatorData) ?? response.authenticatorData;
  }
  if (response.signature) {
    response.signature = normalizeBase64UrlString(response.signature) ?? response.signature;
  }
  if (response.userHandle) {
    response.userHandle = normalizeBase64UrlString(response.userHandle) ?? response.userHandle;
  }
  normalized.response = response;
  return normalized;
}

export function deriveCredentialIdFromVerifyBody(body: {
  credentialId?: string;
  response: unknown;
}): string | undefined {
  const fromBody = normalizeBase64UrlString(body.credentialId);
  if (fromBody) return fromBody;
  if (!body.response || typeof body.response !== "object") return undefined;
  const response = body.response as Record<string, unknown>;
  return (
    normalizeBase64UrlString(response.id) ??
    normalizeBase64UrlString(response.rawId) ??
    normalizeBase64UrlString(response.credentialId)
  );
}
