import { describe, expect, it } from "vitest";
import { oauthOutcomeFromUrl } from "../src/lib/oauth-outcome";

const u = (q: string) => new URL(`edgecoder://oauth-callback?${q}`);

describe("desktop OAuth deep-link outcome", () => {
  it("signed in, and whether the provider was just connected", () => {
    expect(oauthOutcomeFromUrl(u("status=ok&provider=google&mobile_token=t"))).toEqual({ kind: "signed_in", token: "t", linked: false });
    expect(oauthOutcomeFromUrl(u("status=ok&provider=google&mobile_token=t&linked=1"))).toEqual({ kind: "signed_in", token: "t", linked: true });
  });

  it("link_pending shows the check-your-email state with the password fallback", () => {
    const out = oauthOutcomeFromUrl(u("status=link_pending&provider=microsoft&email_hint=" + encodeURIComponent("c…@bigdigital.energy")));
    expect(out.kind).toBe("check_email");
    expect(out.kind === "check_email" && out.message).toContain("We sent a link to c…@bigdigital.energy to connect Microsoft to your account.");
    expect(out.kind === "check_email" && out.message).toContain("sign in with your password instead");
  });

  it("errors name the reason; the old dead-end message is gone", () => {
    const limited = oauthOutcomeFromUrl(u("status=error&provider=microsoft&error=oauth_link_rate_limited"));
    expect(limited).toMatchObject({ kind: "error" });
    expect(limited.kind === "error" && limited.message).toContain("password instead");
    expect(oauthOutcomeFromUrl(u("status=ok&provider=google"))).toMatchObject({ kind: "error" });
  });
});
