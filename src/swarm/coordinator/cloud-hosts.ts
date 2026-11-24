// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Coordinator side of cloud hosts (src/cloud-host/, docs/cloud-host.md): who may register in the
 * `cloud` class, and who may serve cloud models.
 *
 * A cloud host is paid the cloud model's cost-plus price (src/economy/cloud-pricing.ts) and runs on
 * the platform's provider key, so both are the operator's to grant:
 * - a registration that claims the cloud class (hardwareProfile.cloud) is refused unless the
 *   agent's owner is in CLOUD_HOST_OWNER_EMAILS and an approved host;
 * - cloud model ids are dropped from every other agent's reported models, so no machine can
 *   advertise "glm-5.3" and answer with something else at the cloud price. A cloud host, in turn,
 *   serves only cloud models.
 */
import { cloudModelSpec } from "../../cloud-host/catalog.js";

/** CLOUD_HOST_OWNER_EMAILS: comma-separated, case-insensitive. */
export function parseCloudHostOwners(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes("@"))
  );
}

/** May an agent of this owner register as a cloud host? Needs the allowlist and host approval (unknown approval counts as not refused). */
export function cloudHostAllowed(owners: ReadonlySet<string>, ownerEmail: string | undefined | null, hostApproved: boolean | undefined): boolean {
  if (!ownerEmail || hostApproved === false) return false;
  return owners.has(ownerEmail.trim().toLowerCase());
}

/**
 * The models an agent may advertise: a cloud host only cloud models (normalized to their catalog
 * id), any other agent everything but cloud models.
 */
export function filterCloudModels(models: readonly string[], cloudHost: boolean): string[] {
  if (!cloudHost) return models.filter((m) => !cloudModelSpec(m));
  const out = new Set<string>();
  for (const m of models) {
    const spec = cloudModelSpec(m);
    if (spec) out.add(spec.id);
  }
  return [...out];
}
