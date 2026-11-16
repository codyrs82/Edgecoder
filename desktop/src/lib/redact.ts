// Credentials out of log text before it is shown or copied (Settings → Logs, "Copy for support").
// The IDE server already masks these before a line leaves it (src/apps/ide/log-tail.ts); this is
// the same set again on the app side, plus a stricter pass for text that leaves the machine.

export const CENSOR = "[redacted]";

const SECRET_NAME = "(?:[A-Za-z_-]*(?:token|secret|passw(?:or)?d?|passphrase|private[_-]?key|mnemonic|seed|api[_-]?key|signature|cookie|authorization|xprv|preimage|macaroon|credential)[A-Za-z_-]*)";
const RULES: Array<[RegExp, string]> = [
  // `"token":"..."` in a JSON line
  [new RegExp(`("${SECRET_NAME}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, "gi"), `$1"${CENSOR}"`],
  // Authorization / x-api-key style headers in text: "Authorization: Basic abc", "x-api-key: ..."
  [/\b((?:proxy-)?authorization|x-[a-z-]*(?:token|key|signature))(\s*[:=]\s*)(?!\[redacted\])(?:(?:Bearer|Basic|Token)\s+)?[^\s,;"'}]+/gi, `$1$2${CENSOR}`],
  // Bearer <credential>
  [/\bBearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{16,}/gi, `Bearer ${CENSOR}`],
  // token=..., apiKey: ..., registrationToken=...
  [new RegExp(`\\b(${SECRET_NAME}\\s*[=:]\\s*)(?!\\[redacted\\])[^\\s,;&"'}]{6,}`, "gi"), `$1${CENSOR}`],
  // //user:pass@host
  [/\/\/[^\s/:@]+:[^\s/@]+@/g, `//${CENSOR}@`],
  // Frontier provider keys and EdgeCoder API keys / registration tokens
  [/\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,})/g, CENSOR],
  [/\b(?:ec_(?:live|test)_[A-Za-z0-9_-]{6,}|ecreg_[A-Za-z0-9_-]{8,})\b/g, CENSOR],
  // JSON web tokens
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, CENSOR],
  // Lightning invoices (BOLT11) and offers (BOLT12)
  [/\b(?:ln(?:bcrt|bc|tbs|tb)[0-9]*[a-z]?1[02-9ac-hj-np-z]{40,}|lno1[02-9ac-hj-np-z]{40,})\b/gi, CENSOR],
  // a payment preimage or hash quoted as 64 hex after its name
  [/\b(preimage|payment[_ ]?hash|payment[_ ]?secret)(\W{1,4})[0-9a-f]{64}\b/gi, `$1$2${CENSOR}`],
];
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// Strict (support): any long opaque run of letters and digits (tokens without a known shape).
const OPAQUE_RE = /\b(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/g;

export interface RedactOptions {
  /** Mask email addresses too. */
  emails?: boolean;
  /** Also mask any long opaque string (for text that leaves the machine). */
  strict?: boolean;
}

export function redactText(text: string, opts: RedactOptions = {}): string {
  let out = text;
  for (const [re, to] of RULES) out = out.replace(re, to);
  if (opts.emails) out = out.replace(EMAIL_RE, "[email]");
  if (opts.strict) out = out.replace(OPAQUE_RE, CENSOR);
  return out;
}
