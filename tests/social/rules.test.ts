import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { nostrEventId } from "../../src/discovery/nostr.js";
import { bech32Decode, bech32Encode, brandNostrKeys, buildNote } from "../../src/social/nostr-brand.js";
import { dedupeHash, forNostr, neverClaimProblems, normalizeForDedupe, postProblems, stripLeadingMentions, withUtm, xWeightedLength } from "../../src/social/rules.js";
import { docsDraft, docsTitle, firstNotesLine, hostSatsFromRevenue, isoWeekKey, latestReleases, networkWeekly, releaseDraft, sitemapUrls, weeklyDraft } from "../../src/social/sources.js";
import { oauthSign, percentEncode } from "../../src/social/x-client.js";

describe("OAuth 1.0a signing", () => {
  // X's documented example ("Creating a signature", developer.x.com).
  const creds = {
    consumerKey: "xvz1evFS4wEEPTGEFPHBog",
    consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
    token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
    tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE"
  };
  const signed = oauthSign({
    method: "post",
    url: "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
    creds,
    bodyParams: { status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
    nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    timestampSec: 1318622958
  });

  it("builds X's signature base string", () => {
    expect(signed.baseString).toBe(
      "POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521"
    );
  });

  it("matches X's documented signature", () => {
    expect(signed.signature).toBe("hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
    expect(signed.header).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
    expect(signed.header.startsWith("OAuth ")).toBe(true);
  });

  it("percent-encodes per RFC 3986", () => {
    expect(percentEncode("Ladies + Gentlemen!*'()")).toBe("Ladies%20%2B%20Gentlemen%21%2A%27%28%29");
  });
});

describe("never-claim check", () => {
  const codes = (t: string) => neverClaimProblems(t).map((p) => p.code);
  it.each([
    ["EdgeCoder is open source", "open_source"],
    ["Our open-source agent", "open_source"],
    ["Fully OPEN SOURCED now", "open_source"],
    ["Chats are end-to-end encrypted", "e2e_encrypted"],
    ["Now with E2EE", "e2e_encrypted"],
    ["e2e by default", "e2e_encrypted"],
    ["A private network for AI", "private_compute"],
    ["Private compute for everyone", "private_compute"],
    ["100% private", "private_compute"],
    ["Earn passive income", "passive_income"],
    ["Guaranteed earnings every week", "guaranteed_earnings"],
    ["guaranteed income", "guaranteed_earnings"],
    ["Guaranteed returns", "guaranteed_earnings"],
    ["As good as GPT-4", "frontier_parity"],
    ["as good as Claude", "frontier_parity"],
    ["Frontier-level answers", "frontier_parity"],
    ["GPT-4 level quality", "frontier_parity"],
    ["on par with ChatGPT", "frontier_parity"]
  ])("blocks %j", (text, code) => {
    expect(codes(text)).toContain(code);
  });

  it("allows honest wording", () => {
    expect(codes("EdgeCoder is source-available (BUSL-1.1). Run models on your own machines.")).toEqual([]);
    expect(codes("The desktop app 1.4.54 is out: faster model downloads.")).toEqual([]);
    expect(codes("Hosts earned 12,000 sats this week")).toEqual([]);
  });

  it("keeps the iOS app away from earning, sats, hosting and withdrawing", () => {
    expect(codes("The iOS app now has dark mode")).toEqual([]);
    expect(codes("Host from your iPhone and earn sats")).toContain("ios_earning");
    expect(codes("New on the App Store: withdraw to Lightning")).toContain("ios_earning");
    expect(codes("EdgeCoder for iOS: sats paid to hosts")).toContain("ios_earning");
  });
});

describe("post rules", () => {
  it("counts URLs as 23 and enforces 280", () => {
    const url = "https://docs.edgecoder.io/guides/a-very-long-path-that-would-otherwise-count-a-lot?utm_source=x&utm_medium=social&utm_campaign=docs";
    expect(xWeightedLength(`Hi ${url}`)).toBe(3 + 23);
    expect(xWeightedLength("see edgecoder.io")).toBe(4 + 23);
    expect(xWeightedLength("see docs.edgecoder.io/guides/x")).toBe(4 + 23);
    expect(xWeightedLength("a".repeat(280))).toBe(280);
    expect(postProblems("a".repeat(280))).toEqual([]);
    expect(postProblems("a".repeat(281)).map((p) => p.code)).toEqual(["too_long"]);
    expect(postProblems(`${"a".repeat(256)} ${url}`)).toEqual([]);
    expect(postProblems(`${"a".repeat(258)} ${url}`).map((p) => p.code)).toEqual(["too_long"]);
  });

  it("counts CJK and emoji as 2", () => {
    expect(xWeightedLength("日本")).toBe(4);
    expect(xWeightedLength("ok 🚀")).toBe(5);
  });

  it("refuses mentions and retweets, strips leading mentions", () => {
    expect(postProblems("thanks @someone for this").map((p) => p.code)).toContain("mention");
    expect(postProblems("RT this").map((p) => p.code)).toContain("retweet");
    expect(postProblems("mail ops@edgecoder.io")).toEqual([]);
    expect(stripLeadingMentions("@a @b_c, hello @d")).toBe("hello @d");
    expect(postProblems("  ")).toEqual([{ code: "empty", message: "The post is empty." }]);
  });

  it("dedupes on normalized text, ignoring tracking params", () => {
    const a = "New guide:  Hosting\nhttps://docs.edgecoder.io/x?utm_source=x&utm_medium=social&utm_campaign=docs";
    const b = "new guide: hosting https://docs.edgecoder.io/x?utm_source=nostr&utm_medium=social&utm_campaign=docs";
    expect(normalizeForDedupe(a)).toBe(normalizeForDedupe(b));
    expect(dedupeHash(a)).toBe(dedupeHash(b));
    expect(dedupeHash(a)).not.toBe(dedupeHash("New guide: Payouts"));
  });

  it("tags links with UTM and swaps the source for Nostr", () => {
    const u = withUtm("https://docs.edgecoder.io/guides/foo", "x", "docs");
    expect(u).toBe("https://docs.edgecoder.io/guides/foo?utm_source=x&utm_medium=social&utm_campaign=docs");
    expect(forNostr(`Read ${u}`)).toBe("Read https://docs.edgecoder.io/guides/foo?utm_source=nostr&utm_medium=social&utm_campaign=docs");
  });
});

describe("draft sources", () => {
  const now = Date.UTC(2026, 10, 23, 12);

  it("keys weekly drafts by ISO week", () => {
    expect(isoWeekKey(now)).toBe("2026-W48");
    expect(isoWeekKey(Date.UTC(2027, 0, 1))).toBe("2026-W53");
  });

  it("builds the weekly report from the network view and revenue", () => {
    const view = {
      agents: [
        { connected: true, blacklisted: false, userId: "u1" },
        { connected: true, blacklisted: false, userId: "u1" },
        { connected: true, blacklisted: false, userId: "u2" },
        { connected: false, blacklisted: false, userId: "u3" },
        { connected: true, blacklisted: true, userId: "u4" }
      ],
      series: { points: [{ atMs: now - 8 * 86_400_000, completed: 999 }, { atMs: now - 86_400_000, completed: 40 }, { atMs: now - 3_600_000, completed: 2 }] }
    };
    expect(networkWeekly(view, now)).toEqual({ hostsOnline: 2, jobs7d: 42 });
    // 5% fee: 1000 sats of fee income means 19000 sats to hosts.
    const revenue = { feeBps: 500, byDay: [{ date: "2026-11-10", msat: 9_000_000 }, { date: "2026-11-20", msat: 600_000 }, { date: "2026-11-23", msat: 400_000 }] };
    expect(hostSatsFromRevenue(revenue, now)).toBe(19_000);
    expect(hostSatsFromRevenue({ feeBps: 0, byDay: [] }, now)).toBeNull();
    const d = weeklyDraft({ hostsOnline: 2, jobs7d: 42, hostSats7d: 19_000 }, now, "https://edgecoder.io/")!;
    expect(d.sourceKey).toBe("weekly:2026-W48");
    expect(d.text).toContain("2 hosts online");
    expect(d.text).toContain("42 jobs run");
    expect(d.text).toContain("19,000 sats paid to hosts");
    expect(d.text).toContain("utm_campaign=weekly");
    expect(postProblems(d.text)).toEqual([]);
    expect(weeklyDraft({ hostsOnline: null, jobs7d: null, hostSats7d: null }, now)).toBeNull();
  });

  it("picks the newest published release per product", () => {
    const listing = [
      { tag_name: "desktop-v1.4.53", html_url: "https://github.com/codyrs82/Edgecoder/releases/tag/desktop-v1.4.53", body: "" },
      { tag_name: "desktop-v1.5.0", prerelease: true },
      { tag_name: "desktop-v1.4.54", html_url: "https://github.com/codyrs82/Edgecoder/releases/tag/desktop-v1.4.54", body: "## What's changed\n- Faster **model** downloads ([#12](https://x))\n" },
      { tag_name: "agent-v1.2.3", draft: true },
      { tag_name: "agent-v1.2.2", body: "Fixes" },
      { tag_name: "v1.2.1" }
    ];
    const latest = latestReleases(listing);
    expect(latest.desktop?.version).toBe("1.4.54");
    expect(latest.agent?.version).toBe("1.2.2");
    expect(firstNotesLine(latest.desktop!.notes)).toBe("Faster model downloads (#12)");
    const d = releaseDraft(latest.desktop!);
    expect(d.sourceKey).toBe("release:desktop:1.4.54");
    expect(d.text).toBe("EdgeCoder desktop app 1.4.54 is out. Faster model downloads (#12)\n\nhttps://github.com/codyrs82/Edgecoder/releases/tag/desktop-v1.4.54");
    const long = releaseDraft({ ...latest.desktop!, notes: "word ".repeat(200) });
    expect(xWeightedLength(long.text)).toBeLessThanOrEqual(280);
    expect(long.text).toContain("…");
  });

  it("reads docs pages from the sitemap and drafts with UTM links", () => {
    const xml = `<urlset><url><loc>https://docs.edgecoder.io/guides/hosting/</loc></url><url><loc>https://docs.edgecoder.io/</loc></url><url><loc>https://evil.example/x</loc></url><sitemap><loc>https://docs.edgecoder.io/sitemap-2.xml</loc></sitemap></urlset>`;
    expect(sitemapUrls(xml, "docs.edgecoder.io")).toEqual(["https://docs.edgecoder.io/guides/hosting/", "https://docs.edgecoder.io/"]);
    expect(docsTitle("https://docs.edgecoder.io/guides/run-a-host/", "<title>Run a host | EdgeCoder Docs</title>")).toBe("Run a host");
    expect(docsTitle("https://docs.edgecoder.io/guides/run-a-host/", null)).toBe("Run a host");
    const d = docsDraft("https://docs.edgecoder.io/guides/run-a-host/", "Run a host");
    expect(d.sourceKey).toBe("docs:/guides/run-a-host");
    expect(d.text).toBe("New in the EdgeCoder docs: Run a host\n\nhttps://docs.edgecoder.io/guides/run-a-host/?utm_source=x&utm_medium=social&utm_campaign=docs");
  });
});

describe("brand Nostr key and notes", () => {
  const hex = "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa";
  it("decodes nsec and hex to the same key", () => {
    const nsec = bech32Encode("nsec", new Uint8Array(Buffer.from(hex, "hex")));
    expect(nsec.startsWith("nsec1")).toBe(true);
    expect(Buffer.from(bech32Decode(nsec)!.bytes).toString("hex")).toBe(hex);
    expect(brandNostrKeys(nsec).pubkeyHex).toBe(brandNostrKeys(hex).pubkeyHex);
    expect(() => brandNostrKeys("nsec1notvalid")).toThrow(/NOSTR_BRAND_NSEC/);
    expect(() => brandNostrKeys("nsec1notvalid")).not.toThrow(/notvalid/);
  });

  it("decodes the NIP-19 example nsec", () => {
    // NIP-19: nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5 is 67dea2ed...
    expect(Buffer.from(bech32Decode("nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5")!.bytes).toString("hex")).toBe(hex);
  });

  it("signs a kind-1 note with no tags", () => {
    const keys = brandNostrKeys(hex);
    const e = buildNote("hello", keys, 1_700_000_000);
    expect(e.kind).toBe(1);
    expect(e.tags).toEqual([]);
    expect(e.id).toBe(nostrEventId({ pubkey: e.pubkey, created_at: e.created_at, kind: 1, tags: [], content: "hello" }));
    expect(schnorr.verify(Buffer.from(e.sig, "hex"), Buffer.from(e.id, "hex"), Buffer.from(e.pubkey, "hex"))).toBe(true);
  });
});
