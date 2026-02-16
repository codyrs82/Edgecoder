import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const app = Fastify({ logger: true });

const reviewSchema = z.object({
  task: z.string(),
  snippet: z.string().optional(),
  error: z.string().optional(),
  queueReason: z.enum(["outside_subset", "timeout", "model_limit", "manual"])
});

type ReviewRecord = {
  reviewId: string;
  status: "queued" | "ready";
  createdAt: number;
  result?: {
    diff: string;
    summary: string;
  };
};

const reviews = new Map<string, ReviewRecord>();

app.post("/review", async (req, reply) => {
  const body = reviewSchema.parse(req.body);
  const reviewId = randomUUID();
  reviews.set(reviewId, {
    reviewId,
    status: "queued",
    createdAt: Date.now()
  });

  // Simulate asynchronous cloud completion.
  setTimeout(() => {
    const existing = reviews.get(reviewId);
    if (!existing) return;
    existing.status = "ready";
    existing.result = {
      diff: `--- original\n+++ improved\n@@\n-${body.snippet ?? "code"}\n+// improved\n`,
      summary: "Cloud review completed with suggested improvements."
    };
    reviews.set(reviewId, existing);
  }, 2000);

  return reply.send({ reviewId });
});

app.get("/review/:reviewId", async (req, reply) => {
  const params = z.object({ reviewId: z.string() }).parse(req.params);
  const record = reviews.get(params.reviewId);
  if (!record) return reply.code(404).send({ error: "review_not_found" });
  return reply.send(record);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen({ port: 4305, host: "0.0.0.0" }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

export { app as cloudReviewMockServer };
