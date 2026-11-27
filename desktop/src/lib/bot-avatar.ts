// Bit avatars: a small character per bit (a shape, a color and a face). The shape is one of the
// Bits characters (bit-avatars.ts: their own colours) or a classic shape in the bit's color. A bit
// with no shape set looks as it always has: a classic shape picked from its name. New bits get a
// random Bits character (the form and the server pick one). The face follows the bit's state.
import type { BotStatus } from "./bots";
import { BIT_AVATARS, BIT_AVATAR_IDS, type BitAvatarId } from "./bit-avatars";

/** The shapes from before Bits, drawn in the bit's own color. */
export const CLASSIC_SHAPES = ["robot", "orb", "hex", "block"] as const;
export type ClassicShape = (typeof CLASSIC_SHAPES)[number];
export const AVATAR_SHAPES = [...BIT_AVATAR_IDS, ...CLASSIC_SHAPES] as const;
export type AvatarShape = BitAvatarId | ClassicShape;
export const AVATAR_SHAPE_LABELS: Record<AvatarShape, string> = {
  ...(Object.fromEntries(BIT_AVATARS.map((a) => [a.id, a.label])) as Record<BitAvatarId, string>),
  robot: "Robot",
  orb: "Orb",
  hex: "Hex",
  block: "Block",
};
export function isBitShape(shape: string): shape is BitAvatarId {
  return (BIT_AVATAR_IDS as readonly string[]).includes(shape);
}
/** The same palette the server assigns new bots from. */
export const AVATAR_COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#46a758", "#12a594", "#0090ff", "#6e56cf", "#d6409f"];

export type Mood = "idle" | "working" | "needs" | "failed" | "asleep";

/** A small stable hash of the name (FNV-1a). */
export function nameHash(name: string): number {
  let h = 0x811c9dc5;
  for (const ch of name.trim().toLowerCase()) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function shapeFor(bot: { name: string; avatarShape?: string }): AvatarShape {
  if (bot.avatarShape && (AVATAR_SHAPES as readonly string[]).includes(bot.avatarShape)) return bot.avatarShape as AvatarShape;
  // Unset: the classic shape it has always had (not the Bits characters, so existing bits keep their look).
  return CLASSIC_SHAPES[nameHash(bot.name) % CLASSIC_SHAPES.length];
}

export function colorFromName(name: string): string {
  return AVATAR_COLORS[(nameHash(name) >>> 3) % AVATAR_COLORS.length];
}

export function moodFor(status: BotStatus): Mood {
  switch (status) {
    case "running":
      return "working";
    case "needs_approval":
      return "needs";
    case "error":
      return "failed";
    case "paused":
    case "over_budget":
    case "out_of_csats":
      return "asleep";
    default:
      return "idle";
  }
}

export const MOOD_TEXT: Record<Mood, string> = { idle: "idle", working: "working", needs: "needs you", failed: "last run failed", asleep: "paused" };

/** Text on the avatar: dark on light colors, white on dark ones. */
export function inkFor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? "#1d1d1f" : "#ffffff";
}
