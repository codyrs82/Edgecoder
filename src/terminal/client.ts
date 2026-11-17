// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * `edgecoder code`'s connection to the IDE provider: the shared-session API (src/apps/ide/
 * session-routes.ts) over HTTP with the IDE token, and the session's event stream (SSE) with
 * reconnects that resume after the last event seen.
 */

import type { PermissionMode } from "../apps/ide/permissions.js";
import type { ClientRef, QueuedMessage, SessionEvent, SessionSnapshot, SessionSummary } from "../apps/ide/sessions.js";

export class ProviderError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly body: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface RepoConnection {
  path: string;
  name: string;
  url: string;
  action: "cloned" | "updated";
  branch: string | null;
  message: string;
}

export interface DeviceLogin {
  id: string;
  state: "starting" | "waiting" | "done" | "error" | "cancelled";
  code: string | null;
  url: string;
  login: string | null;
  message: string | null;
}

export type Snapshot = SessionSnapshot & { trusted?: boolean };

export class ProviderClient {
  constructor(readonly baseUrl: string, private readonly token: string, readonly client: ClientRef) {}

  private headers(json: boolean): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...(json ? { "content-type": "application/json" } : {}) };
  }

  async req<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>, withClient = true): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(method === "POST"),
        ...(method === "POST" ? { body: JSON.stringify(withClient ? { ...this.client, ...(body ?? {}) } : body ?? {}) } : {}),
      });
    } catch (err) {
      throw new ProviderError(0, "unreachable", `Couldn't reach the EdgeCoder provider at ${this.baseUrl}: ${(err as Error).message}`);
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = { message: text };
    }
    if (!res.ok) {
      const code = typeof json.error === "string" ? json.error : `http_${res.status}`;
      const message = typeof json.message === "string" ? json.message : res.status === 401 ? "The provider refused the IDE token (~/.edgecoder/ide-token)." : `${method} ${path} failed (${res.status})`;
      throw new ProviderError(res.status, code, message, json);
    }
    return json as T;
  }

  /** The provider's /health, or null when nothing answers. */
  async health(): Promise<{ ok: boolean; version?: string } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok ? ((await res.json()) as { ok: boolean; version?: string }) : null;
    } catch {
      return null;
    }
  }

  /** Whether this provider has the shared-session routes (older desktop builds don't). */
  async hasSessions(): Promise<boolean> {
    try {
      await this.req("GET", "/v1/ide/sessions?published=1");
      return true;
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) return false;
      throw err;
    }
  }

  createSession(input: { projectRoot: string; model?: string; workerModel?: string; autoApprove?: "none" | "edits"; mode?: PermissionMode; published?: boolean }): Promise<Snapshot> {
    return this.req("POST", "/v1/ide/sessions", input);
  }
  snapshot(id: string): Promise<Snapshot> {
    return this.req("GET", `/v1/ide/sessions/${id}`);
  }
  async listSessions(query = ""): Promise<SessionSummary[]> {
    return (await this.req<{ sessions: SessionSummary[] }>("GET", `/v1/ide/sessions${query}`)).sessions;
  }
  /** Starts a turn, or queues the message while one runs (turnId null). */
  send(id: string, text: string): Promise<{ turnId: string | null; queued?: QueuedMessage }> {
    return this.req("POST", `/v1/ide/sessions/${id}/messages`, { text });
  }
  unqueue(id: string, queuedId: string): Promise<{ removed: boolean }> {
    return this.req("POST", `/v1/ide/sessions/${id}/unqueue`, { queuedId });
  }
  /** `applied` false: another client answered first. */
  approve(id: string, callId: string, approved: boolean, always = false): Promise<{ ok: boolean; applied?: boolean }> {
    return this.req("POST", `/v1/ide/sessions/${id}/approve`, { callId, approved, always });
  }
  takeControl(id: string): Promise<unknown> {
    return this.req("POST", `/v1/ide/sessions/${id}/control`, {});
  }
  releaseControl(id: string): Promise<unknown> {
    return this.req("POST", `/v1/ide/sessions/${id}/control`, { release: true });
  }
  settings(id: string, patch: { model?: string; leadModel?: string; workerModel?: string; title?: string; autoApprove?: "none" | "edits"; mode?: PermissionMode }): Promise<unknown> {
    return this.req("POST", `/v1/ide/sessions/${id}/settings`, patch);
  }
  approvePlan(id: string, mode: PermissionMode = "auto-edits"): Promise<{ turnId: string | null }> {
    return this.req("POST", `/v1/ide/sessions/${id}/plan`, { mode });
  }
  publish(id: string, published: boolean): Promise<unknown> {
    return this.req("POST", `/v1/ide/sessions/${id}/publish`, { published });
  }
  trust(id: string, trusted: boolean): Promise<{ trusted: boolean }> {
    return this.req("POST", `/v1/ide/sessions/${id}/trust`, { trusted });
  }
  cancel(id: string): Promise<unknown> {
    return this.req("POST", `/v1/ide/sessions/${id}/cancel`, {});
  }
  undo(id: string): Promise<{ turnId: string; reverted: string[] }> {
    return this.req("POST", `/v1/ide/sessions/${id}/undo`, {});
  }
  clear(id: string): Promise<unknown> {
    return this.req("POST", `/v1/ide/sessions/${id}/clear`, {});
  }
  githubStatus(): Promise<{ ghInstalled: boolean; loggedIn: boolean; login: string | null }> {
    return this.req("GET", "/v1/ide/git/github/status");
  }
  githubLogin(): Promise<DeviceLogin> {
    return this.req("POST", "/v1/ide/github/login", {}, false);
  }
  githubLoginStatus(id: string): Promise<DeviceLogin> {
    return this.req("GET", `/v1/ide/github/login/${id}`);
  }

  /** Clone (or update) a repository into the projects folder without changing the desktop's open project. */
  async connectRepo(repo: string, onProgress?: (line: string) => void): Promise<RepoConnection> {
    const res = await fetch(`${this.baseUrl}/v1/ide/repos/connect`, { method: "POST", headers: this.headers(true), body: JSON.stringify({ repo, stream: true, open: false }) });
    if (!res.ok || !res.body) {
      const j = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      throw new ProviderError(res.status, j.error ?? "error", j.message ?? `Couldn't connect ${repo} (${res.status}).`);
    }
    for await (const ev of sseEvents(res.body)) {
      const e = ev as { type?: string; line?: string; result?: RepoConnection; message?: string };
      if (e.type === "progress" && e.line) onProgress?.(e.line);
      else if (e.type === "done" && e.result) return e.result;
      else if (e.type === "error") throw new ProviderError(400, "git", e.message ?? "Couldn't connect the repository.");
    }
    throw new ProviderError(502, "closed", "The provider closed the connection before the repository was ready.");
  }

  /**
   * Follow a session's events from `since`. Reconnects (resuming after the last event) until
   * closed; `onResync` is called when the provider can't replay the gap.
   */
  follow(id: string, since: number, onEvent: (e: SessionEvent) => void, opts: { onDisconnect?: (err: Error) => void; retryMs?: number } = {}): { close: () => void; lastSeq: () => number } {
    let last = since;
    let closed = false;
    let abort = new AbortController();
    const loop = async () => {
      while (!closed) {
        try {
          const q = new URLSearchParams({ since: String(last), clientId: this.client.clientId, kind: this.client.kind, ...(this.client.label ? { label: this.client.label } : {}) });
          const res = await fetch(`${this.baseUrl}/v1/ide/sessions/${id}/events?${q}`, { headers: this.headers(false), signal: abort.signal });
          if (!res.ok || !res.body) throw new ProviderError(res.status, "events", `The session's event stream failed (${res.status}).`);
          for await (const ev of sseEvents(res.body)) {
            const e = ev as SessionEvent;
            if (typeof e.seq === "number" && e.type !== "resync") {
              if (e.seq <= last) continue;
              last = e.seq;
            } else if (e.type === "resync" && typeof e.seq === "number") {
              last = e.seq;
            }
            onEvent(e);
          }
          if (closed) return;
          throw new Error("The event stream ended.");
        } catch (err) {
          if (closed) return;
          opts.onDisconnect?.(err as Error);
          await new Promise((r) => setTimeout(r, opts.retryMs ?? 1000));
          abort = new AbortController();
        }
      }
    };
    void loop();
    return {
      close: () => {
        closed = true;
        abort.abort();
      },
      lastSeq: () => last,
    };
  }
}

/** JSON `data:` payloads of a Server-Sent Events body. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buf = "";
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = chunk
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        try {
          yield JSON.parse(data);
        } catch {
          // not JSON: skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
