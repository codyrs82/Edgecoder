import { inferenceService } from "./inference/service.js";
import { coordinatorServer } from "./swarm/coordinator.js";
import { controlPlaneServer } from "./control-plane/server.js";
import { ProviderRegistry } from "./model/providers.js";
import { InteractiveAgent } from "./agent/interactive.js";

async function boot(): Promise<void> {
  await Promise.all([
    inferenceService.listen({ port: 4302, host: "0.0.0.0" }),
    coordinatorServer.listen({ port: 4301, host: "0.0.0.0" }),
    controlPlaneServer.listen({ port: 4303, host: "0.0.0.0" })
  ]);

  // Demonstrate interactive path bootstrapping using default provider.
  const providers = new ProviderRegistry();
  const agent = new InteractiveAgent(providers.current());
  const sample = await agent.run("Print hello world", "python");
  console.log(JSON.stringify({ bootSample: sample.runResult.ok }, null, 2));
}

boot().catch((error) => {
  console.error(error);
  process.exit(1);
});
