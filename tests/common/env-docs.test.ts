import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inferenceConfigSchema } from "../../src/inference/config.js";
import { portalConfigSchema } from "../../src/portal/config.js";
import { coordinatorConfigSchema } from "../../src/swarm/coordinator-config.js";
import { controlPlaneConfigSchema } from "../../src/control-plane/config.js";

// #15 acceptance: env docs match schema.
const doc = readFileSync(new URL("../../site-docs/reference/environment-variables.md", import.meta.url), "utf8");

const schemas = {
  inference: Object.keys(inferenceConfigSchema.shape),
  portal: Object.keys(portalConfigSchema.shape),
  coordinator: Object.keys(coordinatorConfigSchema.shape),
  "control-plane": Object.keys(controlPlaneConfigSchema.shape)
};

describe("environment-variables.md covers every schema key", () => {
  for (const [service, keys] of Object.entries(schemas)) {
    it(service, () => {
      expect(keys.filter((k) => !doc.includes(`\`${k}\``))).toEqual([]);
    });
  }
});
