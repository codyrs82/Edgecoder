// Bits: EdgeCoder's Bitcoin-themed bit characters and the Bits mark. Our own flat designs on a
// 48×48 grid: one body per bit, drawn to leave the middle (x 12–36, y 19–39) solid so the shared
// face in BotAvatar.svelte (eyes on a soft visor, a mouth that follows the bit's state) reads on it.
// Bitcoin orange (#F7931A) is the accent on every one; a few complementary colours keep them apart.
// The ₿-like notches are a stylised pair of ticks, not the Bitcoin logo glyph.
//
// Plain strings with no imports, so the portal's static copies and the iOS asset catalog can be
// generated from this file (scripts/gen-bits-assets.ts) and checked against it in tests.

export const ORANGE = "#F7931A";
const ORANGE_DEEP = "#B85F00";
const INK = "#1d1d1f";

/** The Bits avatars' ids, stored as a bit's `avatarShape` (lowercase letters: the relay's enum check). */
export const BIT_AVATAR_IDS = ["coin", "bolt", "stack", "chain", "miner", "node", "pill", "vault", "moon", "key", "hash", "jar"] as const;
export type BitAvatarId = (typeof BIT_AVATAR_IDS)[number];

export interface BitAvatar {
  id: BitAvatarId;
  /** Its name in the picker. */
  label: string;
  /** One line of personality (the picker's tooltip). */
  blurb: string;
  /** The body's main colour: the face's ink is picked against it. */
  base: string;
  /** SVG markup for the body (no face), in a 0 0 48 48 viewBox. */
  body: string;
}

const notches = (y1: number, y2: number, color = ORANGE_DEEP) =>
  `<rect x="20.6" y="${y1}" width="2.6" height="${y2 - y1}" rx="1.3" fill="${color}"/><rect x="24.8" y="${y1}" width="2.6" height="${y2 - y1}" rx="1.3" fill="${color}"/>`;

export const BIT_AVATARS: readonly BitAvatar[] = [
  {
    id: "coin",
    label: "Coin",
    blurb: "A cheerful coin with a notched top. Always good for it.",
    base: ORANGE,
    body:
      notches(3.5, 10) +
      notches(41.5, 47.5) +
      `<circle cx="24" cy="26" r="18" fill="${ORANGE}"/>` +
      `<circle cx="24" cy="26" r="14.6" fill="none" stroke="${ORANGE_DEEP}" stroke-width="1.6" opacity="0.55"/>` +
      `<path d="M12.5 18.5 a13 13 0 0 1 8 -6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" opacity="0.5"/>`,
  },
  {
    id: "bolt",
    label: "Zap",
    blurb: "A Lightning sprite. Fast payments, faster replies.",
    base: "#FFC53D",
    body:
      `<rect x="8" y="14" width="32" height="30" rx="15" fill="#FFC53D"/>` +
      `<path d="M27.5 1.5 L17.5 14 H23.5 L20.5 20.5 L31.5 8.5 H25.5 L28.5 1.5 Z" fill="${ORANGE}" stroke="${ORANGE_DEEP}" stroke-width="1.2" stroke-linejoin="round"/>` +
      `<circle cx="9.5" cy="38" r="2" fill="${ORANGE}"/><circle cx="39" cy="20" r="1.6" fill="${ORANGE}"/>`,
  },
  {
    id: "stack",
    label: "Stacker",
    blurb: "A neat stack of sats. Stacks a few more every day.",
    base: ORANGE,
    body:
      `<rect x="7" y="16" width="34" height="29" rx="7" fill="${ORANGE}"/>` +
      `<path d="M7.5 23.5 h4 M7.5 30.5 h4 M7.5 37.5 h4 M36.5 23.5 h4 M36.5 30.5 h4 M36.5 37.5 h4" stroke="${ORANGE_DEEP}" stroke-width="2" stroke-linecap="round"/>` +
      `<ellipse cx="24" cy="15.5" rx="17" ry="5.5" fill="#FFB547" stroke="${ORANGE_DEEP}" stroke-width="1.6"/>` +
      `<ellipse cx="24" cy="15.5" rx="7" ry="2" fill="none" stroke="${ORANGE_DEEP}" stroke-width="1.4" opacity="0.6"/>`,
  },
  {
    id: "chain",
    label: "Blocky",
    blurb: "A little block with a link in its hand. Never breaks the chain.",
    base: "#3D9BE9",
    body:
      `<path d="M9 14 L15 7 H41 L39 12" fill="#8CC8F5"/>` +
      `<rect x="7" y="12" width="32" height="32" rx="7" fill="#3D9BE9"/>` +
      `<path d="M39 12 L41 7 V36 L39 40" fill="#2678BF"/>` +
      `<rect x="36.5" y="31" width="9" height="13" rx="4.5" fill="none" stroke="${ORANGE}" stroke-width="2.6"/>` +
      `<rect x="40" y="38" width="7" height="9" rx="3.5" fill="none" stroke="${ORANGE}" stroke-width="2.4" transform="rotate(-20 43.5 42.5)"/>`,
  },
  {
    id: "miner",
    label: "Digger",
    blurb: "Hard hat on, lamp lit. Finds the next block.",
    base: "#7C5CD6",
    body:
      `<rect x="8" y="15" width="32" height="30" rx="12" fill="#7C5CD6"/>` +
      `<path d="M9.5 17.5 a14.5 12 0 0 1 29 0 Z" fill="${ORANGE}"/>` +
      `<rect x="5" y="15.5" width="38" height="4.5" rx="2.25" fill="${ORANGE_DEEP}"/>` +
      `<rect x="21.5" y="5" width="5" height="8" rx="2" fill="${ORANGE_DEEP}" opacity="0.55"/>` +
      `<circle cx="24" cy="10" r="3.2" fill="#FFF3C4" stroke="${ORANGE_DEEP}" stroke-width="1.2"/>`,
  },
  {
    id: "node",
    label: "Ping",
    blurb: "A node cube with an antenna. Always online, always listening.",
    base: "#13A89E",
    body:
      `<line x1="24" y1="13" x2="24" y2="7" stroke="#0C7A72" stroke-width="2.4" stroke-linecap="round"/>` +
      `<circle cx="24" cy="5.5" r="3" fill="${ORANGE}"/>` +
      `<path d="M17.5 3.5 a8 8 0 0 0 0 5 M30.5 3.5 a8 8 0 0 1 0 5" fill="none" stroke="${ORANGE}" stroke-width="1.8" stroke-linecap="round"/>` +
      `<rect x="7" y="12" width="34" height="32" rx="6" fill="#13A89E"/>` +
      `<circle cx="11.5" cy="16.5" r="1.5" fill="${ORANGE}"/><circle cx="36.5" cy="16.5" r="1.5" fill="${ORANGE}"/>` +
      `<circle cx="11.5" cy="39.5" r="1.5" fill="#0C7A72"/><circle cx="36.5" cy="39.5" r="1.5" fill="#0C7A72"/>`,
  },
  {
    id: "pill",
    label: "Orange",
    blurb: "Half orange, half cream. Explains it all, patiently.",
    base: ORANGE,
    body:
      `<path d="M24 12 H20 a15 15 0 0 0 0 30 H24 Z" fill="#FFE2B8"/>` +
      `<path d="M24 12 H28 a15 15 0 0 1 0 30 H24 Z" fill="${ORANGE}"/>` +
      `<path d="M10 22 a11 11 0 0 1 6 -6.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" opacity="0.7"/>`,
  },
  {
    id: "vault",
    label: "Hodl",
    blurb: "A sturdy vault. Keeps what matters and lets nothing slip.",
    base: "#5B6478",
    body:
      `<rect x="4.5" y="15" width="4" height="6" rx="1.5" fill="#3A4152"/><rect x="4.5" y="33" width="4" height="6" rx="1.5" fill="#3A4152"/>` +
      `<rect x="7" y="9" width="34" height="35" rx="7" fill="#5B6478"/>` +
      `<rect x="10" y="12" width="28" height="29" rx="5" fill="none" stroke="#8A93A8" stroke-width="1.4"/>` +
      `<circle cx="13.5" cy="15.5" r="1.6" fill="${ORANGE}"/><circle cx="34.5" cy="15.5" r="1.6" fill="${ORANGE}"/>` +
      `<circle cx="13.5" cy="37.5" r="1.6" fill="${ORANGE}"/><circle cx="34.5" cy="37.5" r="1.6" fill="${ORANGE}"/>` +
      `<circle cx="41" cy="26.5" r="3.4" fill="${ORANGE}" stroke="#3A4152" stroke-width="1.4"/>`,
  },
  {
    id: "moon",
    label: "Moonie",
    blurb: "Already on the moon and planted a flag. Optimistic about everything.",
    base: "#E9D29A",
    body:
      `<line x1="31" y1="10" x2="31" y2="1.5" stroke="#8A7442" stroke-width="1.8" stroke-linecap="round"/>` +
      `<path d="M31 1.5 L38.5 4 L31 6.5 Z" fill="${ORANGE}"/>` +
      `<circle cx="24" cy="26" r="18" fill="#E9D29A"/>` +
      `<circle cx="12.5" cy="20" r="2.6" fill="#D2B672"/><circle cx="35" cy="37" r="3.2" fill="#D2B672"/>` +
      `<circle cx="16" cy="38.5" r="1.7" fill="#D2B672"/><circle cx="36.5" cy="17.5" r="1.4" fill="#D2B672"/>`,
  },
  {
    id: "key",
    label: "Keys",
    blurb: "Your keys, your bit. Opens doors, never loses itself.",
    base: "#46A758",
    body:
      `<rect x="21.5" y="38" width="5" height="9.5" rx="1.6" fill="#2F7D3B"/>` +
      `<rect x="26" y="41.5" width="4.5" height="2.6" rx="1" fill="#2F7D3B"/><rect x="26" y="45" width="3" height="2.4" rx="1" fill="#2F7D3B"/>` +
      `<circle cx="24" cy="24" r="17" fill="#46A758"/>` +
      `<circle cx="24" cy="10.5" r="2.6" fill="${ORANGE}"/>` +
      `<circle cx="24" cy="24" r="13.8" fill="none" stroke="#2F7D3B" stroke-width="1.4" opacity="0.6"/>`,
  },
  {
    id: "hash",
    label: "Hashy",
    blurb: "Crunches hashes for fun. Spiky hair, steady hands.",
    base: "#E8578A",
    body:
      `<path d="M18.5 3.5 V12 M29.5 3.5 V12 M18.5 41 V46 M29.5 41 V46" stroke="${ORANGE}" stroke-width="2.8" stroke-linecap="round"/>` +
      `<rect x="7" y="10" width="34" height="33" rx="10" fill="#E8578A"/>` +
      `<path d="M7.5 17.5 H11.5 M36.5 17.5 H40.5 M7.5 35.5 H11.5 M36.5 35.5 H40.5" stroke="${ORANGE}" stroke-width="2.4" stroke-linecap="round"/>`,
  },
  {
    id: "jar",
    label: "Mempool",
    blurb: "A glass jar of waiting coins. Patient, and a bit nosy.",
    base: "#7CC6EE",
    body:
      `<rect x="11" y="6.5" width="26" height="6.5" rx="2.5" fill="${ORANGE}"/>` +
      `<rect x="13" y="12" width="22" height="3" fill="${ORANGE_DEEP}" opacity="0.5"/>` +
      `<rect x="8" y="14" width="32" height="31" rx="10" fill="#7CC6EE"/>` +
      `<circle cx="14.5" cy="40" r="2.6" fill="${ORANGE}"/><circle cx="33.5" cy="40" r="2.6" fill="${ORANGE}"/><circle cx="37" cy="35.5" r="2" fill="${ORANGE}"/>` +
      `<path d="M11.5 20 v8" stroke="#fff" stroke-width="2.2" stroke-linecap="round" opacity="0.7"/>`,
  },
];

export function bitAvatar(id: string | undefined): BitAvatar | undefined {
  return id ? BIT_AVATARS.find((a) => a.id === id) : undefined;
}

/** A random Bits avatar for a new bit. */
export function randomBitAvatarId(rand: () => number = Math.random): BitAvatarId {
  return BIT_AVATAR_IDS[Math.floor(rand() * BIT_AVATAR_IDS.length) % BIT_AVATAR_IDS.length];
}

/** Dark face ink on light bodies, white on dark ones (the same rule as bot-avatar.ts inkFor). */
function faceInk(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? INK : "#ffffff";
}

/** The idle face (BotAvatar's): a visor, two eyes, a smile. */
export function idleFace(base: string): string {
  const ink = faceInk(base);
  return (
    `<rect x="12" y="19" width="24" height="13" rx="6.5" fill="${INK}" opacity="0.22"/>` +
    `<ellipse cx="18.5" cy="25.5" rx="3.2" ry="3.4" fill="#fff"/><ellipse cx="29.5" cy="25.5" rx="3.2" ry="3.4" fill="#fff"/>` +
    `<circle cx="19" cy="26" r="1.5" fill="${INK}"/><circle cx="30" cy="26" r="1.5" fill="${INK}"/>` +
    `<path d="M19.5 35.5 q4.5 3.6 9 0" fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>`
  );
}

/** A standalone avatar file: the body and its idle face. */
export function bitAvatarSvg(a: BitAvatar): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" role="img" aria-label="${a.label}"><title>${a.label}</title>${a.body}${idleFace(a.base)}</svg>\n`;
}

/** The Bits icon: the Coin bit, smiling. */
export function bitsMarkSvg(): string {
  const coin = BIT_AVATARS[0];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" role="img" aria-label="Bits"><title>Bits</title>${coin.body}${idleFace(coin.base)}</svg>\n`;
}

/**
 * The Bits wordmark: the icon, then "Bits" drawn as rounded strokes (no font needed). The B carries
 * the notched ticks, the i's dot is a small coin, and the letters follow the light or dark scheme.
 */
export function bitsWordmarkSvg(): string {
  const coin = BIT_AVATARS[0];
  const letters =
    `<g class="ink" fill="none" stroke="${INK}" stroke-width="5.2" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M60 10 V40 M60 10 H69 a7.5 7.5 0 0 1 0 15 H60 M60 25 H71 a7.5 7.5 0 0 1 0 15 H60"/>` +
    `<path d="M91 24 V40"/>` +
    `<path d="M104 13 V34.5 a5.5 5.5 0 0 0 5.5 5.5 H112 M98 24 H112"/>` +
    `<path d="M136 25 a5.5 4.5 0 0 0 -5.5 -2 H127 a5 4.25 0 0 0 0 8.5 H131.5 a5 4.25 0 0 1 0 8.5 H126.5 a5.5 4.5 0 0 1 -5.5 -2"/>` +
    `</g>` +
    `<path d="M63.5 4 V9 M68 4 V9 M63.5 41 V46 M68 41 V46" stroke="${ORANGE}" stroke-width="2.6" stroke-linecap="round"/>` +
    `<circle cx="91" cy="14.5" r="4" fill="${ORANGE}"/><path d="M89.6 12.8 v3.4 M92.4 12.8 v3.4" stroke="${ORANGE_DEEP}" stroke-width="1" stroke-linecap="round"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 48" width="144" height="48" role="img" aria-label="Bits"><title>Bits</title>` +
    `<style>@media (prefers-color-scheme: dark) { .ink { stroke: #f5f5f7; } }</style>` +
    coin.body +
    idleFace(coin.base) +
    letters +
    `</svg>\n`
  );
}
