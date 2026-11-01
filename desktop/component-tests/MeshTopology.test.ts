import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/svelte";

const api = vi.hoisted(() => ({
  getMeshPeers: vi.fn(),
  getMeshReputation: vi.fn(),
  getIdentity: vi.fn(),
  isRemoteMode: vi.fn(() => false),
}));
vi.mock("../src/lib/api", () => ({ ...api, backendReady: Promise.resolve() }));

import MeshTopology from "../src/pages/MeshTopology.svelte";

const peer = (id: string) => ({ peerId: id, publicKeyPem: "PEM", coordinatorUrl: `https://${id}.example`, networkMode: "public_mesh" as const });

beforeEach(() => {
  api.getMeshPeers.mockResolvedValue({ peers: [peer("peer-aaaa"), peer("peer-bbbb"), peer("peer-cccc")] });
  api.getMeshReputation.mockResolvedValue({ peers: [{ peerId: "peer-aaaa", score: 91 }] });
  api.getIdentity.mockResolvedValue({ peerId: "self-node", publicKeyPem: "SELFPEM", coordinatorUrl: "https://coord.example", networkMode: "public_mesh" });
});
afterEach(() => cleanup());

async function nodes() {
  const graph = await screen.findByRole("group", { name: /mesh graph/i });
  await waitFor(() => expect(within(graph).getAllByRole("button")).toHaveLength(4));
  return within(graph).getAllByRole("button");
}
const details = () => screen.getByRole("complementary", { name: /selected node details/i });

describe("MeshTopology graph", () => {
  it("has exactly one tab stop (roving tabindex)", async () => {
    render(MeshTopology);
    const all = await nodes();
    expect(all.filter((n) => n.getAttribute("tabindex") === "0")).toHaveLength(1);
  });

  it("arrow keys move focus between nodes", async () => {
    render(MeshTopology);
    const all = await nodes();
    const first = all.find((n) => n.getAttribute("tabindex") === "0")!;
    first.focus();
    await fireEvent.keyDown(first, { key: "ArrowRight" });
    const active = document.activeElement as Element;
    expect(active === first).toBe(false);
    expect(all.indexOf(active as HTMLElement)).toBeGreaterThan(-1);
    expect(active.getAttribute("tabindex")).toBe("0");
    expect(first.getAttribute("tabindex")).toBe("-1");
  });

  it("Enter selects a peer and shows its details; Escape clears", async () => {
    render(MeshTopology);
    const all = await nodes();
    const a = all.find((n) => /peer-aaaa/.test(n.getAttribute("aria-label") ?? ""))!;
    expect(a.getAttribute("aria-label")).toMatch(/reputation 91/);
    a.focus();
    await fireEvent.keyDown(a, { key: "Enter" });
    expect(a.getAttribute("aria-pressed")).toBe("true");
    expect(within(details()).getByText("https://peer-aaaa.example")).toBeTruthy();
    expect(within(details()).getByText("91")).toBeTruthy();
    await fireEvent.keyDown(a, { key: "Escape" });
    expect(a.getAttribute("aria-pressed")).toBe("false");
    expect(within(details()).getByText(/select a node/i)).toBeTruthy();
  });

  it("clicking the self node shows this node's identity; clicking again deselects", async () => {
    render(MeshTopology);
    const all = await nodes();
    const self = all.find((n) => /^This node/.test(n.getAttribute("aria-label") ?? ""))!;
    await fireEvent.click(self);
    expect(self.getAttribute("aria-pressed")).toBe("true");
    expect(within(details()).getByText("https://coord.example")).toBeTruthy();
    await fireEvent.click(self);
    expect(self.getAttribute("aria-pressed")).toBe("false");
  });

  it("only one node is selected at a time", async () => {
    render(MeshTopology);
    const all = await nodes();
    await fireEvent.click(all[1]);
    await fireEvent.click(all[2]);
    expect(all.filter((n) => n.getAttribute("aria-pressed") === "true")).toEqual([all[2]]);
  });
});
