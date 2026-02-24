import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { KeyBundle } from "./key-storage.js";

const GRACE_PERIOD_MS = 48 * 3_600_000; // 48 hours

export class KeyRotationManager {
  constructor(
    private bundle: KeyBundle,
    private rotationDays: number,
    private warningDays: number
  ) {}

  daysUntilExpiry(): number {
    return (this.bundle.currentKey.expiresAt - Date.now()) / 86_400_000;
  }

  isRotationDue(): boolean {
    return this.daysUntilExpiry() <= this.warningDays;
  }

  isExpired(): boolean {
    return Date.now() > this.bundle.currentKey.expiresAt;
  }

  isGracePeriodActive(): boolean {
    if (!this.bundle.previousKey) return false;
    return Date.now() - this.bundle.previousKey.deactivatedAt < GRACE_PERIOD_MS;
  }

  rotate(): KeyBundle {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const now = Date.now();
    return {
      currentKey: {
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
        activatedAt: now,
        expiresAt: now + this.rotationDays * 86_400_000,
      },
      previousKey: {
        privateKeyPem: this.bundle.currentKey.privateKeyPem,
        publicKeyPem: this.bundle.currentKey.publicKeyPem,
        activatedAt: this.bundle.currentKey.activatedAt,
        deactivatedAt: now,
      },
      keyId: randomUUID(),
    };
  }
}
