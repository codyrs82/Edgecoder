// #28: radial layout for the mesh graph: this node in the centre, peers on a ring. Framework-free.

export interface GraphNode {
  id: string;
  x: number;
  y: number;
  self: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface MeshLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Peers are sorted by id so positions stay put across polls. The ring radius grows with the peer
 * count so nodes keep at least `minGap` px between centres.
 */
export function radialLayout(peerIds: readonly string[], selfId: string, size = 400, minGap = 56): MeshLayout {
  const c = size / 2;
  const others = [...new Set(peerIds)].filter((id) => id && id !== selfId).sort();
  const center: GraphNode = { id: selfId || "self", x: c, y: c, self: true };
  if (others.length === 0) return { nodes: [center], edges: [] };
  const needed = (minGap * others.length) / (2 * Math.PI);
  const radius = Math.max(size * 0.36, needed);
  const nodes = others.map((id, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / others.length;
    return { id, x: +(c + radius * Math.cos(a)).toFixed(1), y: +(c + radius * Math.sin(a)).toFixed(1), self: false };
  });
  return { nodes: [center, ...nodes], edges: nodes.map((n) => ({ from: center.id, to: n.id })) };
}

/** viewBox that fits every node plus padding (the ring can outgrow `size`). */
export function fitViewBox(nodes: readonly GraphNode[], pad = 40): string {
  if (nodes.length === 0) return "0 0 100 100";
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
  return `${minX} ${minY} ${Math.max(...xs) + pad - minX} ${Math.max(...ys) + pad - minY}`;
}

/** Arrow-key movement between ring nodes (wraps); returns the next index or null. */
export function nextNodeIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (current + 1 + count) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
