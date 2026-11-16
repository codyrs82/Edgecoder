// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { z } from "zod";
import { controlPlaneConfigSchema } from "../control-plane/config.js";
import { inferenceConfigSchema } from "../inference/config.js";
import { portalConfigSchema } from "../portal/config.js";
import { coordinatorConfigSchema } from "../swarm/coordinator-config.js";
import { allInOneConfigSchema, launcherConfigSchema } from "./all-in-one.js";
import { anchorProxyConfigSchema } from "./anchor-proxy.js";
import { ideProviderConfigSchema } from "./ide-provider.js";
import { workerConfigSchema } from "./worker.js";

/*
 * #15: every environment variable a service reads is declared in one of these schemas. Each
 * service loads its own at startup with loadConfigOrExit() (src/common/config.ts); shared groups
 * of variables are in ./shared.ts.
 *
 * tests/common/env-docs.test.ts keeps three things in step: these schemas, the tables in
 * site-docs/reference/environment-variables.md, and the `process.env` reads in src/.
 */
export const SERVICE_SCHEMAS = {
  coordinator: coordinatorConfigSchema,
  portal: portalConfigSchema,
  inference: inferenceConfigSchema,
  "control-plane": controlPlaneConfigSchema,
  "anchor-proxy": anchorProxyConfigSchema,
  worker: workerConfigSchema,
  "ide-provider": ideProviderConfigSchema,
  "all-in-one": allInOneConfigSchema,
  launcher: launcherConfigSchema
} as const;

export type ServiceName = keyof typeof SERVICE_SCHEMAS;

/** Variable names a service's schema declares. */
export function schemaVariableNames(service: ServiceName): string[] {
  return Object.keys((SERVICE_SCHEMAS[service] as z.ZodObject).shape).sort();
}

/** Every declared variable name, across all services. */
export function allSchemaVariableNames(): string[] {
  const names = new Set<string>();
  for (const service of Object.keys(SERVICE_SCHEMAS) as ServiceName[]) {
    for (const name of schemaVariableNames(service)) names.add(name);
  }
  return [...names].sort();
}

export {
  allInOneConfigSchema,
  anchorProxyConfigSchema,
  controlPlaneConfigSchema,
  coordinatorConfigSchema,
  ideProviderConfigSchema,
  inferenceConfigSchema,
  launcherConfigSchema,
  portalConfigSchema,
  workerConfigSchema
};
