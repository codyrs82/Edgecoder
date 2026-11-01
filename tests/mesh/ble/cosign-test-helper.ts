import { createHash } from "node:crypto";
import type { BLETaskResponse } from "../../../src/common/types.js";
import { BleProviderCoSigner } from "../../../src/mesh/ble/ble-cosign.js";
import type { MockBLETransport } from "../../../src/mesh/ble/ble-transport.js";
import { createPeerKeys } from "../../../src/mesh/peer.js";

export type PeerKeys = ReturnType<typeof createPeerKeys>;

export interface MockProviderOptions {
  agentId: string;
  /** Must match what the transport advertises (the requester prices against it). */
  modelParamSize: number;
  cpuSeconds: number;
  output?: string;
  generatedCode?: string;
  keys?: PeerKeys;
  /** Per-call override of the task response (e.g. to simulate failures). */
  respond?: (req: { requestId: string; requesterId: string; task: string }) => Partial<BLETaskResponse> | undefined;
}

/**
 * #63: wire a MockBLETransport as a co-signing provider the way worker-runner
 * does: completed tasks are remembered, and co-sign requests matching what was
 * served get the provider's v3 signature.
 */
export function attachMockProvider(transport: MockBLETransport, opts: MockProviderOptions) {
  const keys = opts.keys ?? createPeerKeys();
  const coSigner = new BleProviderCoSigner({
    agentId: opts.agentId,
    accountId: opts.agentId,
    privateKeyPem: keys.privateKeyPem,
    modelParamSize: () => opts.modelParamSize
  });
  const served: Array<{ requestId: string; taskHash: string; cpuSeconds: number }> = [];
  const coSignRequests: unknown[] = [];
  transport.onTaskRequest(async (req) => {
    const override = opts.respond?.(req);
    const response: BLETaskResponse = {
      requestId: req.requestId,
      providerId: opts.agentId,
      status: "completed",
      output: opts.output ?? "ok",
      ...(opts.generatedCode ? { generatedCode: opts.generatedCode } : {}),
      cpuSeconds: opts.cpuSeconds,
      providerSignature: "",
      ...override
    };
    if (response.status === "completed") {
      const taskHash = createHash("sha256").update(req.task).digest("hex");
      coSigner.recordServed({ requestId: req.requestId, requesterId: req.requesterId, taskHash, cpuSeconds: response.cpuSeconds });
      served.push({ requestId: req.requestId, taskHash, cpuSeconds: response.cpuSeconds });
    }
    return response;
  });
  transport.onCoSignRequest((req) => {
    coSignRequests.push(req);
    return coSigner.handle(req);
  });
  return { keys, coSigner, served, coSignRequests };
}
