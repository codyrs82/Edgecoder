import { describe, expect, it } from "vitest";
import { attachmentLabel, attachmentsText, classify, visionFor, visionNote } from "../src/lib/attachments";
import { botPlacement } from "../src/lib/bots";
import type { IdeStreamEvent } from "../src/lib/api";

describe("attachments", () => {
  it("classifies images, PDFs and text/code by type or extension", () => {
    expect(classify({ name: "a.png", type: "image/png" })).toBe("image");
    expect(classify({ name: "r.pdf", type: "" })).toBe("pdf");
    expect(classify({ name: "main.rs", type: "" })).toBe("text");
    expect(classify({ name: "Dockerfile", type: "" })).toBe("text");
    expect(classify({ name: "a.exe", type: "application/octet-stream" })).toBeNull();
    expect(classify({ name: "a.svg", type: "image/svg+xml" })).toBeNull();
  });

  it("only a frontier lead sees images (Anthropic also PDFs); Auto and network models don't", () => {
    expect(visionFor("frontier/anthropic/claude-opus-5-5")).toEqual({ images: true, pdf: true });
    expect(visionFor("frontier/openai/gpt-5")).toEqual({ images: true, pdf: false });
    expect(visionFor("network/qwen3-coder:30b@gpu")).toEqual({ images: false, pdf: false });
    expect(visionFor("auto")).toEqual({ images: false, pdf: false });
    expect(visionFor(undefined)).toEqual({ images: false, pdf: false });
  });

  it("says plainly what a model can't see", () => {
    expect(visionNote([{ kind: "text" }], visionFor(undefined))).toBeNull();
    expect(visionNote([{ kind: "image" }], visionFor(undefined))).toBe("This model can't see images; it gets the file name instead.");
    expect(visionNote([{ kind: "image" }, { kind: "pdf" }], visionFor("frontier/openai/gpt-5"))).toBe("This model can't see PDFs; it gets the file name instead.");
    expect(visionNote([{ kind: "image" }], visionFor("frontier/anthropic/claude-opus-5-5"))).toBeNull();
  });

  it("inlines text files and names images it can't see", () => {
    const text = attachmentsText(
      [
        { name: "a.md", kind: "text", mediaType: "text/markdown", size: 9, text: "has ``` in it" },
        { name: "s.png", kind: "image", mediaType: "image/png", size: 2048, data: "AAAA" },
      ],
      visionFor(undefined),
    );
    expect(text).toContain("Attached file a.md:\n````\nhas ``` in it\n````");
    expect(text).toContain("[Attached image s.png, 2 KB. You can't see its contents");
    expect(attachmentLabel([{ name: "a.md", kind: "text" }, { name: "s.png", kind: "image" }])).toBe("[Attached: a.md, s.png]");
  });
});

describe("botPlacement: where a bot's step runs", () => {
  const usage = (served: Record<string, unknown>, model?: string) => ({ type: "usage", cSats: 0, where: "x", ...(model ? { model } : {}), served }) as unknown as IdeStreamEvent;
  const base = { tier: null, region: null, country: null };

  it("before a call answers: the route Auto picked", () => {
    expect(botPlacement([{ type: "status", message: "Compute: this computer · qwen3.5:9b · ran on a smaller local model (no cSats)" } as IdeStreamEvent])).toBe("This computer · qwen3.5:9b");
  });

  it("this computer and your own machines are free; the network shows cSats; your key shows the model", () => {
    expect(botPlacement([usage({ ...base, label: "This computer", own: true, computeClass: "local", hardware: "This computer (Apple M1 Max)" }, "qwen3-coder:30b")])).toBe("This computer (Apple M1 Max) · qwen3-coder:30b · free");
    expect(botPlacement([usage({ ...base, label: "your machine (Mac)", own: true, computeClass: "apple", hardware: "Apple Silicon" }, "mine/qwen3-coder:30b")])).toBe("Your machine (Mac) · Apple Silicon · qwen3-coder:30b · free");
    expect(botPlacement([usage({ ...base, label: "lin-•••3f2a", own: false, computeClass: "gpu.dc", hardware: "Datacenter GPU (gpu.dc40)", gpu: "2× NVIDIA A16" }, "network/qwen3-coder:30b@gpu.dc")], 3.4)).toBe("Network · Datacenter GPU 2×A16 · qwen3-coder:30b · 3.4 cSats");
    expect(botPlacement([usage({ ...base, label: "Anthropic", own: true, computeClass: "frontier", hardware: "Anthropic · your key" }, "frontier/anthropic/claude-opus-5-5")])).toBe("Claude Opus 5.5 · your key");
  });

  it("nothing yet: null", () => {
    expect(botPlacement([])).toBeNull();
  });
});
