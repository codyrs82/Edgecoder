import { inferenceService } from "./inference/service.js";
import { coordinatorServer } from "./swarm/coordinator.js";
import { controlPlaneServer } from "./control-plane/server.js";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { hostname } from "node:os";

const INFERENCE_PORT = Number(process.env.INFERENCE_PORT) || 4302;
const COORDINATOR_PORT = Number(process.env.COORDINATOR_PORT) || 4301;
const CONTROL_PLANE_PORT = Number(process.env.CONTROL_PLANE_PORT) || 4303;

function isEaddrInUse(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err && (err as NodeJS.ErrnoException).code === "EADDRINUSE";
}

function helpForPorts(): string {
  return `One of the EdgeCoder ports is already in use (inference: ${INFERENCE_PORT}, coordinator: ${COORDINATOR_PORT}, control-plane: ${CONTROL_PLANE_PORT}).\nStop other EdgeCoder processes (e.g. another "npm run dev" or separate dev:inference/coordinator/control) or free the port:\n  lsof -i :${INFERENCE_PORT} -i :${COORDINATOR_PORT} -i :${CONTROL_PLANE_PORT}\n  kill <pid>`;
}

function startWorkerProcess(): void {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const workerScript = join(__dirname, "swarm", "worker-runner.js");

  const agentId = process.env.AGENT_ID || `node-${hostname().slice(0, 8)}`;
  const coordinatorUrl = `http://127.0.0.1:${COORDINATOR_PORT}`;

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    AGENT_ID: agentId,
    COORDINATOR_URL: coordinatorUrl,
    AGENT_MODE: process.env.AGENT_MODE ?? "swarm-only",
    AGENT_OS: process.env.AGENT_OS ?? "macos",
    LOCAL_MODEL_PROVIDER: process.env.LOCAL_MODEL_PROVIDER ?? "edgecoder-local",
  };

  // Forward optional env vars if set
  for (const key of [
    "OLLAMA_MODEL", "OLLAMA_HOST", "OLLAMA_AUTO_INSTALL",
    "AGENT_REGISTRATION_TOKEN", "MESH_AUTH_TOKEN",
    "MAX_CONCURRENT_TASKS", "AGENT_CLIENT_TYPE", "AGENT_DEVICE_ID",
    "CONTROL_PLANE_URL", "COORDINATOR_DISCOVERY_URL"
  ]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }

  const child = fork(workerScript, [], {
    env,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  child.on("exit", (code) => {
    console.warn(`[unified-agent] worker process exited (code=${code}), restarting in 5s...`);
    setTimeout(startWorkerProcess, 5000);
  });

  child.unref();
  console.log(`[unified-agent] worker started as pid=${child.pid} (agent=${agentId}, coordinator=${coordinatorUrl})`);
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

  console.log(`[unified-agent] coordinator=:${COORDINATOR_PORT} inference=:${INFERENCE_PORT} control-plane=:${CONTROL_PLANE_PORT}`);

  // Start embedded worker — every node contributes compute to the mesh
  startWorkerProcess();
}

boot().catch((error) => {
  if (isEaddrInUse(error)) {
    console.error(helpForPorts());
  } else {
    console.error(error);
  }
  process.exit(1);
});
