// #26: framework-free chart math for the Dashboard (no chart dependency).

/** Append a sample, keeping the newest `max`. Non-finite samples are dropped. */
export function pushSample(history: readonly number[], value: number, max: number): number[] {
  if (!Number.isFinite(value)) return [...history];
  return [...history, value].slice(-Math.max(1, max));
}

/** Per-interval increase of a monotonically growing counter (resets count as 0). */
export function counterDeltas(history: readonly number[]): number[] {
  return history.slice(1).map((v, i) => Math.max(0, v - history[i]));
}

export interface ChartBox {
  width: number;
  height: number;
  /** Top padding so the peak isn't clipped by the stroke. */
  pad?: number;
  /** Fixed y-axis max (e.g. 100 for percentages); defaults to the series max. */
  yMax?: number;
}

function scaled(values: readonly number[], box: ChartBox): Array<[number, number]> {
  const pad = box.pad ?? 4;
  const yMax = box.yMax ?? Math.max(...values, 1);
  const stepX = box.width / Math.max(values.length - 1, 1);
  const usable = box.height - pad;
  return values.map((v, i) => {
    const clamped = Math.min(Math.max(v, 0), yMax);
    const x = +(i * stepX).toFixed(2);
    const y = +(box.height - (clamped / yMax) * usable).toFixed(2);
    return [x, y];
  });
}

/** SVG polyline `points` for a line chart. */
export function linePoints(values: readonly number[], box: ChartBox): string {
  if (values.length === 0) return "";
  return scaled(values, box).map(([x, y]) => `${x},${y}`).join(" ");
}

/** SVG path `d` for the filled area under the line. */
export function areaPath(values: readonly number[], box: ChartBox): string {
  if (values.length < 2) return "";
  const pts = scaled(values, box);
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");
  return `${line} L${pts[pts.length - 1][0]},${box.height} L0,${box.height} Z`;
}

/** Text alternative for a chart, read by screen readers instead of the SVG. */
export function describeSeries(label: string, values: readonly number[], unit = ""): string {
  if (values.length === 0) return `${label}: no data yet`;
  const fmt = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}${unit}`;
  const latest = values[values.length - 1];
  return `${label}: latest ${fmt(latest)}, min ${fmt(Math.min(...values))}, max ${fmt(Math.max(...values))} over ${values.length} samples`;
}

/** Clamp a percentage for progress bars and aria-valuenow. */
export function clampPercent(n: number): number {
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0;
}
