// A fresh install gets one small model automatically, so it can chat, serve jobs and give Auto
// something local for quick tasks. Only when Ollama has no models yet; skippable; bigger models
// stay a choice on the Models page.

export const STARTER_MODEL = "qwen2.5-coder:1.5b";
const SKIP_KEY = "edgecoder-starter-model-skipped";

export function starterSkipped(store: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  try {
    return store?.getItem(SKIP_KEY) === "1";
  } catch {
    return false;
  }
}

export function skipStarter(store: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    store?.setItem(SKIP_KEY, "1");
  } catch {
    // storage unavailable: it asks again next launch
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Chat models installed (embedding models don't count). Null when Ollama isn't answering yet. */
export async function installedChatModels(ollamaBase: string, fetchFn: typeof fetch = fetch): Promise<string[] | null> {
  try {
    const res = await fetchFn(`${ollamaBase}/api/tags`);
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: Array<{ name: string }> };
    return (body.models ?? []).map((m) => m.name).filter((n) => !/embed/i.test(n));
  } catch {
    return null;
  }
}

export interface PullProgress {
  status: string;
  /** 0..100 while bytes are moving, else null. */
  percent: number | null;
}

/** Percent from one Ollama pull line ({status, total, completed}). */
export function pullPercent(line: { total?: number; completed?: number }): number | null {
  return line.total && line.total > 0 ? Math.min(100, Math.round(((line.completed ?? 0) / line.total) * 100)) : null;
}

/** Pull a model, reporting progress; resolves when Ollama says success. */
export async function pullWithProgress(ollamaBase: string, model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn(`${ollamaBase}/api/pull`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: model, stream: true }), signal });
  if (!res.ok || !res.body) throw new Error(`Ollama couldn't start the download (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const raw of lines) {
      if (!raw.trim()) continue;
      let line: { status?: string; total?: number; completed?: number; error?: string };
      try {
        line = JSON.parse(raw);
      } catch {
        continue;
      }
      if (line.error) throw new Error(line.error);
      onProgress({ status: line.status ?? "", percent: pullPercent(line) });
      if (line.status === "success") return;
    }
  }
}
