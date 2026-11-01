#!/usr/bin/env node
// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * One entry point, every role (docs/packages.md). `edgecoder <role>` or EDGE_RUNTIME_MODE=<role>:
 *   agent          compute agent (sells CPU/GPU seconds)            -> dist/swarm/worker-runner.js
 *   coordinator    coordinator only                                  -> dist/swarm/coordinator.js
 *   all-in-one     coordinator + inference + control plane + portal  -> dist/index.js
 *   portal         web portal only                                   -> dist/portal/server.js
 *   control-plane, inference, ide-provider                           -> their services
 *   install        the installer (edgecoder-install)                 -> dist/install/cli.js
 * The Docker image, the systemd/launchd/scheduled-task services and the npm bins all go through
 * this dispatcher, so a role behaves the same wherever it runs.
 */
import { fileURLToPath } from "node:url";

export const ROLES = {
  agent: "../swarm/worker-runner.js",
  worker: "../swarm/worker-runner.js",
  coordinator: "../swarm/coordinator.js",
  "all-in-one": "../index.js",
  portal: "../portal/server.js",
  "control-plane": "../control-plane/server.js",
  inference: "../inference/service.js",
  "ide-provider": "../apps/ide/provider-server.js",
  install: "../install/cli.js"
} as const;
export type Role = keyof typeof ROLES;

export function resolveRole(argv: string[], env: NodeJS.ProcessEnv): { role: Role; rest: string[] } | { error: string } {
  const first = argv[0];
  if (first && !first.startsWith("-")) {
    if (first in ROLES) return { role: first as Role, rest: argv.slice(1) };
    return { error: `unknown role "${first}"; roles: ${Object.keys(ROLES).join(", ")}` };
  }
  const fromEnv = env.EDGE_RUNTIME_MODE ?? "all-in-one";
  if (fromEnv in ROLES) return { role: fromEnv as Role, rest: argv };
  return { error: `EDGE_RUNTIME_MODE="${fromEnv}" is not a role; roles: ${Object.keys(ROLES).join(", ")}` };
}

async function main(): Promise<void> {
  const resolved = resolveRole(process.argv.slice(2), process.env);
  if ("error" in resolved) {
    console.error(resolved.error);
    process.exit(2);
  }
  if (resolved.role === "install") {
    const { runInstaller } = await import("../install/cli.js");
    process.exit(runInstaller(resolved.rest));
  }
  // The services only start when they are the main script (import.meta.url === file://argv[1]).
  const target = fileURLToPath(new URL(ROLES[resolved.role], import.meta.url));
  process.argv = [process.argv[0], target, ...resolved.rest];
  await import(ROLES[resolved.role]);
}

const invokedDirectly = process.argv[1] && /edgecoder(-[a-z-]+)?\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) void main();
