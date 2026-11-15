// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import { envEnum, envFlag, envPort, envUrl } from "../common/config.js";

const str = () => z.string().optional();

/*
 * #15: the all-in-one entry (src/index.ts): inference, coordinator and control plane in one
 * process, plus a forked worker and IDE provider. Each of those validates its own schema; this
 * one covers what the entry itself reads (ports, and what it hands to the worker).
 */
export const allInOneConfigSchema = z.object({
  // 0 means "use the default", as before.
  INFERENCE_PORT: envPort(4302),
  COORDINATOR_PORT: envPort(4301),
  CONTROL_PLANE_PORT: envPort(4303),
  LOCAL_FORWARD_PORT: envPort(4305),
  /** Set by the desktop app once this machine is enrolled; the worker then joins that coordinator. */
  AGENT_NETWORK_COORDINATOR_URL: envUrl(),
  /** Unset: Ollama when it answers on this machine, else the edgecoder-local stub. */
  LOCAL_MODEL_PROVIDER: envEnum(["edgecoder-local", "ollama-local"]).optional(),
  OLLAMA_HOST: envUrl("http://127.0.0.1:11434"),
  AGENT_ID: str(),
  AGENT_MODE: envEnum(["swarm-only", "ide-enabled"]).default("swarm-only"),
  AGENT_OS: z.string().default("macos"),
  DISABLE_SELF_AGENT: envFlag({ on: ["1"] }),
  DISABLE_IDE_PROVIDER: envFlag({ on: ["1"] })
});

export type AllInOneConfig = z.infer<typeof allInOneConfigSchema>;

/**
 * The `edgecoder` launcher (src/cli/edgecoder.ts). It checks EDGE_RUNTIME_MODE against its role
 * table and exits with the list of roles, so the value is only declared here.
 */
export const launcherConfigSchema = z.object({
  EDGE_RUNTIME_MODE: str()
});
