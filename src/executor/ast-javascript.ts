// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import * as acorn from "acorn";

export interface AstValidationResult {
  safe: boolean;
  reason?: string;
}

const ALLOWED_NODE_TYPES = new Set([
  "Program", "FunctionDeclaration", "VariableDeclaration", "VariableDeclarator",
  "ExpressionStatement", "ReturnStatement", "IfStatement", "ForStatement",
  "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement",
  "BlockStatement", "EmptyStatement", "BreakStatement", "ContinueStatement",
  "SwitchStatement", "SwitchCase",
  "ArrayExpression", "ObjectExpression", "BinaryExpression", "UnaryExpression",
  "CallExpression", "ArrowFunctionExpression", "FunctionExpression",
  "Literal", "Identifier", "MemberExpression", "TemplateLiteral",
  "TemplateElement", "TaggedTemplateExpression",
  "ConditionalExpression", "LogicalExpression", "AssignmentExpression",
  "UpdateExpression", "SpreadElement", "Property", "RestElement",
  "ArrayPattern", "ObjectPattern", "AssignmentPattern",
  "SequenceExpression", "ChainExpression", "ParenthesizedExpression",
  "LabeledStatement"
]);

const BLOCKED_GLOBALS = new Set([
  "process", "require", "globalThis", "eval", "Function", "Proxy", "Reflect"
]);

/**
 * Hardening, not a boundary: names that reach the Function constructor or the prototype chain.
 * Rejected as an identifier (`x.constructor`) and as a whole string literal (`x["constructor"]`).
 * A computed key built at runtime (`x["con" + "structor"]`) still passes; that is why local code
 * runs in the Docker sandbox (src/executor/run.ts) and remote code never runs on the host.
 */
const BLOCKED_PROPERTIES = new Set([
  "constructor", "prototype", "__proto__", "__defineGetter__", "__defineSetter__",
  "__lookupGetter__", "__lookupSetter__"
]);

function blockedName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  return BLOCKED_GLOBALS.has(name) || BLOCKED_PROPERTIES.has(name) ? name : undefined;
}

// Walk an acorn AST node recursively, yielding every node
function* walkAst(node: acorn.Node & Record<string, unknown>): Generator<acorn.Node & Record<string, unknown>> {
  if (!node || typeof node !== "object") return;
  yield node;

  // "value" is not skipped: a Property's value is a node (`{ a: process }`). Literal and
  // TemplateElement values are not nodes and are filtered out by the `"type" in child` checks.
  const skipKeys = new Set(["type", "start", "end", "name", "raw", "computed", "method",
    "shorthand", "kind", "operator", "prefix", "sourceType", "optional", "async", "generator",
    "tail", "delegate", "regex", "bigint", "loc", "range"]);

  for (const key of Object.keys(node)) {
    if (skipKeys.has(key)) continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && "type" in item) {
          yield* walkAst(item as acorn.Node & Record<string, unknown>);
        }
      }
    } else if (child && typeof child === "object" && "type" in child) {
      yield* walkAst(child as acorn.Node & Record<string, unknown>);
    }
  }
}

export function validateJavaScriptAst(code: string): AstValidationResult {
  let ast: acorn.Node;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "module"
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { safe: false, reason: `parse error: ${msg}` };
  }

  for (const node of walkAst(ast as acorn.Node & Record<string, unknown>)) {
    const nodeType = (node as { type: string }).type;

    // Check node type against allowlist
    if (!ALLOWED_NODE_TYPES.has(nodeType)) {
      return { safe: false, reason: `Blocked AST node: ${nodeType}` };
    }

    // Check for blocked global identifiers
    if (nodeType === "Identifier") {
      const name = (node as { name?: string }).name;
      if (name && BLOCKED_GLOBALS.has(name)) {
        return { safe: false, reason: `Blocked global: ${name}` };
      }
      if (name && BLOCKED_PROPERTIES.has(name)) {
        return { safe: false, reason: `Blocked property: ${name}` };
      }
    }

    // The same names as string keys: x["constructor"], x[`process`].
    const literal = nodeType === "Literal"
      ? blockedName((node as { value?: unknown }).value)
      : nodeType === "TemplateElement"
        ? blockedName((node as { value?: { cooked?: unknown } }).value?.cooked)
        : undefined;
    if (literal) {
      return { safe: false, reason: `Blocked string key: ${literal}` };
    }

    // Check for blocked call targets
    if (nodeType === "CallExpression") {
      const callee = (node as { callee?: { type: string; name?: string } }).callee;
      if (callee?.type === "Identifier" && callee.name && BLOCKED_GLOBALS.has(callee.name)) {
        return { safe: false, reason: `Blocked global call: ${callee.name}` };
      }
    }
  }

  return { safe: true };
}
