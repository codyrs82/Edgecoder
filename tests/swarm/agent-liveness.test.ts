import { beforeEach, describe, expect, it } from "vitest";
import {
  agentSocketLost,
  agentsLostFor,
  noteAgentHttpAlive,
  noteAgentSocketClosed,
  noteAgentSocketOpen,
  resetAgentLiveness,
  socketLostForMs,
} from "../../src/swarm/coordinator/agent-liveness.js";

/*
 * #524: an agent whose authenticated socket closed, and that has not been heard from over HTTP
 * since, is lost at once. An agent that never had a socket (HTTP pull only) is never "lost" here;
 * its 2-minute window is all that applies, as before.
 */

beforeEach(() => resetAgentLiveness());

describe("socket liveness", () => {
  it("a pull-only agent (never had a socket) is never lost", () => {
    noteAgentHttpAlive("pull-only", 1_000);
    expect(agentSocketLost("pull-only", 500_000)).toBe(false);
    expect(socketLostForMs("unknown", 500_000)).toBeNull();
  });

  it("an open socket is live; a closed one is lost until the agent is heard from again", () => {
    noteAgentSocketOpen("a", 1_000);
    noteAgentHttpAlive("a", 2_000);
    expect(agentSocketLost("a", 3_000)).toBe(false);
    noteAgentSocketClosed("a", 10_000);
    expect(agentSocketLost("a", 10_000)).toBe(true);
    expect(socketLostForMs("a", 16_000)).toBe(6_000);
    // A request it sent before the close does not count; one after it does (its socket is reconnecting).
    noteAgentHttpAlive("a", 9_999);
    expect(agentSocketLost("a", 16_000)).toBe(true);
    noteAgentHttpAlive("a", 17_000);
    expect(agentSocketLost("a", 18_000)).toBe(false);
  });

  it("a reconnected socket is live again", () => {
    noteAgentSocketOpen("b", 1_000);
    noteAgentSocketClosed("b", 5_000);
    expect(agentSocketLost("b", 6_000)).toBe(true);
    noteAgentSocketOpen("b", 7_000);
    expect(agentSocketLost("b", 8_000)).toBe(false);
  });

  it("lists agents lost for at least a grace period", () => {
    noteAgentSocketOpen("old", 0);
    noteAgentSocketClosed("old", 1_000);
    noteAgentSocketOpen("new", 0);
    noteAgentSocketClosed("new", 20_000);
    noteAgentSocketOpen("live", 0);
    expect(agentsLostFor(15_000, 25_000)).toEqual(["old"]);
    expect(agentsLostFor(0, 25_000).sort()).toEqual(["new", "old"]);
  });
});
