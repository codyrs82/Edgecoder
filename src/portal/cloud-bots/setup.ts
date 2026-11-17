// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/** Cloud bots for the portal server (docs/cloud-bots.md): the API service and the runner, or nulls without a database. */

import type { Pool } from "pg";
import type { ChatCapacityDirectory } from "../chat-capacity.js";
import { CloudBotService } from "../routes/cloud-bots.js";
import { portalCloudInference, portalCloudWeb } from "./inference.js";
import { CloudBotRunner } from "./runner.js";
import { BotSecrets } from "./secrets.js";
import { PgCloudBotStore } from "./store.js";

export function createCloudBots(deps: {
  pool: Pool | null;
  PORTAL_SERVICE_TOKEN: string;
  discoverCoordinatorUrlsForPortal: () => Promise<string[]>;
  capacity: ChatCapacityDirectory;
  ownMachineModels: (userId: string) => Promise<string[]>;
  log: { info: (o: object, msg: string) => void; warn: (o: object, msg: string) => void };
  env?: Record<string, string | undefined>;
}): { service: CloudBotService | null; runner: CloudBotRunner | null } {
  if (!deps.pool) return { service: null, runner: null };
  const env = deps.env ?? process.env;
  const store = new PgCloudBotStore(deps.pool);
  // PORTAL_BOT_SECRETS_KEY seals their GitHub tokens; unset: GitHub is off for cloud bots.
  const secrets = BotSecrets.fromEnv(env);
  const runner = new CloudBotRunner({
    store,
    secrets,
    inference: portalCloudInference({ PORTAL_SERVICE_TOKEN: deps.PORTAL_SERVICE_TOKEN, discoverCoordinatorUrlsForPortal: deps.discoverCoordinatorUrlsForPortal, capacity: deps.capacity, ownMachineModels: deps.ownMachineModels }),
    web: portalCloudWeb({ PORTAL_SERVICE_TOKEN: deps.PORTAL_SERVICE_TOKEN, discoverCoordinatorUrlsForPortal: deps.discoverCoordinatorUrlsForPortal }),
    log: { info: (o, m) => deps.log.info(o, m), warn: (o, m) => deps.log.warn(o, m) },
  });
  const max = Number(env.CLOUD_BOTS_MAX_PER_ACCOUNT);
  const service = new CloudBotService({ store, secrets, runner, maxBotsPerAccount: max > 0 ? max : 20 });
  return { service, runner };
}
