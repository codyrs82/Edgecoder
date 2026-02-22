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

// Walk an acorn AST node recursively, yielding every node
function* walkAst(node: acorn.Node & Record<string, unknown>): Generator<acorn.Node & Record<string, unknown>> {
  if (!node || typeof node !== "object") return;
  yield node;

  const skipKeys = new Set(["type", "start", "end", "name", "raw", "value", "computed", "method",
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
