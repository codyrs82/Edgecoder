// Framework-free so the root vitest suite can test it.

/** Readable text for an unknown thrown value. */
export function errorText(err: unknown, fallback = "Something went wrong"): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  if (typeof err === "string" && err.trim()) return err.trim();
  return fallback;
}
