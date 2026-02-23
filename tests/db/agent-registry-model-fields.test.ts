import { describe, it, expect } from "vitest";

// Test that the upsertAgent input type accepts model fields
// We can't test actual DB without a connection, so test the schema string
describe("agent_registry schema", () => {
  it("includes active_model column in schema SQL", async () => {
    const { SCHEMA_SQL } = await import("../../src/db/postgres.js");
    expect(SCHEMA_SQL).toContain("active_model TEXT");
    expect(SCHEMA_SQL).toContain("active_model_param_size DOUBLE PRECISION");
  });
});
