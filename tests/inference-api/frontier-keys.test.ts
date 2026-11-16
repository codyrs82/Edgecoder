import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FrontierKeyStore, detectKeychain, fileKeychain, macKeychain, normalizeBaseUrl } from "../../src/inference-api/frontier-keys.js";

const tmp = mkdtempSync(join(tmpdir(), "frontier-keys-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const KEY = "sk-ant-api03-FAKEKEY-abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A fake macOS `security`: keeps entries in a folder, logs every argv line. `-i` reads one command
 * (the secret included) from stdin, as the real tool does.
 */
function fakeSecurity(dir: string): string {
  const bin = join(dir, "security");
  writeFileSync(
    bin,
    `#!/bin/sh
store="${dir}/store"; mkdir -p "$store"
echo "$@" >> "${dir}/argv.log"
case "$1" in
  -i)
    read -r line
    acct=$(printf '%s' "$line" | sed -n 's/.*-a "\\([^"]*\\)".*/\\1/p')
    pw=$(printf '%s' "$line" | sed -n 's/.*-w "\\([^"]*\\)".*/\\1/p')
    printf '%s' "$pw" > "$store/$acct"
    ;;
  find-generic-password)
    acct="$3"; [ -f "$store/$acct" ] || { echo "security: The specified item could not be found in the keychain." >&2; exit 44; }
    cat "$store/$acct"; echo
    ;;
  delete-generic-password)
    rm -f "$store/$3"
    ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe.skipIf(process.platform === "win32")("frontier keys in the macOS keychain (fake security CLI)", () => {
  const dir = mkdtempSync(join(tmp, "sec-"));
  const bin = fakeSecurity(dir);
  const store = new FrontierKeyStore({ file: join(dir, "frontier.json"), keychain: macKeychain(bin) });

  it("stores the secret in the keychain, never on a command line or in frontier.json", async () => {
    const saved = await store.add({ id: "anthropic", key: KEY, accountId: "acct-alice" });
    expect(saved).toMatchObject({ id: "anthropic", kind: "anthropic", accountId: "acct-alice", storage: "keychain", usable: true });
    expect(readFileSync(join(dir, "store", "acct-alice:anthropic"), "utf8")).toBe(KEY);
    expect(readFileSync(join(dir, "argv.log"), "utf8")).not.toContain("FAKEKEY");
    const meta = readFileSync(join(dir, "frontier.json"), "utf8");
    expect(meta).not.toContain("FAKEKEY");
    expect(statSync(join(dir, "frontier.json")).mode & 0o777).toBe(0o600);
    expect(await store.key("anthropic", "acct-alice")).toBe(KEY);
  });

  it("binds the key to the account that added it", async () => {
    expect(store.list("acct-alice")[0]).toMatchObject({ usable: true });
    const other = store.list("acct-bob")[0];
    expect(other).toMatchObject({ id: "anthropic", usable: false });
    expect(other.reason).toMatch(/another account/);
    expect(store.list(null)[0].reason).toMatch(/Sign in/);
    expect(store.usable("anthropic", "acct-bob")).toBeNull();
    await expect(store.key("anthropic", "acct-bob")).rejects.toThrow(/No anthropic key for your account/);
    await expect(store.key("anthropic", null)).rejects.toThrow(/Sign in/);
    // Back to the owner: usable again.
    expect(await store.key("anthropic", "acct-alice")).toBe(KEY);
  });

  it("removes a key (another account's too) from the keychain and the list", async () => {
    expect(await store.remove("anthropic", "acct-alice")).toBe(true);
    expect(existsSync(join(dir, "store", "acct-alice:anthropic"))).toBe(false);
    expect(store.list("acct-alice")).toEqual([]);
    expect(await store.remove("anthropic", "acct-alice")).toBe(false);
  });

  it("refuses keys with characters that could break out of the tool's input", async () => {
    await expect(store.add({ id: "anthropic", key: 'sk-ant-x" -w "evil', accountId: "acct-alice" })).rejects.toThrow(/doesn't look like an API key/);
    await expect(store.add({ id: "anthropic", key: KEY, accountId: "" })).rejects.toThrow(/Sign in/);
  });
});

describe("frontier key store: providers and settings", () => {
  it("falls back to a 0600 file when there is no keychain, and says so", async () => {
    const dir = mkdtempSync(join(tmp, "file-"));
    const d = detectKeychain({ EDGECODER_FRONTIER_KEYCHAIN: "off", EDGECODER_FRONTIER_FILE: join(dir, "frontier.json") });
    expect(d.fallback).toBe(true);
    const store = new FrontierKeyStore({ file: join(dir, "frontier.json"), keychain: fileKeychain(join(dir, "frontier-keys.json")) });
    expect(store.storageLabel).toMatch(/0600.*no keychain/);
    await store.add({ id: "openai", key: "sk-proj-FAKEKEYabcdefghijklmnopqrstuvwxyz0123", accountId: "acct-alice" });
    if (process.platform !== "win32") expect(statSync(join(dir, "frontier-keys.json")).mode & 0o777).toBe(0o600);
    expect(store.list("acct-alice")[0]).toMatchObject({ id: "openai", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", storage: "file" });
  });

  it("needs a base URL for other OpenAI-compatible providers and checks it", async () => {
    const dir = mkdtempSync(join(tmp, "url-"));
    const store = new FrontierKeyStore({ file: join(dir, "f.json"), keychain: fileKeychain(join(dir, "k.json")) });
    await expect(store.add({ id: "openrouter", key: "sk-or-v1-abcdefghijklmnopqrstuvwxyz", accountId: "acct-a" })).rejects.toThrow(/base URL/);
    expect(normalizeBaseUrl("https://openrouter.ai/api/v1/")).toBe("https://openrouter.ai/api/v1");
    expect(normalizeBaseUrl("http://127.0.0.1:1234/v1/chat/completions")).toBe("http://127.0.0.1:1234/v1");
    expect(() => normalizeBaseUrl("http://example.com/v1")).toThrow(/https/);
    expect(() => normalizeBaseUrl("https://user:pw@example.com/v1")).toThrow(/credentials/);
  });

  it("keeps settings with defaults and validates them", () => {
    const dir = mkdtempSync(join(tmp, "set-"));
    const store = new FrontierKeyStore({ file: join(dir, "f.json"), keychain: fileKeychain(join(dir, "k.json")) });
    expect(store.settings()).toMatchObject({ defaultLead: "frontier/anthropic/claude-opus-5-5", workerModel: "auto", sessionCapUsd: 5, dailyCapUsd: 25, useForAuto: false, effort: "high" });
    expect(store.updateSettings({ sessionCapUsd: 2, dailyCapUsd: null, useForAuto: true })).toMatchObject({ sessionCapUsd: 2, dailyCapUsd: null, useForAuto: true });
    expect(() => store.updateSettings({ workerModel: "frontier/anthropic/claude-haiku-5-5" })).toThrow(/not a frontier one/);
    expect(() => store.updateSettings({ defaultLead: "network/qwen3-coder:30b" })).toThrow(/frontier/);
    expect(() => store.updateSettings({ sessionCapUsd: -1 })).toThrow(/dollar/);
  });
});
