import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/svelte";
import { WORLD } from "../a11y/world-fixture";

const api = vi.hoisted(() => ({
  networkWorld: vi.fn(),
  isRemoteMode: vi.fn(() => false),
}));
vi.mock("../src/lib/api", () => ({ ...api, backendReady: Promise.resolve() }));

import MeshTopology from "../src/pages/MeshTopology.svelte";

beforeEach(() => {
  api.isRemoteMode.mockReturnValue(false);
  api.networkWorld.mockResolvedValue(structuredClone(WORLD));
});
afterEach(() => cleanup());

async function graphNodes() {
  const graph = await screen.findByRole("group", { name: /network graph/i });
  await waitFor(() => expect(within(graph).getAllByRole("button")).toHaveLength(WORLD.agents.length));
  return { graph, nodes: within(graph).getAllByRole("button") };
}
const details = () => screen.getByRole("complementary", { name: /machine details/i });

describe("Network page: the world view", () => {
  it("shows the network's totals, both coordinators and the link between them", async () => {
    render(MeshTopology);
    const summary = await screen.findByRole("region", { name: /network summary/i });
    expect(within(summary).getByText("Machines online").nextElementSibling?.textContent).toBe(String(WORLD.totals.online));
    expect(within(summary).getByText("Coordinators").nextElementSibling?.textContent).toBe("2");
    expect(within(summary).getByText("Models available").nextElementSibling?.textContent).toBe("4");
    // Nearest: the iad machine, 38 ms to the US coordinator + 3 ms from it.
    expect(within(summary).getByText("~41 ms")).toBeTruthy();
    const coords = screen.getByRole("region", { name: "Coordinators" });
    expect(within(coords).getByText(/coordinator\.edgecoder\.io · answering/)).toBeTruthy();
    expect(within(coords).getByText("coordinator-eu.edgecoder.io")).toBeTruthy();
    expect(within(coords).getByText(/meshed, 88 ms apart/)).toBeTruthy();
    // The old empty state is gone.
    expect(screen.queryByText(/no peers discovered/i)).toBeNull();
  });

  it("graph: a node per machine with one tab stop; yours named, others masked", async () => {
    render(MeshTopology);
    const { graph, nodes } = await graphNodes();
    expect(nodes.filter((n) => n.getAttribute("tabindex") === "0")).toHaveLength(1);
    const labels = nodes.map((n) => n.getAttribute("aria-label") ?? "");
    expect(labels.filter((l) => l.startsWith("Your machine"))).toHaveLength(2);
    expect(labels.some((l) => l.includes("codys-mac-studio (this computer)"))).toBe(true);
    for (const l of labels.filter((l) => !l.startsWith("Your machine"))) expect(l).toMatch(/^Machine [a-z]{3}-•••[0-9a-f]{4},/);
    // The coordinators are hubs in the graph.
    expect(within(graph).getByText("IAD")).toBeTruthy();
    expect(within(graph).getByText("FRA")).toBeTruthy();
  });

  it("graph: selecting a machine shows its models, class, region, load and estimated latency", async () => {
    render(MeshTopology);
    const { nodes } = await graphNodes();
    const gpu = nodes.find((n) => (n.getAttribute("aria-label") ?? "").includes("3f2a"))!;
    gpu.focus();
    await fireEvent.keyDown(gpu, { key: "Enter" });
    expect(gpu.getAttribute("aria-pressed")).toBe("true");
    const d = details();
    expect(within(d).getByRole("heading", { name: "lin-•••3f2a" })).toBeTruthy();
    expect(within(d).getByText("~56 ms")).toBeTruthy(); // 38 + 18
    expect(within(d).getByText(/ord · US · North America/)).toBeTruthy();
    expect(within(d).getByText(/gpu · gpu.24gb · 24 GB/)).toBeTruthy();
    expect(within(d).getByText("4 of 6 slots in use")).toBeTruthy();
    expect(within(d).getByText("deepseek-r1:32b")).toBeTruthy();
    await fireEvent.keyDown(gpu, { key: "Escape" });
    expect(within(details()).getByRole("heading", { name: /select a machine/i })).toBeTruthy();
  });

  it("graph: arrow keys move focus between machines", async () => {
    render(MeshTopology);
    const { nodes } = await graphNodes();
    const first = nodes.find((n) => n.getAttribute("tabindex") === "0")!;
    first.focus();
    await fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).not.toBe(first);
    expect((document.activeElement as Element).getAttribute("tabindex")).toBe("0");
  });

  it("cards: sorted nearest first by default, and by region, model or status", async () => {
    render(MeshTopology);
    await fireEvent.click(await screen.findByRole("button", { name: "Cards" }));
    const names = () => within(screen.getByRole("list", { name: /machines/i })).getAllByRole("listitem").map((li) => li.querySelector(".wname")?.textContent);
    // 38+3, then 38+18, 38+31 (yours), 38+34 ...; the stale machine with no figure last.
    expect(names().slice(0, 3)).toEqual(["lin-•••a1b8", "lin-•••3f2a", "codys-mac-studio (this computer)"]);
    expect(names().at(-1)).toBe("win-•••0d4e");
    await fireEvent.click(screen.getByRole("button", { name: /^Nearest/ }));
    expect(names()[0]).toBe("lin-•••9a30"); // farthest first (jnb via the EU coordinator: 112 + 161)

    await fireEvent.click(screen.getByRole("button", { name: /^Region/ }));
    expect(names()[0]).toBe("lin-•••9a30"); // AF first
    await fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    expect(names().at(-1)).toBe("win-•••0d4e");
    await fireEvent.click(screen.getByRole("button", { name: /^Model/ }));
    expect(names()[0]).toBe("lin-•••3f2a"); // deepseek-r1:32b
  });

  it("filters: my machines only, and by model", async () => {
    render(MeshTopology);
    await fireEvent.click(await screen.findByRole("button", { name: "Cards" }));
    await fireEvent.click(screen.getByRole("button", { name: /my machines/i }));
    const list = () => within(screen.getByRole("list", { name: /machines/i })).getAllByRole("listitem");
    expect(list().map((li) => li.querySelector(".wname")?.textContent).sort()).toEqual(["codys-mac-studio (this computer)", "codys-macbook-air"]);
    await fireEvent.click(screen.getByRole("button", { name: "Everyone" }));
    await fireEvent.change(screen.getByRole("combobox", { name: /model/i }), { target: { value: "qwen2.5-coder:32b" } });
    expect(list()).toHaveLength(2);
  });

  it("never shows another person's machine by name", async () => {
    render(MeshTopology);
    await graphNodes();
    await fireEvent.click(screen.getByRole("button", { name: "Cards" }));
    const text = document.body.textContent ?? "";
    for (const a of WORLD.agents.filter((x) => !x.mine)) expect(text).toContain(a.label);
    expect(text).not.toMatch(/agentId|ownerTag/);
  });

  it("says when this computer is not enrolled, instead of an empty graph", async () => {
    api.networkWorld.mockResolvedValue({ connected: false, reason: "not_enrolled" });
    render(MeshTopology);
    expect(await screen.findByText(/isn't on the network yet/i)).toBeTruthy();
    expect(screen.getByText(/Settings › Compute/)).toBeTruthy();
  });
});
