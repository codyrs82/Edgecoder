// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { execFile } from "node:child_process";

/**
 * #112: which Python 3 interpreter host-side execution and AST validation spawn.
 *
 * `python3` is the name on Linux and macOS. Windows usually has `python` (python.org installer,
 * actions/setup-python) or the `py` launcher, and `python3` may be the Microsoft Store alias in
 * WindowsApps, which opens the Store or prints "Python was not found" instead of running code.
 * Each candidate is probed once (it must run and report major version 3), and the first that
 * works is cached. EDGECODER_PYTHON overrides the search (a path or command name).
 */
export interface PythonCommand {
  command: string;
  /** Arguments that go before the script arguments (["-3"] for the Windows py launcher). */
  args: string[];
}

const PROBE_SCRIPT = "import sys; print(sys.version_info[0])";
/** Generous: the first interpreter start on a busy CI runner can take several seconds. */
const PROBE_TIMEOUT_MS = 30_000;

export function pythonCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): PythonCommand[] {
  const override = env.EDGECODER_PYTHON?.trim();
  if (override) return [{ command: override, args: [] }];
  if (platform === "win32") {
    return [
      { command: "python", args: [] },
      { command: "py", args: ["-3"] },
      { command: "python3", args: [] }
    ];
  }
  return [
    { command: "python3", args: [] },
    { command: "python", args: [] }
  ];
}

type Probe = (candidate: PythonCommand) => Promise<boolean>;

const defaultProbe: Probe = (candidate) =>
  new Promise((resolve) => {
    try {
      execFile(
        candidate.command,
        [...candidate.args, "-c", PROBE_SCRIPT],
        { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => resolve(!err && String(stdout).trim() === "3")
      );
    } catch {
      resolve(false);
    }
  });

let cached: Promise<PythonCommand | null> | undefined;

/**
 * The first working Python 3 interpreter, or null when none is found. A found interpreter is
 * cached; "none found" is not, so a probe that timed out on a busy machine (or Python installed
 * later) is retried on the next call. A missing command fails fast (ENOENT), so retrying is cheap.
 */
export function resolvePython(probe: Probe = defaultProbe): Promise<PythonCommand | null> {
  if (cached) return cached;
  const pending = (async () => {
    for (const c of pythonCandidates()) {
      if (await probe(c)) return c;
    }
    return null;
  })();
  cached = pending;
  void pending.then((found) => {
    if (!found && cached === pending) cached = undefined;
  });
  return pending;
}

/** Forget the cached interpreter (tests, or after the user installs Python). */
export function resetPythonCache(): void {
  cached = undefined;
}

export const PYTHON_NOT_FOUND =
  "python_not_found: no Python 3 interpreter found (tried python3/python, and py -3 on Windows); install Python 3 or set EDGECODER_PYTHON";
