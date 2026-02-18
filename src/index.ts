import { inferenceService } from "./inference/service.js";
import { coordinatorServer } from "./swarm/coordinator.js";
import { controlPlaneServer } from "./control-plane/server.js";
import { ProviderRegistry } from "./model/providers.js";
import { InteractiveAgent } from "./agent/interactive.js";

const INFERENCE_PORT = Number(process.env.INFERENCE_PORT) || 4302;
const COORDINATOR_PORT = Number(process.env.COORDINATOR_PORT) || 4301;
const CONTROL_PLANE_PORT = Number(process.env.CONTROL_PLANE_PORT) || 4303;

function isEaddrInUse(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err && (err as NodeJS.ErrnoException).code === "EADDRINUSE";
}

function helpForPorts(): string {
  return `One of the EdgeCoder ports is already in use (inference: ${INFERENCE_PORT}, coordinator: ${COORDINATOR_PORT}, control-plane: ${CONTROL_PLANE_PORT}).\nStop other EdgeCoder processes (e.g. another "npm run dev" or separate dev:inference/coordinator/control) or free the port:\n  lsof -i :${INFERENCE_PORT} -i :${COORDINATOR_PORT} -i :${CONTROL_PLANE_PORT}\n  kill <pid>`;
}

async function boot(): Promise<void> {
  try {
    await Promise.all([
      inferenceService.listen({ port: INFERENCE_PORT, host: "0.0.0.0" }),
      coordinatorServer.listen({ port: COORDINATOR_PORT, host: "0.0.0.0" }),
      controlPlaneServer.listen({ port: CONTROL_PLANE_PORT, host: "0.0.0.0" })
    ]);
  } catch (err) {
    if (isEaddrInUse(err)) {
      console.error(helpForPorts());
      process.exit(1);
    }
    throw err;
  }

  // Demonstrate interactive path bootstrapping using default provider.
  const providers = new ProviderRegistry();
  const agent = new InteractiveAgent(providers.current());
  const sample = await agent.run("Print hello world", "python");
  console.log(JSON.stringify({ bootSample: sample.runResult.ok }, null, 2));
}

boot().catch((error) => {
  if (isEaddrInUse(error)) {
    console.error(helpForPorts());
  } else {
    console.error(error);
  }
  process.exit(1);
});
