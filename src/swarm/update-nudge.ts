// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * The coordinator's update nudge, agent side. /register and /heartbeat answer
 * `updateAvailable: "agent-vX.Y.Z"` when this agent reports an older version than the newest
 * agent release the coordinator has seen (coordinator/agent-update-hint.ts). An installed headless
 * agent then writes `update-request` in its own HOME after a random 0-10 minute delay (so a fleet
 * does not restart at once); the root updater's path unit (Linux) or WatchPaths (macOS) starts the
 * usual scheduled check early (src/install/update-schedule.ts).
 *
 * The agent runs unprivileged and gets no new rights: it can only make the updater check sooner.
 * The hint is never passed on: the updater does not read the file, finds the newest release on
 * GitHub itself and installs only what verifies against its pinned key. Still, a coordinator is
 * not trusted with more than "check now", at most once every NUDGE_MIN_INTERVAL_MS:
 *   - only a plain agent-vX.Y.Z tag newer than the installed version counts (never equal/older);
 *   - nothing when EDGECODER_AUTO_UPDATE=off (process env or /etc/edgecoder/*.env, when readable;
 *     the updater checks it again as root and its units are off then anyway).
 */
import { writeFileSync } from "node:fs";
import { posix } from "node:path";
import { compareVersions, parseVersion } from "../install/update.js";
import { UPDATE_REQUEST_FILE } from "../install/update-schedule.js";

/** Spread a fleet: each agent waits a random time up to this before asking. */
export const NUDGE_MAX_DELAY_MS = 10 * 60_000;
/** At most one request this often, whatever the coordinator says. */
export const NUDGE_MIN_INTERVAL_MS = 30 * 60_000;

const HINT_RE = /^agent-v\d{1,6}\.\d{1,6}\.\d{1,6}$/;

export interface UpdateNudgeHooks {
  home: string;
  /** This agent's version ("1.2.6", from its edgecoder-release.json). */
  installedVersion: string;
  /** False when EDGECODER_AUTO_UPDATE=off. Asked on each hint and again before writing. */
  enabled: () => boolean;
  log: (line: string) => void;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => void;
  write?: (path: string, text: string) => void;
}

/** Accept a hint only if it is a release tag newer than `installed`; the tag, else null. */
export function acceptableHint(hint: unknown, installed: string): string | null {
  if (typeof hint !== "string" || hint.length > 40 || !HINT_RE.test(hint) || !parseVersion(hint) || !parseVersion(installed)) return null;
  return compareVersions(hint, installed) > 0 ? hint : null;
}

export function createUpdateNudge(h: UpdateNudgeHooks): { onHint: (hint: unknown) => void } {
  const now = h.now ?? Date.now;
  const random = h.random ?? Math.random;
  const setTimer = h.setTimer ?? ((fn, ms) => void setTimeout(fn, ms).unref?.());
  const put = h.write ?? ((path, text) => writeFileSync(path, text, { mode: 0o644 }));
  let pending = false;
  let lastSentMs = -Infinity;
  return {
    onHint(hint) {
      const tag = acceptableHint(hint, h.installedVersion);
      if (!tag || pending || now() - lastSentMs < NUDGE_MIN_INTERVAL_MS || !h.enabled()) return;
      pending = true;
      const delay = Math.floor(Math.max(0, Math.min(1, random())) * NUDGE_MAX_DELAY_MS);
      h.log(`coordinator reports ${tag} (installed ${h.installedVersion}): asking the updater to check in ${Math.round(delay / 1000)}s`);
      setTimer(() => {
        pending = false;
        if (!h.enabled()) return;
        lastSentMs = now();
        try {
          put(posix.join(h.home, UPDATE_REQUEST_FILE), JSON.stringify({ hint: tag, installed: h.installedVersion, atMs: now() }) + "\n");
        } catch (e) {
          h.log(`could not write ${UPDATE_REQUEST_FILE}: ${(e as Error).message}`);
        }
      }, delay);
    }
  };
}
