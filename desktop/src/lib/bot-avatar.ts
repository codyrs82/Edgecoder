// Bot avatars: a small generated character per bot (a shape, a color and a face). The color and
// shape come from the bot (set in its form) or, when unset, from its name, so a bot always looks
// the same. The face follows the bot's state.
import type { BotStatus } from "./bots";

export const AVATAR_SHAPES = ["robot", "orb", "hex", "block"] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];
export const AVATAR_SHAPE_LABELS: Record<AvatarShape, string> = { robot: "Robot", orb: "Orb", hex: "Hex", block: "Block" };
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
  return AVATAR_SHAPES[nameHash(bot.name) % AVATAR_SHAPES.length];
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
