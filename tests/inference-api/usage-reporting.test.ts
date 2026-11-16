// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from "vitest";
import { anthropicResponse, anthropicStream } from "../../src/inference-api/anthropic.js";
import { openAiResponse, openAiStream, openAiUsage } from "../../src/inference-api/openai.js";
import type { ChatPiece } from "../../src/inference-api/types.js";

// API clients track spend from `usage`; it reported prompt_tokens 0 on every network call even
// though billing used the model's real counts (found on the regtest network, 2026-11-15).
async function* pieces(done: Extract<ChatPiece, { done: true }>): AsyncGenerator<ChatPiece> {
  yield { delta: "def sq(n):" };
  yield { delta: " return n*n" };
  yield done;
}
const billed = { done: true as const, cSatsSpent: 0.009, promptTokens: 46, outputTokens: 12 };
const unknown = { done: true as const, cSatsSpent: 0.009 };
const textLen = "def sq(n): return n*n".length;

async function lastData(stream: AsyncIterable<string>) {
  const events: string[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

describe("OpenAI-compatible usage", () => {
  it("whole reply: reports the billed counts", async () => {
    const r = await openAiResponse(pieces(billed), "network/m");
    expect(r.usage).toEqual({ prompt_tokens: 46, completion_tokens: 12, total_tokens: 58 });
  });
  it("whole reply: falls back to an output estimate when counts are unknown", async () => {
    const r = await openAiResponse(pieces(unknown), "network/m");
    expect(r.usage).toEqual(openAiUsage(undefined, textLen));
    expect(r.usage.prompt_tokens).toBe(0);
  });
  it("stream: the final chunk carries usage", async () => {
    const events = await lastData(openAiStream(pieces(billed), "network/m"));
    const final = JSON.parse(events.at(-2)!.replace(/^data: /, ""));
    expect(final.choices[0].finish_reason).toBe("stop");
    expect(final.usage).toEqual({ prompt_tokens: 46, completion_tokens: 12, total_tokens: 58 });
    expect(final.edgecoder.cSatsSpent).toBe(0.009);
  });
});

describe("Anthropic-compatible usage", () => {
  it("whole reply: reports the billed counts", async () => {
    const r = await anthropicResponse(pieces(billed), "network/m");
    expect(r.usage).toEqual({ input_tokens: 46, output_tokens: 12 });
  });
  it("stream: message_delta carries input and output tokens", async () => {
    const events = await lastData(anthropicStream(pieces(billed), "network/m"));
    const delta = events.find((e) => e.startsWith("event: message_delta"))!;
    const data = JSON.parse(delta.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
    expect(data.usage).toEqual({ input_tokens: 46, output_tokens: 12 });
  });
});
