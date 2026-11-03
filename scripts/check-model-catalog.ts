// Verify every catalog entry still exists on the Ollama registry.
//
//   npm run models:verify-catalog            # all entries
//   npx tsx scripts/check-model-catalog.ts qwen3.5:9b gemma4:e4b   # specific tags
//
// Checks the registry's OCI manifest for each tag
// (GET https://registry.ollama.ai/v2/library/<name>/manifests/<tag>), which is exactly what
// `ollama pull` fetches, so a tag this script accepts is pullable. (The registry does not serve
// the /tags/list endpoint, so tags are checked one by one.) Needs network access to
// registry.ollama.ai. Exit 1 when any tag is missing or the registry is unreachable, so it can
// gate a catalog refresh.
import { MODEL_CATALOG } from "../src/model/catalog.js";

const REGISTRY = process.env.OLLAMA_REGISTRY ?? "https://registry.ollama.ai";

type Check = { id: string; status: "ok" | "missing" | "error"; detail?: string; sizeBytes?: number };

async function checkTag(id: string): Promise<Check> {
  const [name, tag = "latest"] = id.split(":");
  try {
    const res = await fetch(`${REGISTRY}/v2/library/${encodeURIComponent(name)}/manifests/${encodeURIComponent(tag)}`, {
      headers: { accept: "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json" },
      signal: AbortSignal.timeout(20_000)
    });
    if (res.status === 404) return { id, status: "missing" };
    if (!res.ok) return { id, status: "error", detail: `registry answered ${res.status}` };
    const manifest = (await res.json()) as { layers?: Array<{ size?: number }> };
    const sizeBytes = (manifest.layers ?? []).reduce((s, l) => s + (Number(l.size) || 0), 0);
    return { id, status: "ok", sizeBytes };
  } catch (err) {
    return { id, status: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : MODEL_CATALOG.map((m) => m.modelId);
  const results = await Promise.all(wanted.map(checkTag));
  let bad = 0;
  for (const r of results) {
    const entry = MODEL_CATALOG.find((m) => m.modelId === r.id);
    const size = r.sizeBytes ? `${(r.sizeBytes / 1e9).toFixed(1)} GB` : "";
    const listed = entry ? `(catalog says ${entry.diskSize})` : "";
    const label = r.status === "ok" ? "ok     " : r.status === "missing" ? "MISSING" : "ERROR  ";
    console.log(`  ${label} ${r.id.padEnd(24)} ${size.padEnd(9)} ${listed} ${r.detail ?? ""}`.trimEnd());
    if (r.status !== "ok") bad++;
  }
  if (bad) {
    console.error(`check-model-catalog: ${bad} catalog tag(s) not found or not checkable on ${REGISTRY}`);
    process.exitCode = 1;
  } else {
    console.log(`check-model-catalog: all ${wanted.length} tag(s) exist on ${REGISTRY}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
