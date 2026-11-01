// Verify every catalog entry still exists on the Ollama registry.
//
//   npm run models:verify-catalog            # all entries
//   npx tsx scripts/check-model-catalog.ts qwen3.5:9b gemma4:e4b   # specific tags
//
// Uses the registry's OCI tag list (https://registry.ollama.ai/v2/library/<name>/tags/list),
// which is what `ollama pull` talks to, so a tag this script accepts is pullable. Needs
// network access to registry.ollama.ai. Exit 1 when any tag is missing or the registry is
// unreachable, so it can gate a catalog refresh.
import { MODEL_CATALOG } from "../src/model/catalog.js";

const REGISTRY = process.env.OLLAMA_REGISTRY ?? "https://registry.ollama.ai";

async function registryTags(name: string): Promise<string[] | null> {
  const res = await fetch(`${REGISTRY}/v2/library/${encodeURIComponent(name)}/tags/list`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000)
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`${name}: registry answered ${res.status}`);
  const body = (await res.json()) as { tags?: string[] };
  return body.tags ?? [];
}

async function main(): Promise<void> {
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : MODEL_CATALOG.map((m) => m.modelId);
  const byName = new Map<string, string[]>();
  for (const id of wanted) {
    const [name, tag = "latest"] = id.split(":");
    byName.set(name, [...(byName.get(name) ?? []), tag]);
  }
  let missing = 0;
  for (const [name, tags] of byName) {
    let available: string[] | null;
    try {
      available = await registryTags(name);
    } catch (err) {
      console.error(`  ERROR ${name}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      continue;
    }
    for (const tag of tags) {
      const ok = available?.includes(tag);
      console.log(`  ${ok ? "ok     " : "MISSING"} ${name}:${tag}${available && !ok ? `   (registry has: ${available.slice(0, 12).join(", ")}${available.length > 12 ? ", ..." : ""})` : ""}`);
      if (!ok) missing++;
    }
  }
  if (missing) {
    console.error(`check-model-catalog: ${missing} catalog tag(s) not found on ${REGISTRY}`);
    process.exitCode = 1;
  } else if (!process.exitCode) {
    console.log(`check-model-catalog: all ${wanted.length} tag(s) exist on ${REGISTRY}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
