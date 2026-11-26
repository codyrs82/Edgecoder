// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * fly.sh writes the machines' [env] from its own options. Run 12: LOADGEN_MAX_INFLIGHT and
 * LOADGEN_HOLD_CLOUD_CSATS (read by loadgen.mjs) could not reach the machines, so a run could not
 * lower them. Every other LOADGEN_* variable set where fly.sh runs is now passed through, as TOML
 * lines for its [env] table, except the ones fly.sh itself writes and the local-only ones (the app,
 * org and paths fly.sh uses here, and LOADGEN_KEYS, which goes to the machines as a secret).
 *
 *   node env-passthrough.mjs LOADGEN_PROFILE LOADGEN_RUN_ID ...   (the names fly.sh writes itself)
 */

/** Used only where fly.sh runs, never sent to the machines. */
export const LOCAL_ONLY = ["LOADGEN_APP", "LOADGEN_ORG", "LOADGEN_FLY_DIR", "LOADGEN_KEYS_DIR", "LOADGEN_KEYS", "LOADGEN_ALLOW_BLIND"];

/** TOML lines (`  NAME = "value"`) for the LOADGEN_* variables in `env` not in `written` or LOCAL_ONLY, sorted. */
export function passthroughLines(env, written = []) {
  const skip = new Set([...LOCAL_ONLY, ...written]);
  return Object.keys(env)
    .filter((k) => /^LOADGEN_[A-Z0-9_]+$/.test(k) && !skip.has(k) && env[k] !== undefined && env[k] !== "")
    .sort()
    // A JSON string is a valid TOML basic string (quotes, backslashes and control characters escaped).
    .map((k) => `  ${k} = ${JSON.stringify(String(env[k]))}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const lines = passthroughLines(process.env, process.argv.slice(2));
  if (lines.length) process.stdout.write(lines.join("\n") + "\n");
}
