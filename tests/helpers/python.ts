import { resolvePython } from "../../src/executor/python-interpreter.js";

/**
 * #112: tests that run real Python. The AST walker gets a generous timeout here (interpreter cold
 * start on a loaded CI runner exceeded the production default). Without an interpreter they skip
 * with a message locally; in CI (CI=true) they run and fail, so a runner that lost Python is not
 * silently green.
 */
process.env.EDGECODER_PYTHON_AST_TIMEOUT_MS ??= "30000";

export const PYTHON = await resolvePython();
export const skipWithoutPython = !PYTHON && !process.env.CI;
/** Per-test timeout for suites that spawn Python (AST check plus a run). */
export const PYTHON_TEST_TIMEOUT_MS = 90_000;

if (skipWithoutPython) {
  console.warn("[tests] skipping Python-backed tests: no Python 3 interpreter found (install one or set EDGECODER_PYTHON)");
}
