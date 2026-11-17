import { describe, expect, it } from "vitest";
import * as web from "../../src/common/chat-failures.js";
import * as desktop from "../../desktop/src/lib/failures.js";

// The web chat and the desktop app word a failed chat the same way (#405).
describe("chat failure wording is shared with the desktop app", () => {
  it("has the same lines", () => {
    expect(web.FAILURE_LINE).toEqual(desktop.FAILURE_LINE);
  });

  it("classifies the same messages the same way", () => {
    const samples = [
      "Not enough cSats for this request (it sets aside up to 4.034 cSats; unused cSats come back).",
      "Not enough cSats: your balance is 0.01 cSats. This step needs about 0.4 cSats on a Datacenter GPU.",
      "Harry's budget is spent for today",
      "No GPU machines online. Available now: CPU (9).",
      "Your machine isn't connected",
      "No model on the network fits this request",
      "all_coordinators_failed",
      "",
    ];
    for (const m of samples) expect(web.failureKind(m), m).toBe(desktop.failureKind(m));
    expect(web.failureKind(samples[0])).toBe("csats");
  });

  it("works in the browser as shipped", () => {
    const run = new Function(`${web.CHAT_FAILURES_BROWSER_LIB}; return { kind: failureKind("Not enough cSats for this request"), line: FAILURE_LINE.csats, buy: BUY_CSATS_URL };`);
    expect(run()).toEqual({ kind: "csats", line: "Couldn't run: out of cSats", buy: "/portal/settings/plan" });
  });
});
