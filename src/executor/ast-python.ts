// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { spawn } from "node:child_process";
import { PYTHON_NOT_FOUND, resolvePython } from "./python-interpreter.js";

export interface AstValidationResult {
  safe: boolean;
  reason?: string;
}

const ALLOWED_NODE_TYPES = new Set([
  "Module", "FunctionDef", "Return", "Assign", "AugAssign",
  "For", "While", "If", "Expr", "Call", "BinOp", "UnaryOp",
  "Compare", "BoolOp", "Num", "Str", "List", "Dict", "Tuple",
  "Set", "Name", "Subscript", "Attribute", "ListComp", "DictComp",
  "SetComp", "FormattedValue", "JoinedStr", "Index", "Slice",
  "Constant", "Pass", "Break", "Continue", "arguments", "arg",
  "Store", "Load", "Del", "Add", "Sub", "Mult", "Div", "Mod",
  "Pow", "FloorDiv", "BitOr", "BitXor", "BitAnd", "LShift",
  "RShift", "Invert", "Not", "UAdd", "USub", "Eq", "NotEq",
  "Lt", "LtE", "Gt", "GtE", "Is", "IsNot", "In", "NotIn",
  "And", "Or", "keyword", "comprehension", "Starred",
  "IfExp", "GeneratorExp", "Lambda", "Slice"
]);

const BLOCKED_BUILTINS = new Set([
  "open", "exec", "eval", "compile", "__import__", "globals",
  "locals", "getattr", "setattr", "delattr", "vars", "dir",
  "input", "breakpoint", "memoryview", "bytearray"
]);

const AST_WALKER_SCRIPT = `
import ast, json, sys

code = sys.stdin.read()
try:
    tree = ast.parse(code)
except SyntaxError as e:
    print(json.dumps({"error": f"parse error: {e}"}))
    sys.exit(0)

nodes = []
calls = []
for node in ast.walk(tree):
    nodes.append(type(node).__name__)
    if isinstance(node, ast.Call):
        if isinstance(node.func, ast.Name):
            calls.append(node.func.id)
        elif isinstance(node.func, ast.Attribute):
            calls.append(node.func.attr)

print(json.dumps({"nodes": nodes, "calls": calls}))
`;

/**
 * #112: how long the AST walker may take. It parses a few lines, but the interpreter's cold start
 * on a loaded machine (seen on Windows CI runners) exceeded the old fixed 5 s. A timeout still
 * fails closed. EDGECODER_PYTHON_AST_TIMEOUT_MS overrides the 10 s default.
 */
export function astTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.EDGECODER_PYTHON_AST_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

export async function validatePythonAst(code: string): Promise<AstValidationResult> {
  const python = await resolvePython();
  if (!python) return { safe: false, reason: PYTHON_NOT_FOUND };
  return new Promise<AstValidationResult>((resolve) => {
    const proc = spawn(python.command, [...python.args, "-c", AST_WALKER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGKILL");
        resolve({ safe: false, reason: "AST validation timed out" });
      }
    }, astTimeoutMs());

    // Without this a spawn failure (ENOENT, EACCES) is an unhandled 'error' event that kills the
    // process: a worker image without Python crashed on its first peer subtask. Fail closed instead.
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ safe: false, reason: `AST validation could not run ${python.command}: ${err.message}` });
    });
    // EPIPE when the interpreter exits before reading stdin; 'close' or 'error' reports the outcome.
    proc.stdin.on("error", () => {});

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.stdin.write(code);
    proc.stdin.end();

    proc.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (!stdout.trim()) {
        resolve({ safe: false, reason: `AST parse failed: ${stderr}` });
        return;
      }

      try {
        const result = JSON.parse(stdout.trim()) as {
          error?: string;
          nodes?: string[];
          calls?: string[];
        };

        if (result.error) {
          resolve({ safe: false, reason: result.error });
          return;
        }

        for (const node of result.nodes ?? []) {
          if (!ALLOWED_NODE_TYPES.has(node)) {
            resolve({ safe: false, reason: `Blocked AST node: ${node}` });
            return;
          }
        }

        for (const call of result.calls ?? []) {
          if (BLOCKED_BUILTINS.has(call)) {
            resolve({ safe: false, reason: `Blocked builtin call: ${call}` });
            return;
          }
        }

        resolve({ safe: true });
      } catch {
        resolve({ safe: false, reason: "Failed to parse AST validation output" });
      }
    });
  });
}
