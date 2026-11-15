import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOST_AGREEMENT_VERSION, NOTICES, TERMS_VERSION } from "../../src/common/legal-notices.js";
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

  it("the installer tells the host about the Host Agreement", () => {
    const line = hostAgreementLine("https://edgecoder.io/");
    expect(line).toContain("https://edgecoder.io/host-agreement");
    expect(line).toContain(HOST_AGREEMENT_VERSION);
  });
});
