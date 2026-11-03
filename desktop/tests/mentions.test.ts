import { describe, expect, it } from "vitest";
import { mentionedPaths } from "../src/lib/mentions";

describe("mentionedPaths", () => {
  it("finds @paths, folders and trims trailing punctuation", () => {
    expect(mentionedPaths("look at @src/lib/api.ts, and @src/pages/ please")).toEqual(["src/lib/api.ts", "src/pages/"]);
  });
  it("ignores emails and repeats", () => {
    expect(mentionedPaths("mail me at cody@example.com about @a.ts and @a.ts")).toEqual(["a.ts"]);
  });
});

describe("mentionSuggestions", () => {
  it("offers @codebase first while the query fits it", async () => {
    const { mentionSuggestions } = await import("../src/lib/mentions");
    const find = async () => [{ path: "src/a.ts", kind: "file" as const }];
    expect((await mentionSuggestions("", find))[0]).toEqual({ path: "codebase", kind: "codebase" });
    expect((await mentionSuggestions("cod", find)).map((m) => m.path)).toEqual(["codebase", "src/a.ts"]);
    expect((await mentionSuggestions("src", find)).map((m) => m.path)).toEqual(["src/a.ts"]);
  });
});
