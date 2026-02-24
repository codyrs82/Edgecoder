import { describe, expect, test } from "vitest";
import { KeyRotationManager } from "../../src/security/key-rotation.js";
import { generateKeyBundle } from "../../src/security/key-storage.js";

describe("key-rotation", () => {
  test("isRotationDue returns false for fresh bundle", () => {
    const bundle = generateKeyBundle(90);
    const mgr = new KeyRotationManager(bundle, 90, 7);
    expect(mgr.isRotationDue()).toBe(false);
    expect(mgr.isExpired()).toBe(false);
    expect(mgr.daysUntilExpiry()).toBeGreaterThan(80);
  });

  test("isRotationDue returns true within warning window", () => {
    const bundle = generateKeyBundle(90);
    // Simulate key activated 84 days ago (6 days until expiry)
    bundle.currentKey.activatedAt = Date.now() - 84 * 86_400_000;
    bundle.currentKey.expiresAt = bundle.currentKey.activatedAt + 90 * 86_400_000;
    const mgr = new KeyRotationManager(bundle, 90, 7);
    expect(mgr.isRotationDue()).toBe(true);
    expect(mgr.isExpired()).toBe(false);
  });

  test("isExpired returns true past expiry", () => {
    const bundle = generateKeyBundle(90);
    bundle.currentKey.activatedAt = Date.now() - 91 * 86_400_000;
    bundle.currentKey.expiresAt = bundle.currentKey.activatedAt + 90 * 86_400_000;
    const mgr = new KeyRotationManager(bundle, 90, 7);
    expect(mgr.isExpired()).toBe(true);
  });

  test("rotate moves current to previous and generates new", () => {
    const bundle = generateKeyBundle(90);
    const oldPublicKey = bundle.currentKey.publicKeyPem;
    const mgr = new KeyRotationManager(bundle, 90, 7);
    const newBundle = mgr.rotate();

    expect(newBundle.currentKey.publicKeyPem).not.toBe(oldPublicKey);
    expect(newBundle.previousKey).not.toBeNull();
    expect(newBundle.previousKey!.publicKeyPem).toBe(oldPublicKey);
    expect(newBundle.previousKey!.deactivatedAt).toBeLessThanOrEqual(Date.now());
    expect(newBundle.keyId).not.toBe(bundle.keyId);
  });

  test("isGracePeriodActive returns true within 48 hours of rotation", () => {
    const bundle = generateKeyBundle(90);
    const mgr = new KeyRotationManager(bundle, 90, 7);
    const newBundle = mgr.rotate();
    const newMgr = new KeyRotationManager(newBundle, 90, 7);
    expect(newMgr.isGracePeriodActive()).toBe(true);
  });

  test("isGracePeriodActive returns false after 48 hours", () => {
    const bundle = generateKeyBundle(90);
    const mgr = new KeyRotationManager(bundle, 90, 7);
    const newBundle = mgr.rotate();
    // Simulate deactivation 49 hours ago
    newBundle.previousKey!.deactivatedAt = Date.now() - 49 * 3_600_000;
    const newMgr = new KeyRotationManager(newBundle, 90, 7);
    expect(newMgr.isGracePeriodActive()).toBe(false);
  });
});
