// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The Bits avatars' ids, stored as a bit's `avatarShape`. The designs live in the desktop app
 * (desktop/src/lib/bit-avatars.ts, the same ids in the same order: tests/portal/bits-assets.test.ts
 * checks); the portal serves them as files from src/portal/assets/bits/ (scripts/gen-bits-assets.ts).
 */
export const BIT_AVATAR_IDS = ["coin", "bolt", "stack", "chain", "miner", "node", "pill", "vault", "moon", "key", "hash", "jar"] as const;
export type BitAvatarId = (typeof BIT_AVATAR_IDS)[number];
/** The shapes from before Bits (drawn in the bit's color). A bit with none set shows one of these. */
export const CLASSIC_AVATAR_SHAPES = ["robot", "orb", "hex", "block"] as const;
/** Every avatarShape a bit may have. */
export const ALL_AVATAR_SHAPES = [...BIT_AVATAR_IDS, ...CLASSIC_AVATAR_SHAPES] as const;
export type AvatarShapeId = (typeof ALL_AVATAR_SHAPES)[number];

/** A random Bits avatar for a new bit (existing bits keep theirs). */
export function randomBitAvatarId(rand: () => number = Math.random): BitAvatarId {
  return BIT_AVATAR_IDS[Math.floor(rand() * BIT_AVATAR_IDS.length) % BIT_AVATAR_IDS.length];
}
