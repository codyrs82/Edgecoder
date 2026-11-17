// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * A cloud bot's model calls, the way the web chat makes them (routes/chat.ts runWebChat): through
 * the coordinator the capacity directory picks, billed to the bot owner's account, with the run's
 * remaining budget as each call's cSat ceiling. "auto" asks the owner's own online machines first
 * (free) for a model that calls tools, else the network's best fit.
 */

import { networkBackend } from "../../inference-api/backends.js";
import type { ChatBackend } from "../../inference-api/types.js";
import { modelCallsTools } from "../../web-tool/model-support.js";
import { webAvailability, type WebToolCall } from "../../web-tool/tools.js";
import type { ChatCapacityDirectory } from "../chat-capacity.js";
import { accountIdFor, computeLabel, networkTargetFor, portalCoordinatorTransport, portalNetworkDeps, type ChatCompute } from "../routes/compute.js";
import type { CloudInference, CloudWeb } from "./runner.js";

export interface PortalCloudDeps {
  PORTAL_SERVICE_TOKEN: string;
  discoverCoordinatorUrlsForPortal: () => Promise<string[]>;
  capacity: ChatCapacityDirectory;
  ownMachineModels: (userId: string) => Promise<string[]>;
}

/** The chat compute for a bot's compute setting (null: nothing that can call tools). */
export async function resolveCompute(compute: string, userId: string, ownMachineModels: (userId: string) => Promise<string[]>): Promise<ChatCompute | null> {
  if (compute.startsWith("mine:")) return { target: "mine", model: compute.slice(5) };
  if (compute.startsWith("network:")) {
    const m = compute.slice(8);
    return m === "auto" ? { target: "auto" } : { target: "network", model: m, computeClass: "any" };
  }
  const own = await ownMachineModels(userId).catch(() => [] as string[]);
  const tool = own.find((m) => modelCallsTools(m));
  return tool ? { target: "mine", model: tool } : { target: "auto" };
}

export function portalCloudInference(deps: PortalCloudDeps): CloudInference {
  return {
    async open({ userId, compute, maxCSats }) {
      const c = await resolveCompute(compute, userId, deps.ownMachineModels);
      if (!c) return { error: "No model that can use tools is available." };
      const picked =
        c.target === "auto"
          ? await (deps.capacity.pickAutoChoice ? deps.capacity.pickAutoChoice({}) : deps.capacity.pickAuto().then((url) => ({ url, choice: undefined }))).catch(() => ({ url: null, choice: undefined }))
          : c.target === "network"
            ? await deps.capacity.pick({ kind: "network", model: c.model, computeClass: c.computeClass }, [], {}).catch(() => ({ url: null, choice: undefined }))
            : await deps.capacity.pick({ kind: "network", model: c.model }, []).catch(() => ({ url: null, choice: undefined }));
      if (!picked.url) return { error: "No compute is available right now. It tries again on the next run.", code: "no_compute_available" };
      const url = picked.url;
      const accountId = accountIdFor(userId);
      const pinned = portalNetworkDeps({ PORTAL_SERVICE_TOKEN: deps.PORTAL_SERVICE_TOKEN, discoverCoordinatorUrlsForPortal: async () => [url] }, accountId);
      const choice = "choice" in picked ? picked.choice : undefined;
      const backend: ChatBackend = (req, signal) =>
        networkBackend(pinned, {
          ...networkTargetFor(c),
          source: "cloud-bot",
          // Your own machines are free; elsewhere each call may spend at most what the run has left.
          ...(c.target === "mine" ? {} : { routing: { ...(c.target === "auto" ? { job: "agentic" as const, needsTools: true } : {}), maxCSats: Math.max(0.01, maxCSats()) } }),
          ...(choice ? { coordinatorChoice: choice } : {}),
        })(req, signal);
      return { backend, where: computeLabel(c) };
    },
  };
}

export function portalCloudWeb(deps: Pick<PortalCloudDeps, "PORTAL_SERVICE_TOKEN" | "discoverCoordinatorUrlsForPortal">): CloudWeb {
  const call = (userId: string): WebToolCall => {
    const accountId = accountIdFor(userId);
    const t = portalCoordinatorTransport(deps, accountId);
    return (path, payload, signal) => t("POST", path, { ...payload, accountId }, signal);
  };
  return { call, available: (userId) => webAvailability(call(userId), accountIdFor(userId)) };
}
