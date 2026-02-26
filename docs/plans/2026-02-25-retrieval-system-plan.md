# QMD / Retrieval System — Implementation Plan

## Overview

On-device code and documentation retrieval for the EdgeCoder agent loop. The agent calls retrieval tools (`search_code`, `search_docs`, `find_similar`) before planning and coding so the sub-1B model receives a short, high-relevance context window instead of the entire codebase. The system combines BM25 text search, vector similarity, and LLM re-ranking — all running locally with no external service dependencies.

This plan covers architecture, storage, indexing, the agent tool surface, file watching, performance targets, and phased delivery. It does **not** cover cloud-side retrieval or swarm-level shared indexes.

**Reference**: `EDGECODER_PLAN.md` Section 7.1 (QMD), Section 11 (`retrieval/` repo area), Phase 2 (agent loop + retrieval tools).

---

## Principles

- **Local-first**: All indexing, search, and re-ranking run on-device. No network calls required.
- **Incremental**: File watcher detects changes; only modified files are re-indexed.
- **Lightweight**: Prefer JS-native or single-binary dependencies. Avoid heavy native modules beyond what is already in the project (`better-sqlite3`).
- **Graceful degradation**: On constrained devices (phones, Raspberry Pi), fall back to BM25-only when vector/reranking resources are unavailable.
- **Agent-driven**: Retrieval is exposed as tools the agent calls explicitly, not injected into every prompt unconditionally.

---

## 1. Storage Layer

### 1.1 SQLite FTS5 for BM25

Reuse the existing `better-sqlite3` dependency. A dedicated database file (`retrieval.db`) keeps the retrieval index separate from operational data.

**Schema:**

```sql
-- Document metadata
CREATE TABLE IF NOT EXISTS documents (
  doc_id    TEXT PRIMARY KEY,          -- deterministic: sha256(project_id + relative_path)
  project_id TEXT NOT NULL,
  rel_path  TEXT NOT NULL,
  language  TEXT,                      -- file extension / detected language
  byte_size INTEGER NOT NULL,
  mtime_ms  INTEGER NOT NULL,          -- last-modified timestamp from filesystem
  indexed_at_ms INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_path
  ON documents(project_id, rel_path);

-- Full-text search via FTS5 (BM25)
CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts USING fts5(
  doc_id,              -- join key back to documents
  chunk_index,         -- integer: position within file
  content,             -- the text chunk
  content_type,        -- 'code' | 'comment' | 'docstring' | 'markdown'
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- Vector embeddings (flat storage; HNSW built in-memory at load)
CREATE TABLE IF NOT EXISTS doc_chunk_vectors (
  doc_id      TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  embedding   BLOB NOT NULL,           -- Float32Array serialized as raw bytes
  model_id    TEXT NOT NULL,            -- embedding model version for invalidation
  PRIMARY KEY (doc_id, chunk_index)
);

-- Index build metadata
CREATE TABLE IF NOT EXISTS index_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**Why FTS5:**
- Ships with SQLite; `better-sqlite3` exposes it without extra native modules.
- Built-in BM25 ranking via `bm25()` function.
- Supports `highlight()` and `snippet()` for result display.
- Incremental updates via `INSERT`/`DELETE` on the virtual table; no full rebuild needed.

### 1.2 Vector Index

Embeddings are stored in `doc_chunk_vectors` as raw `Float32Array` blobs. At startup (or on first query), they are loaded into an **in-memory HNSW index**.

**Options (evaluated in preference order):**

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| **A) `hnswlib-node`** | Native HNSW via N-API binding | Fast, battle-tested, O(log n) query | Native addon; needs rebuild per platform |
| **B) JS-native flat scan** | Brute-force cosine over Float32Arrays | Zero native deps; trivial to implement | O(n) per query; fine up to ~500K chunks |
| **C) `vectra`** | JSON-file-based vector store (MS) | Pure JS, simple API | Designed for small collections; no FTS |
| **D) `usearch`** | Single-file HNSW via N-API | Very fast, cross-platform binaries | Additional native dep |

**Recommendation:** Start with **Option B (flat scan)** for MVP. 100K files at ~5 chunks each = ~500K vectors. With 384-dim embeddings and SIMD-friendly loops, brute-force cosine similarity over 500K vectors completes in <100ms on an M1. Graduate to Option A (`hnswlib-node`) or Option D (`usearch`) if/when query latency exceeds the 200ms target at scale.

---

## 2. Embedding Strategy

### 2.1 Embedding Model

Two supported paths, matching the project's Ollama-or-native pattern:

| Mode | Model | Dims | How |
|------|-------|------|-----|
| **Ollama embedding** | `nomic-embed-text` (137M) or `all-minilm` (33M) | 768 / 384 | `POST /api/embed` to local Ollama |
| **JS-native** | `@xenova/transformers` with `all-MiniLM-L6-v2` (ONNX, 22MB) | 384 | In-process ONNX inference; no Ollama needed |

**Recommendation:** Default to Ollama embedding when Ollama is healthy (the agent already checks via `OllamaLocalProvider.health()`). Fall back to `@xenova/transformers` when Ollama is unavailable. This mirrors the existing provider pattern: Ollama for capability, local stub for offline resilience.

### 2.2 Chunking

Files are split into chunks before embedding.

**Strategy:**

1. **Code files** (`.ts`, `.js`, `.py`, `.rs`, `.go`, etc.):
   - Split on top-level declarations (functions, classes, exports) using lightweight AST/regex heuristics — not full parse trees.
   - Each chunk: declaration + its body, max 512 tokens.
   - Overlap: 64 tokens sliding window between declaration boundaries for context continuity.

2. **Markdown / docs** (`.md`, `.txt`, `.rst`):
   - Split on headings (`##`, `###`) or blank-line-separated paragraphs.
   - Max 512 tokens per chunk.

3. **Config / data** (`.json`, `.yaml`, `.toml`, `.env.example`):
   - Treat entire file as one chunk if < 512 tokens; otherwise split on top-level keys.

4. **Binary / large files**: Skip (configurable via `.edgecoderignore` or built-in denylist: `node_modules/`, `dist/`, `.git/`, images, compiled artifacts).

**Chunk record:**

```typescript
interface DocumentChunk {
  docId: string;
  chunkIndex: number;
  content: string;          // raw text
  contentType: "code" | "comment" | "docstring" | "markdown" | "config";
  startLine: number;
  endLine: number;
  byteOffset: number;
  tokenCount: number;       // estimated via simple whitespace/subword heuristic
}
```

---

## 3. BM25 Text Search

### 3.1 Indexing

On index build (or incremental update), each `DocumentChunk` is inserted into `doc_chunks_fts`:

```sql
INSERT INTO doc_chunks_fts (doc_id, chunk_index, content, content_type)
VALUES (?, ?, ?, ?);
```

### 3.2 Query

```sql
SELECT doc_id, chunk_index, content, content_type,
       bm25(doc_chunks_fts, 0, 0, 10.0, 1.0) AS score
FROM doc_chunks_fts
WHERE doc_chunks_fts MATCH ?
ORDER BY score
LIMIT ?;
```

- The `MATCH` clause uses FTS5 query syntax (supports AND, OR, NOT, phrase, prefix).
- Weights: `content` column weighted 10x higher than `content_type`.
- Default limit: 20 candidates (fed to re-ranker).

### 3.3 Query Preprocessing

Before passing to FTS5, the agent's natural-language query is preprocessed:

1. Strip stop words.
2. Extract quoted phrases (preserve as FTS5 phrase queries).
3. Detect camelCase / snake_case identifiers and keep them as exact tokens.
4. Stem remaining terms (handled by FTS5 `porter` tokenizer).

This is a lightweight function (~50 LOC) in `retrieval/query.ts`.

---

## 4. Vector Search

### 4.1 Indexing

For each `DocumentChunk`:

1. Call embedding model (Ollama or JS-native) with `chunk.content`.
2. Receive `Float32Array` of dimension D (384 or 768).
3. Store in `doc_chunk_vectors` as raw bytes.

Batching: Embed in batches of 32 chunks to amortize Ollama HTTP overhead.

### 4.2 Query

1. Embed the query string using the same model.
2. Compute cosine similarity against all stored vectors (flat scan) or query the HNSW index.
3. Return top-K results (default K=20).

```typescript
interface VectorSearchResult {
  docId: string;
  chunkIndex: number;
  score: number;            // cosine similarity [0, 1]
}
```

### 4.3 Hybrid Merge

BM25 and vector results are merged using **Reciprocal Rank Fusion (RRF)**:

```
RRF_score(d) = sum over rankings R: 1 / (k + rank_R(d))
```

Where `k = 60` (standard constant). This avoids the need to normalize BM25 scores against cosine scores.

The merged list (top 20) is passed to the re-ranker.

---

## 5. LLM Re-Ranking

### 5.1 Approach

Use the existing `ModelProvider` (via `ProviderRegistry` or `IntelligentRouter`) to score candidate chunks. The re-ranker constructs a prompt asking the model to rate relevance.

**Re-rank prompt template:**

```
You are a code relevance judge. Given a search query and a code snippet, output ONLY a relevance score from 0 to 10.

Query: {query}

Snippet ({file_path}, lines {start}-{end}):
```
{content}
```

Score (0-10):
```

For each of the top-N merged candidates (default N=10), call the model once. Parse the integer score from the response. Sort by score descending. Return the top-K (default K=5) to the agent.

### 5.2 Batching and Cost Control

- Re-ranking is **optional**. On constrained devices or when the model provider is the offline stub, skip re-ranking and return the RRF-merged results directly.
- Maximum 10 re-rank calls per query to bound latency.
- Use the smallest available model variant (e.g., `ollama-edge` with the 1.5B model) for re-ranking, not the primary coding model.
- Cache re-rank scores keyed on `(query_hash, doc_id, chunk_index, model_id)` with a short TTL (5 minutes) to avoid redundant calls during iterative agent loops.

### 5.3 Dedicated Reranker Model (Future)

The plan (Section 7.1) mentions `Qwen3 Reranker 0.6B`. When this model is available via Ollama, add a dedicated `RerankerProvider` that uses the cross-encoder scoring endpoint rather than generative prompting. This is a strict upgrade (better accuracy, lower latency) but not required for MVP.

---

## 6. Agent Tool Integration

### 6.1 Tool Definitions

Three tools are exposed to the agent. They follow the same pattern as `run_python` / `run_js` — standalone async functions that the agent calls from the loop.

```typescript
// retrieval/tools.ts

export interface SearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  matchType: "bm25" | "vector" | "hybrid";
}

/**
 * Full-text + vector hybrid search over indexed codebase.
 * Returns re-ranked results.
 */
export async function search_code(
  query: string,
  options?: {
    projectId?: string;
    language?: string;       // filter by file language
    maxResults?: number;     // default 5
    useReranker?: boolean;   // default true if model available
  }
): Promise<SearchResult[]>;

/**
 * Search documentation files (markdown, txt, rst).
 * Same hybrid pipeline but restricted to doc content types.
 */
export async function search_docs(
  query: string,
  options?: {
    projectId?: string;
    maxResults?: number;
  }
): Promise<SearchResult[]>;

/**
 * Find code chunks semantically similar to a given snippet.
 * Vector-only search (no BM25). Useful for "find usages like this"
 * or "find similar implementations".
 */
export async function find_similar(
  codeSnippet: string,
  options?: {
    projectId?: string;
    language?: string;
    maxResults?: number;     // default 5
    excludeFile?: string;    // exclude the source file
  }
): Promise<SearchResult[]>;
```

### 6.2 Agent Loop Integration

The agent base class (`src/agent/base.ts`) gains an optional `RetrievalIndex` dependency:

```typescript
// In AgentOptions
export interface AgentOptions {
  maxIterations?: number;
  sandbox?: "host" | "docker";
  bleMeshManager?: BLEMeshManager;
  retrieval?: RetrievalIndex;          // NEW
}
```

The `InteractiveAgent` uses retrieval before planning:

```typescript
// In InteractiveAgent.run()
async run(task: string, language: Language): Promise<AgentExecution> {
  if (this.retrieval) {
    const context = await search_code(task, {
      language,
      maxResults: 3
    });
    // Prepend context snippets to the task for the planner
    task = this.augmentWithContext(task, context);
  }
  return this.runWithRetry(task, language);
}
```

The `SwarmWorkerAgent` does **not** use retrieval by default (it works on frozen snapshots; retrieval is not meaningful without a local index of that snapshot). This follows the existing two-path split from Design Decision #3.

### 6.3 MCP Compatibility

The tools can also be exposed as MCP (Model Context Protocol) tool definitions for IDE integration. The existing provider-server (`src/apps/ide/provider-server.ts`) can register them as available tools in the chat completion response, allowing Cursor / VS Code to surface them.

---

## 7. File Watching and Incremental Updates

### 7.1 Watcher

Use Node.js `fs.watch` (recursive) or the `chokidar` library for cross-platform file watching. Since the project already depends on `fsevents` (macOS, via vitest), `chokidar` is a natural fit.

**Watcher behavior:**

| Event | Action |
|-------|--------|
| File created | Chunk + index (BM25 + vector) |
| File modified | Delete old chunks for that `doc_id`, re-chunk, re-index |
| File deleted | Delete all chunks for that `doc_id` from FTS5 and vector tables |
| File renamed | Treat as delete + create |

### 7.2 Debouncing

- Debounce file events by 500ms per file to coalesce rapid saves.
- Batch embedding calls: accumulate changed files for up to 2 seconds, then embed all new chunks in one batch.

### 7.3 Initial Index Build

On first run (or when `index_meta.last_full_index_version` does not match the current schema version):

1. Walk the project directory (respecting `.edgecoderignore` and built-in denylist).
2. Chunk all eligible files.
3. Insert into FTS5.
4. Embed in parallel batches (configurable concurrency, default 4 parallel batches of 32).
5. Write `index_meta.last_full_index_version`.

**Progress reporting:** Emit events (`indexing:start`, `indexing:progress`, `indexing:complete`) so the IDE can show a progress indicator.

### 7.4 Staleness Detection

On startup, compare each file's `mtime_ms` in the `documents` table against the filesystem. Re-index only files where `fs.stat().mtimeMs > documents.mtime_ms`.

---

## 8. Core Module Structure

```
src/retrieval/
  index.ts            -- RetrievalIndex class (main entry point)
  store.ts            -- SQLite schema, insert/query/delete operations
  chunker.ts          -- File chunking strategies (code, markdown, config)
  embedder.ts         -- Embedding abstraction (Ollama + JS-native fallback)
  bm25.ts             -- FTS5 query builder and result parser
  vector.ts           -- Flat-scan / HNSW vector search
  ranker.ts           -- LLM re-ranking and RRF merge
  watcher.ts          -- File system watcher + debounce + incremental update
  query.ts            -- Query preprocessing (stop words, identifier detection)
  tools.ts            -- Agent-facing tool functions (search_code, search_docs, find_similar)
  ignore.ts           -- .edgecoderignore parser + built-in denylist
  types.ts            -- Shared types (DocumentChunk, SearchResult, etc.)
```

### 8.1 RetrievalIndex API

```typescript
// retrieval/index.ts

export class RetrievalIndex {
  constructor(options: {
    dbPath: string;               // path to retrieval.db
    projectId: string;
    projectRoot: string;          // filesystem root to index
    embeddingProvider?: "ollama" | "js-native" | "none";
    rerankProvider?: ModelProvider;
    watchEnabled?: boolean;       // default true for interactive, false for worker
  });

  /** Build or refresh the full index. */
  async buildIndex(): Promise<IndexStats>;

  /** Start file watcher for incremental updates. */
  startWatching(): void;

  /** Stop file watcher. */
  stopWatching(): void;

  /** BM25-only search. */
  async searchBM25(query: string, limit?: number): Promise<SearchResult[]>;

  /** Vector-only search. */
  async searchVector(query: string, limit?: number): Promise<SearchResult[]>;

  /** Hybrid search with optional re-ranking. */
  async search(query: string, options?: SearchOptions): Promise<SearchResult[]>;

  /** Vector similarity search from a code snippet. */
  async findSimilar(snippet: string, options?: SimilarOptions): Promise<SearchResult[]>;

  /** Index stats. */
  stats(): IndexStats;

  /** Destroy index and close DB. */
  async close(): Promise<void>;
}

export interface IndexStats {
  totalDocuments: number;
  totalChunks: number;
  totalVectors: number;
  indexSizeBytes: number;
  lastFullBuildMs: number;
  embeddingModel: string;
}
```

---

## 9. Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| **Full index build (100K files)** | < 10 minutes | BM25 indexing is fast (~30s); vector embedding is the bottleneck. 500K chunks at ~200 chunks/sec via Ollama = ~42 min; batch parallelism + JS-native fallback can hit 10 min. |
| **Incremental re-index (1 file)** | < 500ms | BM25 insert + single embedding call |
| **BM25 query** | < 50ms | FTS5 is sub-ms for most queries; 50ms budget includes query preprocessing |
| **Vector query (flat scan, 500K vectors, 384-dim)** | < 100ms | Typed array cosine loop; SIMD-friendly |
| **Hybrid query (BM25 + vector + RRF merge)** | < 150ms | Without re-ranking |
| **Hybrid query + LLM re-rank (10 candidates)** | < 2s | Depends on model inference speed; re-ranking is optional |
| **Memory (vector index, 500K x 384-dim)** | ~750MB | `500K * 384 * 4 bytes = 768MB`. On constrained devices, use BM25-only or reduce chunk count. |
| **Database size (100K files)** | < 500MB | FTS5 + raw vectors. Vectors dominate (~768MB as blobs; compress to ~400MB with quantized int8 embeddings). |
| **Startup (load vector index into memory)** | < 3s | Read blob column in streaming fashion; bulk `Float32Array` allocation |

### 9.1 Constrained Device Fallback

When available memory < 2GB or device is `"phone"`:

- Disable vector embeddings entirely.
- Use BM25-only search.
- Disable LLM re-ranking.
- Reduce chunk size to 256 tokens.
- This mode still provides useful retrieval; BM25 alone is sufficient for identifier and keyword search.

---

## 10. Configuration

```typescript
// retrieval/types.ts

export interface RetrievalConfig {
  /** Directory patterns to ignore (in addition to built-in denylist). */
  ignorePatterns: string[];

  /** Max file size to index (bytes). Default: 1MB. */
  maxFileSizeBytes: number;

  /** Embedding provider preference. Default: "ollama". */
  embeddingProvider: "ollama" | "js-native" | "none";

  /** Ollama embedding model. Default: "nomic-embed-text". */
  ollamaEmbeddingModel: string;

  /** Ollama embedding endpoint. Default: "http://127.0.0.1:11434/api/embed". */
  ollamaEmbeddingEndpoint: string;

  /** Max tokens per chunk. Default: 512. */
  chunkMaxTokens: number;

  /** Chunk overlap tokens. Default: 64. */
  chunkOverlapTokens: number;

  /** Number of BM25 candidates before re-ranking. Default: 20. */
  bm25CandidateLimit: number;

  /** Number of vector candidates before re-ranking. Default: 20. */
  vectorCandidateLimit: number;

  /** Enable LLM re-ranking. Default: true. */
  rerankEnabled: boolean;

  /** Max re-rank calls per query. Default: 10. */
  rerankMaxCandidates: number;

  /** Enable file watcher. Default: true for interactive. */
  watchEnabled: boolean;

  /** File watcher debounce interval (ms). Default: 500. */
  watchDebounceMs: number;
}
```

**Built-in denylist** (always excluded):

```
node_modules/
.git/
dist/
build/
out/
coverage/
__pycache__/
.venv/
*.min.js
*.bundle.js
*.map
*.lock
*.png, *.jpg, *.gif, *.ico, *.svg
*.woff, *.woff2, *.ttf, *.eot
*.pdf, *.zip, *.tar, *.gz
*.pyc, *.pyo, *.so, *.dylib, *.dll
*.sqlite, *.db
```

---

## 11. Dependencies

| Dependency | Purpose | New? | Notes |
|------------|---------|------|-------|
| `better-sqlite3` | FTS5 + vector blob storage | Existing | Already in `package.json` |
| `chokidar` | Cross-platform file watcher | New | ~200KB; widely used; minimal native deps |
| `@xenova/transformers` | JS-native embedding fallback | New (optional) | ~5MB + model weights (~22MB for MiniLM); only loaded when Ollama unavailable |
| `undici` | HTTP client for Ollama embedding endpoint | Existing | Already in `package.json` |

**Zero-new-native-dep path:** If `@xenova/transformers` is deferred, the system works with Ollama-only embeddings and falls back to BM25-only when Ollama is down. No new native modules required.

---

## 12. Phased Delivery

### Phase 1: BM25 Core (1-2 days)

- [ ] `retrieval/store.ts` — SQLite schema, FTS5 CRUD
- [ ] `retrieval/chunker.ts` — Code + markdown chunking
- [ ] `retrieval/bm25.ts` — FTS5 query builder
- [ ] `retrieval/query.ts` — Query preprocessor
- [ ] `retrieval/ignore.ts` — Denylist + `.edgecoderignore`
- [ ] `retrieval/index.ts` — `RetrievalIndex` (BM25-only mode)
- [ ] `retrieval/tools.ts` — `search_code`, `search_docs` (BM25-only)
- [ ] Tests: index build, search accuracy, incremental update

### Phase 2: Vector Search (2-3 days)

- [ ] `retrieval/embedder.ts` — Ollama embedding client + batch API
- [ ] `retrieval/vector.ts` — Flat-scan cosine similarity
- [ ] Hybrid merge (RRF) in `retrieval/index.ts`
- [ ] `find_similar` tool
- [ ] Store embeddings in `doc_chunk_vectors`
- [ ] Tests: embedding round-trip, hybrid merge, find_similar

### Phase 3: File Watcher (1 day)

- [ ] `retrieval/watcher.ts` — Chokidar watcher + debounce
- [ ] Incremental update pipeline (delete old chunks, re-chunk, re-index)
- [ ] Startup staleness detection
- [ ] Tests: file create/modify/delete triggers correct index updates

### Phase 4: LLM Re-Ranking (1 day)

- [ ] `retrieval/ranker.ts` — Re-rank prompt construction + score parsing
- [ ] Integration with `ModelProvider` / `IntelligentRouter`
- [ ] Score caching
- [ ] Graceful skip when model is offline/stub
- [ ] Tests: re-rank improves result order, cache hit behavior

### Phase 5: Agent Integration (1 day)

- [ ] Add `retrieval` option to `AgentOptions`
- [ ] `InteractiveAgent` calls `search_code` before planning
- [ ] Context augmentation helper (format snippets for model context window)
- [ ] MCP tool registration in provider-server
- [ ] End-to-end test: agent uses retrieval to improve code generation

### Phase 6: Polish and Performance (1-2 days)

- [ ] JS-native embedding fallback (`@xenova/transformers`)
- [ ] Constrained-device BM25-only mode
- [ ] Index build progress events
- [ ] Benchmark: 100K file corpus index build time, query latency
- [ ] HNSW upgrade evaluation (if flat scan exceeds 200ms target)
- [ ] Int8 embedding quantization for storage reduction

---

## 13. Testing Strategy

| Test type | What | Where |
|-----------|------|-------|
| Unit | Chunker produces correct chunks for code/markdown/config | `tests/retrieval/chunker.test.ts` |
| Unit | FTS5 query builder handles phrases, identifiers, booleans | `tests/retrieval/bm25.test.ts` |
| Unit | Cosine similarity is correct; flat scan returns top-K | `tests/retrieval/vector.test.ts` |
| Unit | RRF merge combines BM25 + vector correctly | `tests/retrieval/ranker.test.ts` |
| Unit | Ignore patterns exclude correct files | `tests/retrieval/ignore.test.ts` |
| Integration | Full index build + hybrid search returns relevant results | `tests/retrieval/index.test.ts` |
| Integration | File watcher triggers incremental re-index | `tests/retrieval/watcher.test.ts` |
| Integration | Agent with retrieval produces better plans than without | `tests/retrieval/agent-integration.test.ts` |
| Benchmark | Index 10K / 50K / 100K files; measure build time + query latency | `tests/retrieval/benchmark.test.ts` |

---

## 14. Open Questions

1. **Embedding model choice**: `nomic-embed-text` (768-dim, better quality) vs `all-minilm` (384-dim, faster, smaller). Benchmark both on code retrieval accuracy before committing.

2. **Cross-project index**: Should one `retrieval.db` serve multiple projects (multi-tenant index) or one DB per project? Single DB is simpler; multiple DBs isolate projects. Start with one DB per project; revisit if users commonly work across many projects.

3. **Pre-indexed snapshots for swarm**: Should frozen snapshots include a pre-built retrieval index so swarm workers can search? This would add index files to the tarball but save workers from re-indexing. Defer to swarm phase.

4. **Reranker model via Ollama**: When `Qwen3 Reranker 0.6B` or `EmbeddingGemma 300M` become available as Ollama models with a rerank endpoint, the re-ranker should switch from generative prompting to the dedicated cross-encoder API. Track Ollama's progress on rerank endpoints.

5. **Token counting**: The chunker needs approximate token counts. Options: (a) simple `content.split(/\s+/).length` heuristic, (b) `tiktoken`-compatible JS tokenizer. The heuristic is sufficient for chunking; exact token counts matter more for context-window packing, which the agent handles separately.

---

## 15. Relationship to Existing Code

| Existing module | Interaction |
|-----------------|-------------|
| `src/agent/base.ts` | `AgentOptions` gains optional `retrieval` field; `InteractiveAgent` calls retrieval tools before planning |
| `src/agent/worker.ts` | No change; swarm workers do not use retrieval (Design Decision #3) |
| `src/model/providers.ts` | `ModelProvider` used for re-ranking via `generate()` |
| `src/model/router.ts` | `IntelligentRouter` can route re-rank calls through the same Bluetooth > Ollama > Swarm > Stub waterfall |
| `src/db/sqlite-store.ts` | Pattern reference for `better-sqlite3` usage; retrieval uses its own DB file, not the operational store |
| `src/executor/` | No direct interaction; retrieval is pre-execution context, not execution |
| `src/apps/ide/provider-server.ts` | Registers retrieval tools as MCP-compatible tool definitions for IDE clients |
| `src/common/types.ts` | New retrieval types added to `src/retrieval/types.ts`, not to `common/types.ts` (keep retrieval self-contained) |

---

## 16. Security Considerations

- **No arbitrary file access**: The watcher and indexer only read files within the declared `projectRoot`. Path traversal is prevented by resolving all paths and confirming they are within the root.
- **No code execution**: The retrieval system reads file contents for indexing; it never executes them.
- **Embedding data stays local**: Embeddings are stored in a local SQLite database. When using Ollama, the embedding endpoint is `localhost` only.
- **Denylist enforcement**: `.env`, credentials files, and private keys are excluded by the built-in denylist. Users can add patterns via `.edgecoderignore`.
