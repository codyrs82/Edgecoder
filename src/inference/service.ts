import Fastify from "fastify";
import { z } from "zod";

const app = Fastify({ logger: true });

const decomposeSchema = z.object({
  taskId: z.string(),
  prompt: z.string().min(1),
  snapshotRef: z.string().min(1),
  language: z.enum(["python", "javascript"]).default("python")
});

app.post("/decompose", async (req, reply) => {
  const parsed = decomposeSchema.parse(req.body);
  const chunks = parsed.prompt
    .split(/[.?!]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5);

  const subtasks = chunks.map((chunk, idx) => ({
    taskId: parsed.taskId,
    kind: "micro_loop" as const,
    input: chunk,
    language: parsed.language,
    timeoutMs: 4000 + idx * 1000,
    snapshotRef: parsed.snapshotRef
  }));

  return reply.send({ subtasks });
});

app.get("/health", async () => ({ ok: true }));

if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen({ port: 4302, host: "0.0.0.0" }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

export { app as inferenceService };
