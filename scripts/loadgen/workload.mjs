// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * What the virtual users ask. Every prompt has a checkable answer, so accuracy is measured:
 *   chat    short questions with one right answer (as scripts in the live probe)
 *   burst   the same kind of one-offs, fired concurrently
 *   coding  a multi-turn agent-style session: a system prompt with tools (read_file, search,
 *           edit_file, answer), then turn after turn of source files pasted as context with a
 *           "what does this function return" question. The conversation grows from ~2K to
 *           ~20K tokens, so long context and (later) session stickiness are exercised.
 *   codegen one call: a module pasted as context (~1-3K tokens) and "write this function plus two
 *           tests" (a few hundred tokens out), checked by the reply naming the new function and
 *           the one it must call. This is the realistic, money-moving call of a coding tool.
 */
import { paramsB } from "./profiles.mjs";

/** Small deterministic PRNG (xorshift32). */
export function rng(seed) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

export function pickWeighted(weights, r) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let x = r() * total;
  for (const [k, w] of entries) {
    if ((x -= w) < 0) return k;
  }
  return entries[entries.length - 1][0];
}

/** A short question with one checkable answer. */
export function question(i) {
  const a = 7 + ((i * 13) % 80), b = 3 + ((i * 7) % 60);
  const kinds = [
    () => ({ q: `What is ${a} + ${b}? Reply with only the number.`, ok: (t) => new RegExp(`\\b${a + b}\\b`).test(t) }),
    () => ({ q: `What is ${a} times 3? Reply with only the number.`, ok: (t) => new RegExp(`\\b${a * 3}\\b`).test(t) }),
    () => ({ q: "What is the capital of France? Reply with one word.", ok: (t) => /paris/i.test(t) }),
    () => ({ q: "In Python, what does len([1, 2, 3]) return? Reply with only the number.", ok: (t) => /\b3\b/.test(t) }),
    () => ({ q: "Which planet is known as the Red Planet? Reply with one word.", ok: (t) => /mars/i.test(t) }),
    () => ({ q: `In JavaScript, what is [${a}, ${b}].length? Reply with only the number.`, ok: (t) => /\b2\b/.test(t) }),
    () => ({ q: "What HTTP status code means Not Found? Reply with only the number.", ok: (t) => /\b404\b/.test(t) }),
    () => ({ q: `What is ${a * 2} divided by 2? Reply with only the number.`, ok: (t) => new RegExp(`\\b${a}\\b`).test(t) }),
  ];
  return kinds[i % kinds.length]();
}

export const CODING_TOOLS = [
  { type: "function", function: { name: "read_file", description: "Read a file from the repository", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "search", description: "Search the repository for a string", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "edit_file", description: "Replace text in a file", parameters: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } }, required: ["path", "old", "new"] } } },
  { type: "function", function: { name: "answer", description: "Give the final answer to the user's question", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } } },
];

const NOUNS = ["ledger", "queue", "agent", "invoice", "session", "route", "model", "slot", "peer", "receipt", "budget", "stream"];
const VERBS = ["compute", "resolve", "settle", "parse", "score", "claim", "merge", "verify", "encode", "throttle"];

/**
 * One synthetic TypeScript module of about `tokens` tokens (4 chars per token) with one needle:
 * a function whose return value the question asks for.
 */
export function sourceFile(r, tokens, n) {
  const noun = NOUNS[Math.floor(r() * NOUNS.length)];
  const path = `src/${noun}/${noun}-${n}.ts`;
  const lines = [`// ${path}`, `import { strict as assert } from "node:assert";`, ""];
  const fns = [];
  let chars = 80;
  while (chars < tokens * 4) {
    const name = `${VERBS[Math.floor(r() * VERBS.length)]}${noun[0].toUpperCase()}${noun.slice(1)}${Math.floor(r() * 9000 + 1000)}`;
    const value = Math.floor(r() * 90000 + 10000);
    fns.push({ name, value });
    const body = [
      `/** ${name}: ${VERBS[Math.floor(r() * VERBS.length)]}s the ${noun} ${NOUNS[Math.floor(r() * NOUNS.length)]} before it is ${VERBS[Math.floor(r() * VERBS.length)]}d. */`,
      `export function ${name}(input: Record<string, number>, limit = ${Math.floor(r() * 500)}): number {`,
      `  const keys = Object.keys(input).filter((k) => input[k] > ${Math.floor(r() * 50)});`,
      `  assert(keys.length <= limit, "too many ${noun} keys");`,
      `  if (keys.length === 0) return ${value};`,
      `  return keys.reduce((acc, k) => acc + input[k] * ${Math.floor(r() * 9) + 1}, 0) % ${value};`,
      `}`,
      "",
    ].join("\n");
    lines.push(body);
    chars += body.length;
  }
  const needle = fns[Math.floor(r() * fns.length)];
  return { path, text: lines.join("\n"), needle };
}

export const approxTokens = (messages) => Math.ceil(messages.reduce((a, m) => a + (typeof m.content === "string" ? m.content.length : 0) + JSON.stringify(m.tool_calls ?? "").length, 0) / 4);

/**
 * A coding-agent session: call next() for the next request body (messages, tools), record(reply)
 * after each call. It ends when the conversation reaches `targetTokens` or after maxTurns.
 */
export class CodingSession {
  constructor({ id, model, seed, targetTokens, startTokens = 2_000, maxTurns = 12 }) {
    this.id = id;
    this.model = model;
    this.r = rng(seed);
    this.targetTokens = targetTokens;
    this.turn = 0;
    this.maxTurns = maxTurns;
    this.perTurn = Math.max(400, Math.round((targetTokens - startTokens) / Math.max(1, maxTurns - 3)));
    this.messages = [
      { role: "system", content: "You are a coding agent working in the user's TypeScript repository. You can call tools. When the user asks what a function returns, call the `answer` tool with just the number (or reply with just the number). Keep replies short." },
    ];
    this.startTokens = startTokens;
    this.pending = null;
    this.done = false;
  }

  next() {
    const tokens = this.turn === 0 ? this.startTokens - 150 : this.perTurn;
    const f = sourceFile(this.r, tokens, this.turn);
    this.pending = f.needle;
    this.messages.push({
      role: "user",
      content: `${this.turn === 0 ? "I'm working on the ledger refactor. " : ""}Here is ${f.path}:\n\n\`\`\`ts\n${f.text}\n\`\`\`\n\nWhen \`input\` is empty, what does \`${f.needle.name}\` return? Answer with the answer tool.`,
    });
    this.turn++;
    return { messages: this.messages, tools: CODING_TOOLS, contextTokens: approxTokens(this.messages) };
  }

  /** Record the reply: { text, toolCalls: [{ id, function: { name, arguments } }] } -> correct? */
  record(reply) {
    const args = (reply.toolCalls ?? []).map((c) => String(c.function?.arguments ?? "")).join(" ");
    const correct = this.pending ? new RegExp(`\\b${this.pending.value}\\b`).test(`${reply.text ?? ""} ${args}`) : null;
    if (reply.toolCalls?.length) {
      this.messages.push({ role: "assistant", content: reply.text ?? "", tool_calls: reply.toolCalls.map((c, i) => ({ id: c.id ?? `call_${this.turn}_${i}`, type: "function", function: { name: c.function?.name ?? "answer", arguments: String(c.function?.arguments ?? "{}") } })) });
      for (const [i, c] of reply.toolCalls.entries()) this.messages.push({ role: "tool", tool_call_id: c.id ?? `call_${this.turn}_${i}`, name: c.function?.name ?? "answer", content: "ok" });
    } else {
      this.messages.push({ role: "assistant", content: reply.text || "(no reply)" });
    }
    if (approxTokens(this.messages) >= this.targetTokens || this.turn >= this.maxTurns) this.done = true;
    return correct;
  }
}

/** Models a load test should not ask for: embeddings and other non-chat models. */
const NOT_CHAT = /embed|whisper|vision|-vl\b|rerank/i;

/** Weight of a small (< 6B) model relative to a 7b+ one, per behaviour. */
export const SMALL_MODEL_WEIGHT = { chat: 0.6, burst: 1, coding: 0.05, codegen: 0.05 };

/**
 * The model mix for a behaviour from a capacity snapshot (capacity.mjs): every chat model the
 * network holds, 7b and up at weight 1 and small ones at SMALL_MODEL_WEIGHT. The planner then
 * multiplies each weight by the model's free in-flight allowance, so 7b/9b/14b/30b calls are spread
 * in proportion to their free slots. `fallback` (profiles.mjs MODELS) without a snapshot. Model
 * "auto" is drawn separately (planner.mjs pickWithAutoShare, --auto-share).
 */
export function modelMix(capacity, behaviour, fallback = {}) {
  const models = Object.entries(capacity?.models ?? {}).filter(([k, m]) => (m?.slots ?? 0) > 0 && !NOT_CHAT.test(k));
  if (!models.length) return { ...fallback };
  const out = {};
  for (const [k] of models) out[`network/${k}`] = paramsB(k) >= 6 ? 1 : SMALL_MODEL_WEIGHT[behaviour] ?? 0.5;
  // "auto" is not weighed here: --auto-share decides how many calls leave the model to the network.
  return out;
}

/** Whether only CPU machines hold the model (slow: shorter prompts and replies). */
export function cpuOnly(capacity, key) {
  const cls = capacity?.models?.[key]?.classes ?? [];
  return cls.length > 0 && cls.every((c) => c === "cpu");
}

/**
 * Size of a codegen call on a model: { contextTokens, maxTokens }. Small or CPU-only models get a
 * shorter module and reply (a CPU agent gives up after 180 s); 7b+ elsewhere a realistic one.
 */
export function codegenSize(key, capacity, scale = 1) {
  const b = key === "auto" ? 7 : paramsB(key);
  const slow = b < 6 || cpuOnly(capacity, key);
  const contextTokens = Math.round((slow ? 800 : b >= 12 ? 3_000 : 2_000) * scale);
  const maxTokens = slow ? 256 : b >= 12 ? 640 : 512;
  return { contextTokens: Math.max(300, contextTokens), maxTokens };
}

/** One codegen request: messages and a check of the reply. */
export function codegenTask(r, n, contextTokens) {
  const f = sourceFile(r, contextTokens, n);
  const noun = f.path.split("/")[1];
  const name = `${VERBS[Math.floor(r() * VERBS.length)]}${noun[0].toUpperCase()}${noun.slice(1)}Batch${n % 1000}`;
  const content = `Here is ${f.path}:\n\n\`\`\`ts\n${f.text}\n\`\`\`\n\nAdd an exported function \`${name}(items: Array<Record<string, number>>, limit: number): number[]\` to this module. It calls \`${f.needle.name}\` on every item and returns the results that are below \`limit\`, sorted ascending. Reply with the complete new function in one \`\`\`ts code block with a JSDoc comment, followed by two short unit tests that use node:assert.`;
  return {
    messages: [
      { role: "system", content: "You are a senior TypeScript engineer. Write complete, compilable code." },
      { role: "user", content },
    ],
    contextTokens: approxTokens([{ content }]),
    ok: (t) => t.includes(name) && t.includes(f.needle.name),
  };
}
