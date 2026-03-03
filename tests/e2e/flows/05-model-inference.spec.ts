import { test, expect } from "@playwright/test";

const OLLAMA_URL = process.env.E2E_OLLAMA_URL ?? "http://localhost:11434";

test.describe("Model Inference", () => {
  test("Ollama has tinyllama model available", async () => {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    expect(res.ok).toBeTruthy();
    const body = await res.json();
    const models = body.models ?? [];
    const hasTinyllama = models.some((m: any) =>
      m.name.toLowerCase().includes("tinyllama")
    );
    expect(hasTinyllama).toBe(true);
  });

  test("Ollama generates a response directly", async () => {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "tinyllama",
        prompt: "Say hello in one word.",
        stream: false,
      }),
    });
    expect(res.ok).toBeTruthy();
    const body = await res.json();
    expect(body.response).toBeTruthy();
    expect(body.response.length).toBeGreaterThan(0);
  });

  test("Ollama /api/tags lists available models", async () => {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    expect(res.ok).toBeTruthy();
    const body = await res.json();
    expect(body.models).toBeTruthy();
    expect(body.models.length).toBeGreaterThan(0);
  });

  test(
    "Ollama chat completion returns a response",
    async () => {
      const res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "tinyllama",
          messages: [{ role: "user", content: "Reply with exactly: hello world" }],
          stream: false,
        }),
      });
      expect(res.ok).toBeTruthy();
      const body = await res.json();
      expect(body.choices).toBeTruthy();
      expect(body.choices.length).toBeGreaterThan(0);
      expect(body.choices[0].message.content.length).toBeGreaterThan(0);
    },
    { timeout: 90_000 }
  );
});
