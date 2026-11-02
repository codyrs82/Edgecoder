import { describe, expect, it } from "vitest";
import { isBuildRequest } from "../src/lib/project-mode";

describe("isBuildRequest", () => {
  it("recognises requests to build something", () => {
    for (const t of ["Lets build a new webpage", "make a snake game in JS", "Create a todo app with React", "write a python script that renames photos"]) {
      expect(isBuildRequest(t), t).toBe(true);
    }
  });
  it("leaves questions and chat alone", () => {
    for (const t of ["How do I build a website?", "what is a closure", "thanks!", "explain this error"]) {
      expect(isBuildRequest(t), t).toBe(false);
    }
  });
});
