import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOST_AGREEMENT_VERSION, NOTICES, TERMS_VERSION, hostAgreementVersionIsCurrent, termsVersionIsCurrent } from "../../src/common/legal-notices.js";
import { hostAgreementLine } from "../../src/install/cli.js";

describe("legal notices", () => {
  it("the desktop copy is byte-identical", () => {
    expect(readFileSync("desktop/src/lib/legal-notices.ts", "utf8")).toBe(readFileSync("src/common/legal-notices.ts", "utf8"));
  });

  it("versions match the version line of each document", () => {
    for (const f of ["terms", "privacy", "acceptable-use"]) expect(readFileSync(`docs/legal/${f}.md`, "utf8")).toContain(`Version: ${TERMS_VERSION}`);
    expect(readFileSync("docs/legal/host-agreement.md", "utf8")).toContain(`Version: ${HOST_AGREEMENT_VERSION}`);
  });

  it("the UI notices are the ones in docs/legal/ai-notices.md", () => {
    const md = readFileSync("docs/legal/ai-notices.md", "utf8");
    for (const key of ["aiOutput", "networkJob", "testMode", "payments", "hosting"] as const) expect(md, key).toContain(NOTICES[key]);
  });

  it("the installer tells the host about the Host Agreement, by its dated version", () => {
    const line = hostAgreementLine("https://edgecoder.io/");
    expect(line).toContain("https://edgecoder.io/host-agreement");
    expect(line).toContain(`Host Agreement (version ${HOST_AGREEMENT_VERSION})`);
    expect(line).not.toMatch(/draft|legal review/i);
  });

  it("versions are dated, without a draft label, and the draft-labelled ones still count", () => {
    for (const v of [TERMS_VERSION, HOST_AGREEMENT_VERSION]) expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(termsVersionIsCurrent(TERMS_VERSION)).toBe(true);
    expect(termsVersionIsCurrent("2026-11-15-draft")).toBe(true);
    expect(hostAgreementVersionIsCurrent(HOST_AGREEMENT_VERSION)).toBe(true);
    expect(hostAgreementVersionIsCurrent("2026-11-15-draft")).toBe(true);
    for (const v of [null, undefined, "", "1999-01-01"]) {
      expect(termsVersionIsCurrent(v)).toBe(false);
      expect(hostAgreementVersionIsCurrent(v)).toBe(false);
    }
  });

  it("no notice or document is labelled as a draft", () => {
    expect(Object.values(NOTICES).join(" ")).not.toMatch(/draft|legal review/i);
    for (const f of ["terms", "privacy", "acceptable-use", "host-agreement", "ai-notices"]) {
      const md = readFileSync(`docs/legal/${f}.md`, "utf8");
      expect(md, f).not.toMatch(/draft|pending legal review/i);
      expect(md, f).toContain(["terms", "privacy", "acceptable-use"].includes(f) ? "Last updated: 22 November 2026" : "Last updated: 16 November 2026");
    }
  });
});
