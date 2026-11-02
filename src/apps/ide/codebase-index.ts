// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Codebase index for search by meaning (@codebase, the agent's search_codebase tool): project
 * files are split into overlapping line chunks and embedded locally with Ollama. Only files whose
 * modification time changed are re-embedded. Stored under ~/.edgecoder/index/, not in the project.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { projectPaths } from "./project-fs.js";

export const DEFAULT_EMBED_MODEL = "nomic-embed-text";
const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 10;
const MAX_FILE_BYTES = 300 * 1024;
const MAX_FILES = 5000;
const BATCH = 32;
/** Files that are generated, minified or lockfiles: noise for search. */
const SKIP_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum)$|\.(min\.js|map|lock|png|jpe?g|gif|ico|webp|pdf|zip|gz|tar|woff2?|ttf|otf|mp4|mov|wasm|dylib|so|dll|exe|bin|sqlite|db)$/i;

export interface Chunk {
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
}

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

interface StoredChunk {
  startLine: number;
  endLine: number;
  /** Unit-length vector, base64 of Float32Array. */
  v: string;
}

interface StoredIndex {
  version: 1;
  model: string;
  files: Record<string, { mtimeMs: number; chunks: StoredChunk[] }>;
  indexedAtMs: number;
}

export interface IndexStatus {
  state: "none" | "building" | "ready" | "error";
  files: number;
  chunks: number;
  indexedAtMs?: number;
  progress?: { done: number; total: number };
  error?: string;
  model: string;
}

/** Overlapping line windows of a file's text. */
export function chunkText(path: string, text: string): Chunk[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const out: Chunk[] = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
    const end = Math.min(lines.length, start + CHUNK_LINES);
    const body = lines.slice(start, end).join("\n");
    if (body.trim()) out.push({ path, startLine: start + 1, endLine: end, text: body });
    if (end === lines.length) break;
  }
  return out;
}

function normalize(v: number[]): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  const len = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / len);
}

const toB64 = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
const fromB64 = (s: string) => {
  const b = Buffer.from(s, "base64");
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};

export type EmbedFn = (inputs: string[]) => Promise<number[][]>;

export function ollamaEmbed(host: string, model: string): EmbedFn {
  return async (inputs) => {
    const res = await request(`${host}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: inputs, keep_alive: "30m" }),
      headersTimeout: 120_000,
      bodyTimeout: 120_000,
    });
    const payload = (await res.body.json().catch(() => ({}))) as { embeddings?: number[][]; error?: string };
    if (res.statusCode >= 400 || payload.error || !payload.embeddings) {
      const msg = payload.error ?? `HTTP ${res.statusCode}`;
      throw new Error(/not found|pull/i.test(msg) ? `the embedding model ${model} is not installed: run \`ollama pull ${model}\`` : msg);
    }
    return payload.embeddings;
  };
}

/** One project's index: build (incrementally), status, search. */
export class CodebaseIndex {
  private stored: StoredIndex | null = null;
  private vectors = new Map<string, Array<{ startLine: number; endLine: number; v: Float32Array }>>();
  private status: IndexStatus;
  private building: Promise<void> | null = null;
  readonly file: string;

  constructor(
    readonly projectRoot: string,
    private readonly embed: EmbedFn,
    readonly model: string,
    indexDir = join(homedir(), ".edgecoder", "index"),
  ) {
    const key = createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
    this.file = join(indexDir, `${key}.json`);
    this.status = { state: "none", files: 0, chunks: 0, model };
    this.load();
  }

  private load() {
    try {
      const s = JSON.parse(readFileSync(this.file, "utf8")) as StoredIndex;
      if (s.version !== 1 || s.model !== this.model) return;
      this.stored = s;
      for (const [p, f] of Object.entries(s.files)) this.vectors.set(p, f.chunks.map((c) => ({ startLine: c.startLine, endLine: c.endLine, v: fromB64(c.v) })));
      this.status = { state: "ready", files: Object.keys(s.files).length, chunks: this.chunkCount(), indexedAtMs: s.indexedAtMs, model: this.model };
    } catch {
      // no index yet
    }
  }

  private chunkCount(): number {
    let n = 0;
    for (const c of this.vectors.values()) n += c.length;
    return n;
  }

  getStatus(): IndexStatus {
    return { ...this.status };
  }

  /** Build or update the index; resolves when done. Concurrent calls share one build. */
  build(): Promise<void> {
    this.building ??= this.doBuild().finally(() => {
      this.building = null;
    });
    return this.building;
  }

  private async doBuild() {
    const prev = this.stored?.files ?? {};
    const files: StoredIndex["files"] = {};
    const todo: Array<{ path: string; mtimeMs: number; chunks: Chunk[] }> = [];
    const candidates = projectPaths(this.projectRoot).filter((p) => p.kind === "file" && !SKIP_FILE.test(p.path)).slice(0, MAX_FILES);
    for (const { path } of candidates) {
      const abs = join(this.projectRoot, path);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.size === 0 || st.size > MAX_FILE_BYTES) continue;
      const old = prev[path];
      if (old && Math.abs(old.mtimeMs - st.mtimeMs) <= 1) {
        files[path] = old;
        continue;
      }
      let buf: Buffer;
      try {
        buf = readFileSync(abs);
      } catch {
        continue;
      }
      if (buf.subarray(0, 8000).includes(0)) continue;
      todo.push({ path, mtimeMs: st.mtimeMs, chunks: chunkText(path, buf.toString("utf8")) });
    }
    const total = todo.reduce((n, f) => n + f.chunks.length, 0);
    this.status = { ...this.status, state: "building", progress: { done: 0, total } };
    try {
      const queue = todo.flatMap((f) => f.chunks.map((c, i) => ({ f, c, i })));
      const embedded = new Map<string, StoredChunk[]>();
      for (let i = 0; i < queue.length; i += BATCH) {
        const batch = queue.slice(i, i + BATCH);
        // nomic-embed-text is trained with these task prefixes.
        const vecs = await this.embed(batch.map(({ c }) => `search_document: ${c.path}\n${c.text}`));
        batch.forEach(({ f, c }, k) => {
          const list = embedded.get(f.path) ?? [];
          list.push({ startLine: c.startLine, endLine: c.endLine, v: toB64(normalize(vecs[k])) });
          embedded.set(f.path, list);
        });
        this.status = { ...this.status, progress: { done: Math.min(i + BATCH, queue.length), total } };
      }
      for (const f of todo) files[f.path] = { mtimeMs: f.mtimeMs, chunks: embedded.get(f.path) ?? [] };
      this.stored = { version: 1, model: this.model, files, indexedAtMs: Date.now() };
      this.vectors = new Map(Object.entries(files).map(([p, f]) => [p, f.chunks.map((c) => ({ startLine: c.startLine, endLine: c.endLine, v: fromB64(c.v) }))]));
      mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.stored), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
      this.status = { state: "ready", files: Object.keys(files).length, chunks: this.chunkCount(), indexedAtMs: this.stored.indexedAtMs, model: this.model };
    } catch (err) {
      this.status = { ...this.status, state: "error", error: (err as Error).message, progress: undefined };
      throw err;
    }
  }

  /** The chunks closest in meaning to the query. Needs a built index. */
  async search(query: string, k = 8): Promise<SearchHit[]> {
    if (this.vectors.size === 0) return [];
    const [qv] = await this.embed([`search_query: ${query}`]);
    const q = normalize(qv);
    const hits: Array<{ path: string; startLine: number; endLine: number; score: number }> = [];
    for (const [path, chunks] of this.vectors) {
      for (const c of chunks) {
        let dot = 0;
        for (let i = 0; i < q.length; i++) dot += q[i] * c.v[i];
        hits.push({ path, startLine: c.startLine, endLine: c.endLine, score: dot });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k).map((h) => ({ ...h, score: Math.round(h.score * 1000) / 1000, snippet: this.snippet(h.path, h.startLine, h.endLine) }));
  }

  private snippet(path: string, start: number, end: number): string {
    try {
      return readFileSync(join(this.projectRoot, path), "utf8").split("\n").slice(start - 1, end).join("\n");
    } catch {
      return "";
    }
  }
}

const indexes = new Map<string, CodebaseIndex>();

/** The index for a project (one instance per project root and model). */
export function codebaseIndexFor(projectRoot: string, ollamaHost: string): CodebaseIndex {
  const model = process.env.IDE_EMBED_MODEL || DEFAULT_EMBED_MODEL;
  const key = `${projectRoot}\0${model}`;
  let idx = indexes.get(key);
  if (!idx) {
    idx = new CodebaseIndex(projectRoot, ollamaEmbed(ollamaHost, model), model);
    indexes.set(key, idx);
  }
  return idx;
}
