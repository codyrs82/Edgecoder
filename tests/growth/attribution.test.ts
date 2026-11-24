import { describe, expect, it } from "vitest";
import {
  UTM_COOKIE_TTL_MS,
  campaignsInText,
  chicagoDay,
  chicagoHour,
  cleanTag,
  decideVisit,
  decodeUtmCookie,
  encodeUtmCookie,
  isBotUserAgent,
  previousDay,
  utmCookieMaxAgeSeconds,
  utmFromQuery
} from "../../src/growth/attribution.js";
import { emailIgnored, growthConfigFrom } from "../../src/growth/config.js";

const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.70";
// 2026-11-23 09:00 in Chicago (CST, UTC-6).
const T = Date.UTC(2026, 10, 23, 15, 0);
const WEB_CHAT = { source: "x", medium: "social", campaign: "web-chat", content: "" };

describe("campaign tags", () => {
  it("reads and cleans utm_* tags; untagged requests are null", () => {
    expect(utmFromQuery({ utm_source: "X", utm_medium: "paid", utm_campaign: "Launch Week", utm_content: "video_1" })).toEqual({ source: "x", medium: "paid", campaign: "launch-week", content: "video_1" });
    expect(utmFromQuery({ utm_source: ["x", "y"], utm_campaign: "a" })).toMatchObject({ source: "x", campaign: "a" });
    expect(utmFromQuery({ q: "1" })).toBeNull();
    expect(utmFromQuery({ utm_medium: "social" })).toBeNull();
    expect(cleanTag("<script>alert(1)</script>")).toBe("scriptalert1script");
    expect(cleanTag("a".repeat(200))).toHaveLength(64);
  });

  it("finds short-link campaigns in post text", () => {
    expect(campaignsInText("Chat on the web: edgecoder.io/x/web-chat and https://edgecoder.io/x/reserves-sats.")).toEqual(["web-chat", "reserves-sats"]);
    expect(campaignsInText("no links")).toEqual([]);
  });

  it("uses America/Chicago days and hours", () => {
    expect(chicagoDay(T)).toBe("2026-11-23");
    expect(chicagoHour(T)).toBe(9);
    // 03:00 UTC on the 24th is still the 23rd in Chicago.
    expect(chicagoDay(Date.UTC(2026, 10, 24, 3, 0))).toBe("2026-11-23");
    expect(previousDay("2026-03-01")).toBe("2026-02-28");
    expect(previousDay("2027-01-01")).toBe("2026-12-31");
  });
});

describe("bot filtering", () => {
  it("skips crawlers, unfurlers, scripts and empty user agents; keeps browsers", () => {
    for (const ua of ["Twitterbot/1.0", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "facebookexternalhit/1.1", "curl/8.4.0", "python-requests/2.31", "Slackbot-LinkExpanding 1.0", "", undefined, "Mozilla/5.0 HeadlessChrome/120.0"]) {
      expect(isBotUserAgent(ua), String(ua)).toBe(true);
    }
    for (const ua of [BROWSER, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"]) {
      expect(isBotUserAgent(ua), ua).toBe(false);
    }
  });
});

describe("counting a visit", () => {
  const visit = (o: Partial<Parameters<typeof decideVisit>[0]> = {}) => decideVisit({ method: "GET", utm: WEB_CHAT, userAgent: BROWSER, cookie: undefined, nowMs: T, ...o });

  it("counts a first tagged GET and sets the first-touch cookie", () => {
    const v = visit();
    expect(v.count).toEqual(WEB_CHAT);
    expect(v.day).toBe("2026-11-23");
    expect(v.cookie?.first).toEqual({ ...WEB_CHAT, atMs: T });
  });

  it("skips HEAD, robots and untagged requests, and leaves the cookie alone", () => {
    for (const v of [visit({ method: "HEAD" }), visit({ userAgent: "Twitterbot/1.0" }), visit({ utm: null })]) {
      expect(v.count).toBeNull();
      expect(v.cookie).toBeNull();
    }
  });

  it("counts a campaign once per visitor per day, again the next day, and keeps the first touch", () => {
    const first = visit();
    const cookie = encodeUtmCookie(first.cookie!);
    expect(visit({ cookie, nowMs: T + 60_000 }).count).toBeNull();
    // Another campaign the same day counts, and the first touch stays web-chat.
    const other = visit({ cookie, utm: { source: "x", medium: "paid", campaign: "launch", content: "v2" }, nowMs: T + 120_000 });
    expect(other.count?.campaign).toBe("launch");
    expect(other.cookie?.first.campaign).toBe("web-chat");
    expect(other.cookie?.first.atMs).toBe(T);
    // Tomorrow the same campaign counts again.
    const next = visit({ cookie: encodeUtmCookie(other.cookie!), nowMs: T + 86_400_000 });
    expect(next.count).toEqual(WEB_CHAT);
    expect(next.cookie?.counted).toHaveLength(1);
  });

  it("the cookie lasts 30 days from the first touch; an expired or forged cookie is ignored", () => {
    const c = visit().cookie!;
    expect(utmCookieMaxAgeSeconds(c, T)).toBe(30 * 24 * 3600);
    expect(utmCookieMaxAgeSeconds(c, T + 86_400_000)).toBe(29 * 24 * 3600);
    const raw = encodeUtmCookie(c);
    expect(decodeUtmCookie(raw, T + 1000)?.first.campaign).toBe("web-chat");
    expect(decodeUtmCookie(raw, T + UTM_COOKIE_TTL_MS + 1)).toBeNull();
    expect(decodeUtmCookie("not-base64-json", T)).toBeNull();
    const forged = Buffer.from(JSON.stringify({ v: 1, s: "x", m: "social", c: "<b>", t: "", a: T, d: "2026-11-23", k: [] })).toString("base64url");
    expect(decodeUtmCookie(forged, T)).toBeNull();
    // After expiry a new tagged visit becomes the first touch.
    const later = visit({ cookie: raw, utm: { ...WEB_CHAT, campaign: "reserves" }, nowMs: T + UTM_COOKIE_TTL_MS + 1 });
    expect(later.cookie?.first.campaign).toBe("reserves");
  });
});

describe("SIGNUP_ALERT_IGNORE", () => {
  const list = growthConfigFrom({ SIGNUP_ALERT_IGNORE: " Owner@Example.com, @test.example ,cody+*@sixthirty.ai, nonsense" }).ignore;

  it("parses a comma list (entries without @ are dropped)", () => {
    expect(list).toEqual(["owner@example.com", "@test.example", "cody+*@sixthirty.ai"]);
    expect(growthConfigFrom({}).ignore).toEqual([]);
  });

  it("matches exact addresses, whole domains and globs, case-insensitively", () => {
    expect(emailIgnored("owner@example.com", list)).toBe(true);
    expect(emailIgnored("OWNER@example.com", list)).toBe(true);
    expect(emailIgnored("other@example.com", list)).toBe(false);
    expect(emailIgnored("anyone@test.example", list)).toBe(true);
    expect(emailIgnored("anyone@sub.test.example", list)).toBe(false);
    expect(emailIgnored("anyone@nottest.example", list)).toBe(false);
    expect(emailIgnored("cody+a1@sixthirty.ai", list)).toBe(true);
    expect(emailIgnored("cody@sixthirty.ai", list)).toBe(false);
    expect(emailIgnored("cody+x@evil.com@sixthirty.ai", list)).toBe(false);
    expect(emailIgnored("someone@x.com", [])).toBe(false);
  });
});
