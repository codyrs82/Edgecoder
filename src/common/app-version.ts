import { readFileSync } from "fs";

export function appVersion(): string {
  try {
    // src/common or dist/common -> repo root package.json
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}