import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signModelManifest } from "../../src/security/manifest-verifier.js";
import {
  digestsEqual,
  downloadVerifiedModel,
  assertPublicHttps,
  fileMatchesSha256,
  isBlockedAddress,
  modelFileName,
  redirectTarget,
  sha256OfStream
} from "../../src/security/model-download.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const priv = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const trust = { trustedPeerIds: ["coord-1"], trustedPublicKeys: { "coord-1": publicKey.export({ type: "spki", format: "pem" }) as string } };
const BYTES = Buffer.from("pretend this is a gguf model");
const SHA = createHash("sha256").update(BYTES).digest("hex");
const ORIGIN = "https://huggingface.co";
const PATH = "/org/repo/resolve/main/model.gguf";

function manifest(over: Partial<{ source: string; sha256: string; modelId: string }> = {}) {
  return signModelManifest(
    { modelId: over.modelId ?? "qwen-0.8b", version: "1.0", source: over.source ?? `${ORIGIN}${PATH}`, sha256: over.sha256 ?? SHA },
    priv,
    "coord-1"
  );
}

const publicDns = async () => ["93.184.216.34"];
let agent: MockAgent;
let dir: string;
beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  dir = mkdtempSync(join(tmpdir(), "model-dl-"));
});
afterEach(async () => {
  await agent.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("downloadVerifiedModel (#148)", () => {
  it("follows an https redirect to the CDN, hashes while streaming, and names the file from signed fields", async () => {
    agent.get(ORIGIN).intercept({ path: PATH }).reply(302, "", { headers: { location: "https://cdn-lfs.huggingface.co/blob/abc?sig=1" } });
    agent.get("https://cdn-lfs.huggingface.co").intercept({ path: "/blob/abc?sig=1" }).reply(200, BYTES);
    const out = await downloadVerifiedModel(manifest(), { trust, destDir: dir, dispatcher: agent, resolveHost: publicDns });
    expect(out.path).toBe(join(dir, `qwen-0.8b-1.0-${SHA.slice(0, 16)}.gguf`));
    expect(out.sha256).toBe(SHA);
    expect(out.bytes).toBe(BYTES.length);
    expect(out.hops).toEqual([`${ORIGIN}${PATH}`, "https://cdn-lfs.huggingface.co/blob/abc?sig=1"]);
    expect(readFileSync(out.path)).toEqual(BYTES);
    expect(readdirSync(dir)).toEqual([`qwen-0.8b-1.0-${SHA.slice(0, 16)}.gguf`]);
  });

  it("refuses a redirect hop that downgrades to http", async () => {
    agent.get(ORIGIN).intercept({ path: PATH }).reply(302, "", { headers: { location: "http://cdn.example.org/x" } });
    await expect(downloadVerifiedModel(manifest(), { trust, destDir: dir, dispatcher: agent, resolveHost: publicDns })).rejects.toThrow("redirect_not_https");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a redirect with credentials, without a Location, or too many hops", async () => {
    agent.get(ORIGIN).intercept({ path: PATH }).reply(302, "", { headers: { location: "https://u:p@cdn.example.org/x" } });
    await expect(downloadVerifiedModel(manifest(), { trust, destDir: dir, dispatcher: agent, resolveHost: publicDns })).rejects.toThrow("redirect_has_credentials");

    agent.get(ORIGIN).intercept({ path: PATH }).reply(302, "");
    await expect(downloadVerifiedModel(manifest(), { trust, destDir: dir, dispatcher: agent, resolveHost: publicDns })).rejects.toThrow("redirect_without_location");

    agent.get(ORIGIN).intercept({ path: PATH }).reply(302, "", { headers: { location: PATH } }).times(3);
    await expect(downloadVerifiedModel(manifest(), { trust, destDir: dir, dispatcher: agent, resolveHost: publicDns, maxRedirects: 2 })).rejects.toThrow("too_many_redirects");
  });

  it("refuses a redirect to a private or loopback address, even with a custom dispatcher", async () => {
    agent.get(ORIGIN).intercept({ path: PATH }).reply(302, "", { headers: { location: "https://169.254.169.254/latest/meta-data" } });
    await expect(downloadVerifiedModel(manifest(), { trust, destDir: dir, dispatcher: agent, resolveHost: publicDns })).rejects.toThrow("private_address_blocked");
    agent.get(ORIGIN).intercept({ path: PATH }).reply(302, "", { headers: { location: "https://internal.example.org/m.gguf" } });
    const dns = async (h: string) => (h === "internal.example.org" ? ["192.168.0.10"] : ["93.184.216.34"]);
    await expect(downloadVerifiedModel(manifest(), { trust, destDir: dir, dispatcher: agent, resolveHost: dns })).rejects.toThrow("private_address_blocked");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("deletes the temp file and throws on a sha256 mismatch", async () => {
    agent.get(ORIGIN).intercept({ path: PATH }).reply(200, Buffer.from("tampered"));
    await expect(downloadVerifiedModel(manifest(), { trust, destDir: dir, dispatcher: agent, resolveHost: publicDns })).rejects.toThrow("sha256_mismatch");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("enforces maxBytes from Content-Length and while streaming", async () => {
    agent.get(ORIGIN).intercept({ path: PATH }).reply(200, BYTES, { headers: { "content-length": "999999" } });
    await expect(downloadVerifiedModel(manifest(), { trust, destDir: dir, dispatcher: agent, resolveHost: publicDns, maxBytes: 10 })).rejects.toThrow("model_too_large");
    agent.get(ORIGIN).intercept({ path: PATH }).reply(200, BYTES);
    await expect(downloadVerifiedModel(manifest(), { trust, destDir: dir, dispatcher: agent, resolveHost: publicDns, maxBytes: 10 })).rejects.toThrow("model_too_large");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("verifies the manifest before any network request", async () => {
    const tampered = { ...manifest(), source: `${ORIGIN}/attacker/other.gguf` };
    await expect(downloadVerifiedModel(tampered, { trust, destDir: dir, dispatcher: agent, resolveHost: publicDns })).rejects.toThrow("manifest_invalid: invalid_signature");
    await expect(downloadVerifiedModel(manifest(), { trust: { trustedPeerIds: [], trustedPublicKeys: {} }, destDir: dir, dispatcher: agent, resolveHost: publicDns })).rejects.toThrow("untrusted_peer");
    // disableNetConnect + no intercepts: any request would have thrown a different error
  });

  it("rejects a non-200 final response", async () => {
    agent.get(ORIGIN).intercept({ path: PATH }).reply(404, "nope");
    await expect(downloadVerifiedModel(manifest(), { trust, destDir: dir, dispatcher: agent, resolveHost: publicDns })).rejects.toThrow("download_http_status: 404");
  });
});

describe("download helpers (#148)", () => {
  it("modelFileName never takes the name from the URL and strips path tricks", () => {
    const p = SHA.slice(0, 16);
    expect(modelFileName({ modelId: "../../etc/passwd", version: "1/2", source: `${ORIGIN}/x/evil-name.GGUF`, sha256: SHA })).toBe(`_.._etc_passwd-1_2-${p}.gguf`);
    expect(modelFileName({ modelId: "...", version: "v", source: `${ORIGIN}/m.safetensors`, sha256: SHA })).toBe(`model-v-${p}.safetensors`);
  });

  it("modelFileName keeps two models that sanitize to the same id apart", () => {
    const a = modelFileName({ modelId: "a/b", version: "1", source: `${ORIGIN}/m.gguf`, sha256: "a".repeat(64) });
    const b = modelFileName({ modelId: "a:b", version: "1", source: `${ORIGIN}/m.gguf`, sha256: "b".repeat(64) });
    expect(a).not.toBe(b);
    expect(() => modelFileName({ modelId: "x", version: "1", source: `${ORIGIN}/m.gguf`, sha256: "nope" })).toThrow("invalid_sha256");
  });

  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "not-an-ip"])(
    "isBlockedAddress(%s) is true",
    (a) => expect(isBlockedAddress(a)).toBe(true)
  );

  it.each(["93.184.216.34", "2606:4700::1111", "::ffff:8.8.8.8"])("isBlockedAddress(%s) is false", (a) => expect(isBlockedAddress(a)).toBe(false));

  it("assertPublicHttps rejects http, private literals, and names that resolve privately", async () => {
    await expect(assertPublicHttps("http://example.org/x", publicDns)).rejects.toThrow("hop_not_https");
    await expect(assertPublicHttps("https://127.0.0.1/x", publicDns)).rejects.toThrow("private_address_blocked");
    await expect(assertPublicHttps("https://[::1]/x", publicDns)).rejects.toThrow("private_address_blocked");
    await expect(assertPublicHttps("https://evil.example.org/x", async () => ["93.184.216.34", "10.0.0.5"])).rejects.toThrow("private_address_blocked");
    await expect(assertPublicHttps("https://none.example.org/x", async () => [])).rejects.toThrow("private_address_blocked");
    await expect(assertPublicHttps("https://huggingface.co/x", publicDns)).resolves.toBeUndefined();
  });

  it("redirectTarget resolves relative locations against the current hop", () => {
    expect(redirectTarget("https://a.example.org/x/y", "/z")).toBe("https://a.example.org/z");
    expect(() => redirectTarget("https://a.example.org/", "ftp://b/")).toThrow("redirect_not_https");
  });

  it("streams the hash and compares digests in constant time", async () => {
    expect(await sha256OfStream(Readable.from([BYTES.subarray(0, 5), BYTES.subarray(5)]))).toBe(SHA);
    const p = join(dir, "f.bin");
    writeFileSync(p, BYTES);
    expect(await fileMatchesSha256(p, SHA)).toBe(true);
    expect(await fileMatchesSha256(p, "0".repeat(64))).toBe(false);
    expect(digestsEqual(SHA, "zz")).toBe(false);
    expect(existsSync(p)).toBe(true);
  });
});
