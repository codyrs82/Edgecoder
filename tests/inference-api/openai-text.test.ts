import { describe, expect, it } from "vitest";
import { openAiText } from "../../src/inference-api/openai.js";

describe("openAiText", () => {
  it("returns plain string as is", () => {
    expect(openAiText("hello")).toBe("hello");
    expect(openAiText("")).toBe("");
  });

  it("joins array of text parts with newlines", () => {
    expect(openAiText([{ type: "text", text: "hello" }, { type: "text", text: "world" }])).toBe("hello\nworld");
    expect(openAiText([{ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "text", text: "c" }])).toBe("a\nb\nc");
  });

  it("skips non-text parts (image_url) and empty parts", () => {
    expect(openAiText([
      { type: "text", text: "hello" },
      { type: "image_url", image_url: "url1" },
      { type: "text", text: "world" }
    ])).toBe("hello\nworld");

    expect(openAiText([
      { type: "text", text: "" },
      { type: "text", text: "hello" },
      { type: "text", text: "" }
    ])).toBe("hello");

    expect(openAiText([
      { type: "image_url", image_url: "url1" },
      { type: "image_url", image_url: "url2" }
    ])).toBe("");
  });

  it("handles null, undefined, numbers and objects by returning empty string", () => {
    expect(openAiText(null)).toBe("");
    expect(openAiText(undefined)).toBe("");
    expect(openAiText(42)).toBe("");
    expect(openAiText({})).toBe("");
    expect(openAiText([])).toBe("");
  });
});