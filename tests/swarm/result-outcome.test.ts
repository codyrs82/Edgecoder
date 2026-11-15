import { describe, expect, it } from "vitest";
import { judgeResult } from "../../src/swarm/result-outcome.js";
import { executionOutcome } from "../../src/agent/worker.js";
import { dockerRunFailed } from "../../src/executor/docker-sandbox.js";
import type { RunResult } from "../../src/common/types.js";

/* Telling a failed program apart from a failed agent (buyer framing, docs/security/agent-threat-model.md). */

const code = { kind: "single_step", serverMeasuredMs: 2_000 };
const ran = { ok: false, executed: true, exitCode: 1, programError: "exit_nonzero" as const };

describe("judgeResult (coordinator)", () => {
  it("a program error the agent credibly ran is not its failure, and is paid", () => {
    expect(judgeResult(ran, code)).toEqual({ outcome: "program_error", payableFailure: true, legacy: false });
    expect(judgeResult({ ...ran, programError: "timeout", exitCode: 124 }, code).payableFailure).toBe(true);
  });

  it("an older agent's failure is its own and unpaid", () => {
    expect(judgeResult({ ok: false }, code)).toEqual({ outcome: "agent_failure", payableFailure: false, legacy: true });
  });

  it("a claimed program error that is not credible is the agent's failure and unpaid", () => {
    // Faster than a model call plus a sandbox run, on the coordinator's clock.
    expect(judgeResult(ran, { ...code, serverMeasuredMs: 50 })).toMatchObject({ outcome: "agent_failure", payableFailure: false, rejectedClaim: "too_fast" });
    // No exit status, or a "failed" exit 0.
    expect(judgeResult({ ...ran, exitCode: undefined }, code).outcome).toBe("agent_failure");
    expect(judgeResult({ ...ran, exitCode: 0 }, code).outcome).toBe("agent_failure");
    // Executed with no reason given.
    expect(judgeResult({ ok: false, executed: true, exitCode: 1 }, code).outcome).toBe("agent_failure");
    // Model calls have no program.
    expect(judgeResult(ran, { kind: "inference", serverMeasuredMs: 2_000 }).outcome).toBe("agent_failure");
  });

  it("a sandbox-policy refusal is the job's, but nothing ran so nothing is paid", () => {
    expect(judgeResult({ ok: false, executed: true, programError: "outside_subset" }, code)).toEqual({ outcome: "program_error", payableFailure: false, legacy: false });
  });

  it("an agent failure reported as such stays one", () => {
    expect(judgeResult({ ok: false, executed: false }, code)).toEqual({ outcome: "agent_failure", payableFailure: false, legacy: false });
  });
});

const run = (r: Partial<RunResult>): RunResult => ({ language: "python", ok: false, stdout: "", stderr: "", exitCode: 1, durationMs: 10, queueForCloud: false, ...r });

describe("executionOutcome (worker)", () => {
  it("reports what happened to the program", () => {
    expect(executionOutcome(run({ ok: true, exitCode: 0, executed: true }))).toEqual({ executed: true, exitCode: 0 });
    expect(executionOutcome(run({ exitCode: 1, executed: true }))).toEqual({ executed: true, exitCode: 1, programError: "exit_nonzero" });
    expect(executionOutcome(run({ exitCode: 124, executed: true, queueForCloud: true, queueReason: "timeout" }))).toEqual({ executed: true, exitCode: 124, programError: "timeout" });
    expect(executionOutcome(run({ exitCode: 137, executed: true, stderr: "\nDocker execution stopped: output exceeded 10 bytes" }))).toEqual({ executed: true, exitCode: 137, programError: "output_limit" });
    expect(executionOutcome(run({ queueForCloud: true, queueReason: "outside_subset" }))).toEqual({ executed: true, programError: "outside_subset" });
  });

  it("reports the agent's own failures as not executed", () => {
    expect(executionOutcome(run({ stderr: "sandbox_unavailable: Docker is required" }))).toEqual({ executed: false });
    expect(executionOutcome(run({ exitCode: 124, queueForCloud: true, queueReason: "timeout", executed: false }))).toEqual({ executed: false });
  });
});

describe("dockerRunFailed", () => {
  it("needs both a docker exit code and the Docker CLI's own message", () => {
    expect(dockerRunFailed(125, "docker: Error response from daemon: no such image")).toBe(true);
    expect(dockerRunFailed(127, "docker: executable file not found")).toBe(true);
    // A program may exit 125 itself.
    expect(dockerRunFailed(125, "Traceback: ValueError")).toBe(false);
    expect(dockerRunFailed(1, "docker: something")).toBe(false);
  });
});
