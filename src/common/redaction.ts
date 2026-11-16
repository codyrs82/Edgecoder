// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * #14: the redaction rules shared by every logger (logger.ts) and by error tracking
 * (error-tracking.ts). Three layers, because no single one is enough:
 *   - REDACT_PATHS: pino `redact` paths for the headers and fields we know about.
 *   - redactMeta:   a deep walk that masks any key that looks secret, wherever it is nested.
 *   - scrubText:    credentials that travel inside strings (URL userinfo, bearer tokens), which
 *                   key-based rules cannot see, e.g. an error message quoting an RPC URL.
 * Keys are matched case-insensitively as substrings, so accessToken, refreshToken, meshToken,
 * api_key, x-api-key, privateKey, xprv, Password, paymentPreimage, ... are all caught.
 */
export const SECRET_KEY_RE =
  /(token|secret|passw|passphrase|private|mnemonic|seed|api[-_]?key|signature|cookie|authorization|xprv|wif|preimage|macaroon|credential)/i;

export const CENSOR = "[redacted]";

/** Headers that carry credentials or request signatures in these services. */
export const SECRET_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-admin-token",
  "x-mesh-token",
  "x-inference-token",
  "x-portal-service-token",
  "x-edgecoder-origin",
  "x-signature",
  "x-payment-signature",
  "x-coordinator-signature",
  "x-inference-signature",
  "x-mesh-ws-signature",
  "x-coord-sig"
];
const SECRET_HEADER_SET = new Set(SECRET_HEADERS);

const SECRET_FIELDS = [
  "password", "Password", "passphrase", "token", "accessToken", "refreshToken", "apiToken", "meshToken", "sessionToken",
  "secret", "privateKey", "privateKeyPem", "mnemonic", "seed", "seedPhrase", "apiKey", "api_key", "xprv", "wif",
  "preimage", "paymentPreimage", "macaroon"
];

/** Paths that must never reach a log line: secret headers wherever headers are logged, and secret body fields. */
export const REDACT_PATHS = [
  ...SECRET_HEADERS.flatMap((h) => [`req.headers["${h}"]`, `res.headers["${h}"]`, `headers["${h}"]`, `*.headers["${h}"]`]),
  ...SECRET_FIELDS.flatMap((f) => [f, `*.${f}`, `*.*.${f}`, `*.*.*.${f}`])
];

// `//user:pass@host` and `Bearer <credential>`. The length floor keeps prose such as
// "Bearer token required" intact.
const URL_USERINFO_RE = /\/\/[^\s/:@]+:[^\s/@]+@/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi;
// Frontier provider API keys (docs/frontier-keys.md): Anthropic `sk-ant-...`, OpenAI and most
// OpenAI-compatible providers `sk-...` / `sk-proj-...`, OpenRouter `sk-or-...`, Groq `gsk_...`,
// xAI `xai-...`. The length floor keeps words like "sk-learn" intact.
const API_KEY_RE = /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,})/g;

/** Mask provider API keys (sk-ant-..., sk-..., gsk_..., xai-...) in free text. */
export function redactApiKeys(text: string): string {
  return text.replace(API_KEY_RE, CENSOR);
}

/** Mask credentials embedded in free text. */
export function scrubText(text: string): string {
  if (text.length < 8) return text;
  return redactApiKeys(text.replace(URL_USERINFO_RE, `//${CENSOR}@`).replace(BEARER_RE, `Bearer ${CENSOR}`));
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key) || SECRET_HEADER_SET.has(key.toLowerCase());
}

const MAX_DEPTH = 8;

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function redactMeta(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object") return value;
  // #128 review: never return raw data we didn't inspect.
  if (depth > MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redactMeta(v, depth + 1));
  if (!isPlainObject(value)) {
    // Date, Error, Buffer, Map, ...: keep their normal JSON form (Date -> ISO string).
    const toJSON = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === "function") return redactMeta(toJSON.call(value), depth + 1);
    if (value instanceof Error) {
      const code = (value as { code?: unknown }).code;
      return {
        name: value.name,
        message: scrubText(value.message),
        stack: value.stack === undefined ? undefined : scrubText(value.stack),
        ...(typeof code === "string" || typeof code === "number" ? { code } : {})
      };
    }
    if (value instanceof Map) return redactMeta(Object.fromEntries(value), depth + 1);
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Numbers/booleans under a matching key (e.g. tokensUsed) carry no secret.
    out[k] = isSecretKey(k) && v !== null && typeof v !== "number" && typeof v !== "boolean" ? CENSOR : redactMeta(v, depth + 1);
  }
  return out;
}

// Query keys too short or generic for SECRET_KEY_RE, but which carry credentials in a URL:
// OAuth `code`/`state`, one-time codes, signed-link parameters.
const SECRET_QUERY_KEYS = new Set(["code", "state", "otp", "key", "sig", "auth", "jwt", "session", "sid"]);

/** Mask query values whose key looks secret (`?token=abc` -> `?token=[redacted]`). */
export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  let changed = false;
  for (const key of [...params.keys()]) {
    if (SECRET_KEY_RE.test(key) || SECRET_QUERY_KEYS.has(key.toLowerCase())) {
      params.set(key, CENSOR);
      changed = true;
    }
  }
  return changed ? `${url.slice(0, q)}?${params.toString()}` : url;
}

/** Drop the query string and fragment entirely (error reports never need them). */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut < 0 ? url : url.slice(0, cut);
}
