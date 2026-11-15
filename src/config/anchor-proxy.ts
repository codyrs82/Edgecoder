// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import { envEnum, envNumber, envPort } from "../common/config.js";
import { observabilityEnv, serviceUrlsEnv } from "./shared.js";

/** The BitcoinNetwork values (src/common/types.ts). */
export const BITCOIN_NETWORKS = ["bitcoin", "testnet", "signet", "regtest"] as const;

const required = () => z.string({ message: "is required" });

/*
 * #15: anchor proxy (src/economy/anchor-proxy-service.ts, port 4311). The token and the three
 * bitcoind RPC settings were already required (the service printed FATAL and exited without
 * them); they are required fields here, so a missing one is reported with the other problems.
 */
export const anchorProxyConfigSchema = z.object({
  ...observabilityEnv,
  ...serviceUrlsEnv,
  ANCHOR_PROXY_PORT: envPort(4311),
  ANCHOR_PROXY_TOKEN: required(),
  BITCOIND_RPC_URL: z.url({ protocol: /^https?$/, message: "is required and must be an http(s) URL" }),
  BITCOIND_RPC_USER: required(),
  BITCOIND_RPC_PASSWORD: required(),
  BITCOIND_WALLET_NAME: z.string().default(""),
  BITCOIN_NETWORK: envEnum(BITCOIN_NETWORKS).default("signet"),
  MAX_BROADCASTS_PER_MINUTE: envNumber(10, { min: 0 }),
  MAX_RECONCILE_CALLS_PER_MINUTE: envNumber(30, { min: 0 })
});

export type AnchorProxyConfig = z.infer<typeof anchorProxyConfigSchema>;
