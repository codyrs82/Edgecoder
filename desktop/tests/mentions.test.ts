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
