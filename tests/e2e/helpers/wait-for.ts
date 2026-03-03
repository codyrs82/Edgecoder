export async function waitForUrl(
  url: string,
  opts: { timeoutMs?: number; intervalMs?: number; expectStatus?: number } = {}
): Promise<void> {
  const { timeoutMs = 60_000, intervalMs = 2_000, expectStatus = 200 } = opts;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === expectStatus) return;
    } catch {
      // service not up yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${url} after ${timeoutMs}ms`);
}

export async function waitForCondition(
  check: () => Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {}
): Promise<void> {
  const { timeoutMs = 60_000, intervalMs = 2_000, label = "condition" } = opts;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}
