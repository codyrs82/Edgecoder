import Fastify from "fastify";
import { z } from "zod";
import { ProviderRegistry } from "../../model/providers.js";
import { InteractiveAgent } from "../../agent/interactive.js";

const app = Fastify({ logger: true });
const providers = new ProviderRegistry();

const requestSchema = z.object({
  provider: z.enum(["edgecoder-local", "ollama-local"]).default("edgecoder-local"),
  task: z.string().min(1),
  language: z.enum(["python", "javascript"]).default("python")
});

app.get("/models", async () => ({
  providers: ["edgecoder-local", "ollama-local"]
}));

app.post("/run", async (req, reply) => {
  const body = requestSchema.parse(req.body);
  providers.use(body.provider);
  const agent = new InteractiveAgent(providers.current());
  const output = await agent.run(body.task, body.language);
  return reply.send(output);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen({ port: 4304, host: "0.0.0.0" }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

export { app as ideProviderServer };
