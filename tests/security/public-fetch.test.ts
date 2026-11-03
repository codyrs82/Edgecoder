import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { fetchPublicJson } from "../../src/security/public-fetch.js";

const publicDns = async () => ["93.184.216.34"];

describe("fetchPublicJson (LNURL endpoints and callbacks)", () => {
  let agent: MockAgent | undefined;
  afterEach(async () => {
    await agent?.close();
    agent = undefined;
  });
  function mock() {
    const a = new MockAgent();
    agent = a;
    agent.disableNetConnect();
    return agent.get("https://pay.example.com");
  }

  it("returns JSON from a public https host", async () => {
    mock().intercept({ path: "/.well-known/lnurlp/cody", method: "GET" }).reply(200, { tag: "payRequest" });
    await expect(fetchPublicJson("https://pay.example.com/.well-known/lnurlp/cody", { dispatcher: agent, resolveHost: publicDns })).resolves.toEqual({ tag: "payRequest" });
  });

  it("refuses http, credentials, and hosts that resolve to private, loopback or 6PN addresses", async () => {
    await expect(fetchPublicJson("http://pay.example.com/x", { resolveHost: publicDns })).rejects.toThrow(/hop_not_https/);
    await expect(fetchPublicJson("https://u:p@pay.example.com/x", { resolveHost: publicDns })).rejects.toThrow(/url_has_credentials/);
    for (const addr of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "fdaa::3", "::1"]) {
      await expect(fetchPublicJson("https://pay.example.com/x", { resolveHost: async () => [addr] })).rejects.toThrow(/private_address_blocked/);
    }
    await expect(fetchPublicJson("https://127.0.0.1/x")).rejects.toThrow(/private_address_blocked/);
  });

  it("does not follow redirects", async () => {
    mock().intercept({ path: "/cb", method: "GET" }).reply(302, "", { headers: { location: "http://169.254.169.254/latest/meta-data" } });
    await expect(fetchPublicJson("https://pay.example.com/cb", { dispatcher: agent, resolveHost: publicDns })).rejects.toThrow(/redirect_refused/);
  });

  it("caps the body and rejects non-JSON", async () => {
    const pool = mock();
    pool.intercept({ path: "/big", method: "GET" }).reply(200, "x".repeat(70 * 1024));
    pool.intercept({ path: "/html", method: "GET" }).reply(200, "<html>");
    await expect(fetchPublicJson("https://pay.example.com/big", { dispatcher: agent, resolveHost: publicDns })).rejects.toThrow(/response_too_large/);
    await expect(fetchPublicJson("https://pay.example.com/html", { dispatcher: agent, resolveHost: publicDns })).rejects.toThrow(/invalid_json/);
  });
});
