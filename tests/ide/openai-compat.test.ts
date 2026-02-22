import { describe, expect, it } from "vitest";
import {
  parseOpenAiRequest,
  formatOpenAiResponse,
  formatOpenAiStreamChunk,
  formatOpenAiModelsResponse
} from "../../src/apps/ide/openai-compat.js";

describe("OpenAI compat: parseOpenAiRequest", () => {
  it("extracts task from chat messages", () => {
    const result = parseOpenAiRequest({
      model: "edgecoder",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Write a fibonacci function in python" }
      ]
    });
    expect(result.task).toContain("fibonacci");
    expect(result.model).toBe("edgecoder");
  });

  it("detects streaming preference", () => {
    const result = parseOpenAiRequest({
      model: "edgecoder",
      messages: [{ role: "user", content: "hello" }],
      stream: true
    });
    expect(result.stream).toBe(true);
  });
});

describe("OpenAI compat: formatOpenAiResponse", () => {
  it("formats a non-streaming response", () => {
    const response = formatOpenAiResponse("req-1", "edgecoder", "print('hello')");
    expect(response.id).toBe("req-1");
    expect(response.object).toBe("chat.completion");
    expect(response.choices[0].message.content).toBe("print('hello')");
    expect(response.choices[0].finish_reason).toBe("stop");
  });
});

describe("OpenAI compat: formatOpenAiStreamChunk", () => {
  it("formats a streaming SSE chunk", () => {
    const chunk = formatOpenAiStreamChunk("req-1", "edgecoder", "partial");
    expect(chunk.id).toBe("req-1");
    expect(chunk.object).toBe("chat.completion.chunk");
    expect(chunk.choices[0].delta.content).toBe("partial");
  });
});

describe("OpenAI compat: formatOpenAiModelsResponse", () => {
  it("lists available models", () => {
    const response = formatOpenAiModelsResponse(["edgecoder-local", "ollama-edge"]);
    expect(response.object).toBe("list");
    expect(response.data.length).toBe(2);
    expect(response.data[0].id).toBe("edgecoder-local");
    expect(response.data[0].object).toBe("model");
  });
});
