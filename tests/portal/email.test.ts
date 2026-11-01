import { beforeEach, describe, expect, it, vi } from "vitest";

// #129 review: lock what the wallet send-code email sends (recipient, subject, body, auth),
// so moving its config reads into PortalMailerConfig can't drift.
const calls: Array<{ url: string; opts: { method: string; headers: Record<string, string>; body: string } }> = [];
vi.mock("undici", () => ({
  request: vi.fn(async (url: string, opts: any) => {
    calls.push({ url, opts });
    return { statusCode: 200, body: { text: async () => "" } };
  })
}));

const { createPortalMailer } = await import("../../src/portal/email.js");

const cfg = {
  resendApiKey: "re_test_key",
  resendFromEmail: "EdgeCoder <noreply@example.test>",
  portalPublicUrl: "https://portal.example.test",
  walletSendMfaTtlMs: 600_000
};

describe("sendWalletSendMfaCodeEmail output (#129)", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("sends exactly this request", async () => {
    const mailer = createPortalMailer(cfg, { warn: () => {} });
    await mailer.sendWalletSendMfaCodeEmail({ email: "user@example.test", code: "123456", amountSats: 2500, destination: "tb1qdest" });
    expect(calls).toHaveLength(1);
    const { url, opts } = calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(opts.method).toBe("POST");
    expect(opts.headers).toEqual({ authorization: "Bearer re_test_key", "content-type": "application/json" });
    const body = JSON.parse(opts.body);
    expect(Object.keys(body)).toEqual(["from", "to", "subject", "html"]);
    expect(body.from).toBe("EdgeCoder <noreply@example.test>");
    expect(body.to).toBe("user@example.test");
    expect(body.subject).toBe("EdgeCoder wallet send verification code");
    expect(body.html).toMatchInlineSnapshot(`
      "
            <p>EdgeCoder Wallet send verification</p>
            <p>Your one-time send code is:</p>
            <p><strong style="font-size:22px;letter-spacing:0.18em;">123456</strong></p>
            <p>Requested transfer:</p>
            <ul>
              <li>Amount (sats): 2500</li>
              <li>Destination: tb1qdest</li>
            </ul>
            <p>This code expires in 10 minutes.</p>
            <p>If you did not request this, do not share the code and review account access immediately.</p>
          "
    `);
  });

  it("uses the configured TTL in minutes", async () => {
    const mailer = createPortalMailer({ ...cfg, walletSendMfaTtlMs: 300_000 }, { warn: () => {} });
    await mailer.sendWalletSendMfaCodeEmail({ email: "u@example.test", code: "1", amountSats: 1, destination: "d" });
    expect(JSON.parse(calls[0].opts.body).html).toContain("This code expires in 5 minutes.");
  });

  it("refuses to send without Resend config", async () => {
    const mailer = createPortalMailer({ ...cfg, resendApiKey: "" }, { warn: () => {} });
    await expect(
      mailer.sendWalletSendMfaCodeEmail({ email: "u@example.test", code: "1", amountSats: 1, destination: "d" })
    ).rejects.toThrow("email_mfa_not_configured");
    expect(calls).toHaveLength(0);
  });

  it("surfaces a Resend failure", async () => {
    const { request } = await import("undici");
    vi.mocked(request).mockResolvedValueOnce({ statusCode: 422, body: { text: async () => "bad" } } as any);
    const mailer = createPortalMailer(cfg, { warn: () => {} });
    await expect(
      mailer.sendWalletSendMfaCodeEmail({ email: "u@example.test", code: "1", amountSats: 1, destination: "d" })
    ).rejects.toThrow("wallet_send_mfa_email_failed:422:bad");
  });
});
