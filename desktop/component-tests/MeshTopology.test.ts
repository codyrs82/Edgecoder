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

  it("your machine on the same local network: nearest to you, with a Same network badge and the measured ms", async () => {
    const w = structuredClone(WORLD);
    const air = w.agents.find((a) => a.name === "codys-macbook-air")!;
    (air as typeof air & { lan?: unknown }).lan = { sameNetwork: true, rttMs: 2.2 };
    api.networkWorld.mockResolvedValue(w);
    render(MeshTopology);
    const summary = await screen.findByRole("region", { name: /network summary/i });
    const tile = within(summary).getByText("Nearest to you").parentElement!;
    expect(within(tile).getByText("2 ms")).toBeTruthy();
    expect(tile.textContent).toContain("codys-macbook-air (same network)");
    // Graph: a dashed link from You with the measured round trip; the node says so.
    const { nodes } = await graphNodes();
    expect(nodes.find((n) => n.getAttribute("aria-label")?.startsWith("Your machine codys-macbook-air"))!.getAttribute("aria-label")).toContain("on your network, 2 ms from you");
    // Cards: the badge and the measured ms (no "~": it is not an estimate).
    await fireEvent.click(screen.getByRole("button", { name: "Cards" }));
    const card = within(screen.getByRole("list", { name: /machines/i })).getAllByRole("listitem").find((li) => li.textContent?.includes("codys-macbook-air"))!;
    expect(within(card).getByText("Same network")).toBeTruthy();
    expect(within(card).getByText("2 ms")).toBeTruthy();
    expect(card.textContent).not.toContain("~");
    // Nobody else is ever marked same network, and other people's machines stay masked.
    expect(screen.getAllByText("Same network")).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/192\.168/);
  });

  it("a single failed refresh is quiet: the last view stays with a muted note, no red banner", async () => {
    api.networkWorld.mockResolvedValueOnce(structuredClone(WORLD)).mockRejectedValue(Object.assign(new Error("bad gateway"), { status: 502 }));
    render(MeshTopology, { props: { pollInterval: 60 } });
    await screen.findByRole("region", { name: /network summary/i });
    await waitFor(() => expect(screen.getByText(/reconnecting…/)).toBeTruthy());
    expect(screen.queryByText(/couldn't refresh/i)).toBeNull();
    expect(screen.getByRole("region", { name: /network summary/i })).toBeTruthy();
  });

  it("an auth error shows the banner at once", async () => {
    api.networkWorld.mockResolvedValueOnce(structuredClone(WORLD)).mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }));
    render(MeshTopology, { props: { pollInterval: 60 } });
    await screen.findByRole("region", { name: /network summary/i });
    expect(await screen.findByText(/couldn't refresh the network view/i)).toBeTruthy();
  });

  it("says when this computer is not enrolled, instead of an empty graph", async () => {
    api.networkWorld.mockResolvedValue({ connected: false, reason: "not_enrolled" });
    render(MeshTopology);
    expect(await screen.findByText(/isn't on the network yet/i)).toBeTruthy();
    expect(screen.getByText(/Settings › Compute/)).toBeTruthy();
  });
});

describe("Network page: pulses", () => {
  /** WORLD, busy: lin-•••3f2a streams your reply and two others, work crosses the mesh. */
  function busyWorld() {
    const w = structuredClone(WORLD);
    const gpu = w.agents.find((a) => a.label === "lin-•••3f2a")!;
    for (const a of w.agents) a.activity = { callsNow: a.status === "busy" ? a.slotsUsed : 0, streaming: 0, callsPerMin: a.status === "stale" ? 0 : 1 };
    gpu.activity = { callsNow: 4, streaming: 3, callsPerMin: 14 };
    w.links = w.links.map((l) => ({ ...l, workPerMin: 12, gossipPerMin: 20 }));
    w.yourRequests = [{ coordinator: gpu.coordinatorId, machineKey: gpu.id, state: "streaming" }];
    return { w, gpu };
  }
  function setReducedMotion(on: boolean) {
    window.matchMedia = ((query: string) => ({
      matches: on && query.includes("prefers-reduced-motion"), media: query, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });

  it("dots travel the busy lines; your path is highlighted; idle lines have none", async () => {
    const { w, gpu } = busyWorld();
    api.networkWorld.mockResolvedValue(w);
    render(MeshTopology);
    const { graph } = await graphNodes();
    const dots = graph.querySelectorAll("circle.pulse");
    // gpu: 3 streaming; three busy machines 1 each; your reply to you (1); mesh work (2).
    expect(dots.length).toBe(9);
    expect(graph.querySelectorAll("circle.pulse.yours").length).toBe(4);
    expect(graph.querySelectorAll("animateMotion").length).toBe(9);
    expect(graph.querySelectorAll("line.spoke.yours").length).toBe(1);
    expect(graph.querySelectorAll("line.you-link.yours").length).toBe(1);
    expect(graph.querySelectorAll("circle.glow").length).toBe(4);
    expect(graph.querySelectorAll(".serving-ring").length).toBe(1);
    // Screen readers get a summary of who is busy and where your request runs.
    const describedBy = graph.getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)?.textContent).toBe(`4 machines busy; your request is running on ${gpu.label}; 12 calls a minute crossing between coordinators.`);
  });

  it("a refresh keeps the running dots (no restart)", async () => {
    const { w } = busyWorld();
    api.networkWorld.mockResolvedValue(w);
    render(MeshTopology, { props: { pollInterval: 40 } });
    const { graph } = await graphNodes();
    const first = graph.querySelector("circle.pulse.yours");
    expect(first).toBeTruthy();
    await new Promise((r) => setTimeout(r, 120));
    await waitFor(() => expect(api.networkWorld.mock.calls.length).toBeGreaterThan(2));
    expect(graph.querySelector("circle.pulse.yours")).toBe(first);
  });

  it("the details panel says what a machine is doing and that it serves you", async () => {
    const { w } = busyWorld();
    api.networkWorld.mockResolvedValue(w);
    render(MeshTopology);
    const { nodes } = await graphNodes();
    const gpu = nodes.find((n) => (n.getAttribute("aria-label") ?? "").includes("3f2a"))!;
    gpu.focus();
    await fireEvent.keyDown(gpu, { key: "Enter" });
    expect(within(details()).getByText("Serving 4 calls now · 14 calls in the last minute")).toBeTruthy();
    expect(within(details()).getByText("Serving you")).toBeTruthy();
  });

  it("reduced motion: no animated elements, a Live badge, line weight for load", async () => {
    setReducedMotion(true);
    const { w } = busyWorld();
    api.networkWorld.mockResolvedValue(w);
    render(MeshTopology);
    const { graph } = await graphNodes();
    expect(graph.querySelectorAll("circle.pulse, animate, animateMotion, line.beat").length).toBe(0);
    expect(graph.classList.contains("still")).toBe(true);
    expect(graph.querySelectorAll("line.spoke.lvl-3").length).toBe(1);
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("a hidden window pauses the animations and resumes when shown", async () => {
    const pause = vi.fn();
    const unpause = vi.fn();
    const proto = SVGSVGElement.prototype as unknown as { pauseAnimations?: () => void; unpauseAnimations?: () => void };
    const saved = { p: proto.pauseAnimations, u: proto.unpauseAnimations };
    proto.pauseAnimations = pause;
    proto.unpauseAnimations = unpause;
    try {
      api.networkWorld.mockResolvedValue(busyWorld().w);
      render(MeshTopology);
      const { graph } = await graphNodes();
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(graph.classList.contains("paused")).toBe(true));
      expect(pause).toHaveBeenCalled();
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(graph.classList.contains("paused")).toBe(false));
      expect(unpause).toHaveBeenCalled();
    } finally {
      proto.pauseAnimations = saved.p;
      proto.unpauseAnimations = saved.u;
    }
  });

  it("an older coordinator's answer (no activity) still draws: busy machines pulse gently, no path", async () => {
    render(MeshTopology);
    const { graph } = await graphNodes();
    expect(graph.querySelectorAll("circle.pulse.yours").length).toBe(0);
    expect(graph.querySelectorAll("circle.pulse").length).toBe(4);
    expect(document.getElementById("world-activity")?.textContent).toBe("4 machines busy.");
  });
  it("map words: in one layer over the lines and nodes, your long names short, hidden names shown on hover and focus", async () => {
    const long = "desktop-macbook-pro-crs-local-51738927";
    const base = structuredClone(WORLD);
    base.agents[1].name = long;
    // 30 machines: crowded, so only your own are named on the map until you point at one.
    const extra = Array.from({ length: 30 - base.agents.length }, (_, i) => ({ ...structuredClone(base.agents[3]), id: `x${String(i).padStart(3, "0")}`, label: `lin-•••${(0xa000 + i).toString(16)}` }));
    const w = { ...base, agents: [...base.agents, ...extra] };
    api.networkWorld.mockResolvedValue(w);
    render(MeshTopology);
    const graph = await screen.findByRole("group", { name: /network graph/i });
    await waitFor(() => expect(within(graph).getAllByRole("button")).toHaveLength(30));
    const layer = graph.querySelector("g.labels")!;
    // The layer is drawn last; nodes carry no words of their own.
    expect(graph.lastElementChild).toBe(layer);
    for (const n of graph.querySelectorAll("g[data-node]")) expect(n.querySelector("text")).toBeNull();
    for (const t of ["20 ms", "You", "coordinator.edgecoder.io"]) expect([...layer.querySelectorAll("text")].some((x) => x.textContent === t)).toBe(true);
    // Your long desktop name is short on the map, full in the tooltip and the accessible name.
    const mineNode = within(graph).getAllByRole("button").find((n) => n.getAttribute("aria-label")?.includes(long))!;
    expect(mineNode.querySelector("title")?.textContent).toBe(long);
    const mineLabel = layer.querySelector(`[data-label-for="${w.agents[1].id}"]`)!;
    expect(mineLabel.textContent).toBe("macbook-pro-crs");
    expect(mineLabel.classList.contains("off")).toBe(false);
    // Someone else's name is hidden on the crowded map, and shows on hover and on focus.
    const otherId = extra[0].id;
    const label = () => layer.querySelector(`[data-label-for="${otherId}"]`)!;
    expect(label().classList.contains("off")).toBe(true);
    expect(label().classList.contains("on")).toBe(false);
    const node = graph.querySelector(`g[data-node][aria-label*="${extra[0].label}"]`) as SVGGElement;
    await fireEvent.mouseEnter(node);
    expect(label().classList.contains("on")).toBe(true);
    await fireEvent.mouseLeave(node);
    expect(label().classList.contains("on")).toBe(false);
    await fireEvent.focus(node);
    expect(label().classList.contains("on")).toBe(true);
    await fireEvent.blur(node);
    expect(label().classList.contains("on")).toBe(false);
  });
});
