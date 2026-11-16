// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The few Ollama calls remote model control needs (local server only), and the disk probe.
 * Every call is bounded by a timeout; a pull streams Ollama's NDJSON progress.
 */

import { existsSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { request } from "undici";

export interface OllamaModelInfo {
  name: string;
  sizeBytes: number;
  modifiedAt?: string;
}
export interface OllamaLoadedModel {
  name: string;
  sizeBytes: number;
  vramBytes: number;
  expiresAt?: string;
}
export interface PullProgress {
  status: string;
  completedBytes?: number;
  totalBytes?: number;
}

export interface OllamaAdmin {
  version(): Promise<string | undefined>;
  list(): Promise<OllamaModelInfo[]>;
  loaded(): Promise<OllamaLoadedModel[]>;
  pull(model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void>;
  remove(model: string): Promise<void>;
  /** Unloads a model now (keep_alive 0). */
  unload(model: string): Promise<void>;
}

function base(host: string | undefined): string {
  const h = host ?? "http://127.0.0.1:11434";
  return (h.startsWith("http") ? h : `http://${h}`).replace(/\/$/, "");
}

export function createOllamaAdmin(host: string | undefined, opts: { timeoutMs?: number; pullTimeoutMs?: number } = {}): OllamaAdmin {
  const url = base(host);
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const json = async (method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> => {
    const res = await request(`${url}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs
    });
    const text = await res.body.text();
    if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`ollama_${path.replace(/\W+/g, "_")}_${res.statusCode}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  };
  return {
    async version() {
      const v = (await json("GET", "/api/version")) as { version?: string };
      return typeof v.version === "string" ? v.version.slice(0, 32) : undefined;
    },
    async list() {
      const t = (await json("GET", "/api/tags")) as { models?: Array<{ name?: string; size?: number; modified_at?: string }> };
      return (t.models ?? [])
        .filter((m) => typeof m.name === "string")
        .slice(0, 200)
        .map((m) => ({ name: String(m.name), sizeBytes: Number(m.size) || 0, modifiedAt: m.modified_at }));
    },
    async loaded() {
      const t = (await json("GET", "/api/ps")) as { models?: Array<{ name?: string; size?: number; size_vram?: number; expires_at?: string }> };
      return (t.models ?? [])
        .filter((m) => typeof m.name === "string")
        .slice(0, 50)
        .map((m) => ({ name: String(m.name), sizeBytes: Number(m.size) || 0, vramBytes: Number(m.size_vram) || 0, expiresAt: m.expires_at }));
    },
    async pull(model, onProgress, signal) {
      const res = await request(`${url}/api/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, stream: true }),
        headersTimeout: 60_000,
        // Between chunks: a big layer can be quiet for a while, but not for this long.
        bodyTimeout: opts.pullTimeoutMs ?? 10 * 60_000,
        signal
      });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const text = await res.body.text().catch(() => "");
        throw new Error(`ollama_pull_${res.statusCode}: ${text.slice(0, 200)}`);
      }
      let buf = "";
      let lastError: string | undefined;
      for await (const chunk of res.body) {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const p = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
            if (p.error) lastError = String(p.error).slice(0, 200);
            else onProgress({ status: String(p.status ?? "").slice(0, 80), totalBytes: p.total, completedBytes: p.completed });
          } catch {
            /* a partial or odd line: skip */
          }
        }
      }
      if (lastError) throw new Error(`ollama_pull_error: ${lastError}`);
    },
    async remove(model) {
      await json("DELETE", "/api/delete", { model });
    },
    async unload(model) {
      await json("POST", "/api/generate", { model, keep_alive: 0 });
    }
  };
}

/** Where this machine's Ollama keeps models: OLLAMA_MODELS, the headless install's path, or ~/.ollama/models. */
export function ollamaModelsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OLLAMA_MODELS) return env.OLLAMA_MODELS;
  if (existsSync("/var/lib/edgecoder/ollama")) return "/var/lib/edgecoder/ollama";
  const home = join(homedir(), ".ollama", "models");
  return existsSync(home) ? home : homedir();
}

/** Free and total bytes of the filesystem holding `path`; undefined when it can't be read. */
export function diskSpace(path: string): { freeBytes: number; totalBytes: number } | undefined {
  try {
    const s = statfsSync(path);
    return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return undefined;
  }
}

/**
 * Download size of an Ollama library model from its registry manifest (sum of layer sizes), for
 * allowlisted models the catalog does not size. undefined when it cannot be found.
 */
export async function registryModelSize(model: string, opts: { registry?: string; timeoutMs?: number } = {}): Promise<number | undefined> {
  const [nameRaw, tag = "latest"] = model.split(":");
  const name = nameRaw.includes("/") ? nameRaw : `library/${nameRaw}`;
  try {
    const res = await request(`${opts.registry ?? "https://registry.ollama.ai"}/v2/${name}/manifests/${tag}`, {
      method: "GET",
      headers: { accept: "application/vnd.docker.distribution.manifest.v2+json" },
      headersTimeout: opts.timeoutMs ?? 8_000,
      bodyTimeout: opts.timeoutMs ?? 8_000,
      maxRedirections: 0
    } as Parameters<typeof request>[1]);
    if (res.statusCode !== 200) {
      await res.body.text().catch(() => undefined);
      return undefined;
    }
    const m = (await res.body.json()) as { layers?: Array<{ size?: number }>; config?: { size?: number } };
    const total = (m.layers ?? []).reduce((n, l) => n + (Number(l.size) || 0), 0) + (Number(m.config?.size) || 0);
    return total > 0 ? total : undefined;
  } catch {
    return undefined;
  }
}
