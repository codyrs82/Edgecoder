// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Capacity-aware model choice for the load generator.
 *
 * The network's slots are uneven: ~20 CPU slots hold qwen2.5-coder:1.5b, one GPU slot holds
 * qwen3-coder:30b, a Mac or two hold the 7b. A fixed mix piles calls onto the scarce slots, gets
 * no_capacity there, and the error threshold stops the run while the CPU fleet sits idle. So:
 *
 * - Each model has a network-wide in-flight cap: its slot count for scarce models (fewer than
 *   BULK_MIN_SLOTS slots), slots x oversub for the bulk ones (default 1.5, so the bulk fleet can
 *   actually be saturated and queue). "auto" gets autoSlots. The cap is split between the
 *   load-generator machines (whole slots, the remainder rotated per model so one machine does not
 *   get every odd slot).
 * - A model is picked with weight = mix weight x this machine's headroom (cap - in flight -
 *   penalty), so most of the load lands on the models with free slots.
 * - Per-model backoff: a no_capacity (or timeout) while this machine already uses its whole share
 *   of the model is "over_capacity": expected, not counted toward the global stop, and it adds a
 *   penalty (one slot less) that decays by one every 30 s without another.
 * - A model asked for in a class nobody holds it in (e.g. 7b@apple while the Mac reports cpu) is
 *   sent without the class; a model with no slots at all is not picked.
 */
export const BULK_MIN_SLOTS = 5;
export const DEFAULT_SLOTS = { "qwen2.5-coder:1.5b": 16, "qwen3-coder:30b": 1, "qwen2.5-coder:7b": 1 };
const PENALTY_DECAY_MS = 30_000;

/** "network/qwen2.5-coder:7b@apple" -> { key: "qwen2.5-coder:7b", cls: "apple" }; "auto" -> { key: "auto" }. */
export function parseModelId(id) {
  if (id === "auto") return { key: "auto", cls: null };
  const rest = id.startsWith("network/") ? id.slice(8) : id;
  const at = rest.lastIndexOf("@");
  return at > 0 ? { key: rest.slice(0, at), cls: rest.slice(at + 1) } : { key: rest, cls: null };
}

const hash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

/** This machine's whole-slot share of a network-wide cap. */
export function shareOf(netCap, machines, index, key) {
  if (!Number.isFinite(netCap)) return Infinity;
  const base = Math.floor(netCap / machines), rem = netCap % machines;
  const offset = hash(key) % machines;
  return base + (((index - offset + machines) % machines) < rem ? 1 : 0);
}

export class CapacityPlanner {
  constructor({ machines = 1, index = 0, oversub = 1.5, autoSlots = 3, capacity = null, now = () => Date.now() } = {}) {
    Object.assign(this, { machines, index, oversub, autoSlots, now });
    this.inflight = {};
    this.penalty = {};
    this.lastOver = {};
    this.noted = new Set();
    this.setCapacity(capacity);
  }

  /** capacity: capacity.mjs snapshot ({ models: { key: { slots, classes } } }) or null for defaults. */
  setCapacity(capacity) {
    this.capacity = capacity;
    this.netCap = {};
    const models = capacity?.models ?? Object.fromEntries(Object.entries(DEFAULT_SLOTS).map(([k, slots]) => [k, { slots, classes: [] }]));
    for (const [key, m] of Object.entries(models)) {
      this.netCap[key] = m.slots >= BULK_MIN_SLOTS ? Math.ceil(m.slots * this.oversub) : m.slots;
    }
    this.netCap.auto = this.autoSlots;
  }

  /** The model id to send and its capacity key, or null when nobody holds the model. */
  resolve(id) {
    const { key, cls } = parseModelId(id);
    if (key === "auto") return { id, key };
    const m = this.capacity?.models?.[key];
    if (this.capacity && (!m || m.slots <= 0)) return null;
    if (cls && cls !== "any" && m && m.classes?.length && !m.classes.includes(cls)) return { id: `network/${key}`, key, rewrittenFrom: id };
    if (!this.capacity && !(key in this.netCap)) return { id, key };
    return { id, key };
  }

  share(key) {
    return shareOf(this.netCap[key] ?? Infinity, this.machines, this.index, key);
  }

  /** Free in-flight allowance on this machine for a capacity key. */
  headroom(key) {
    this.decay(key);
    return Math.max(0, this.share(key) - (this.penalty[key] ?? 0) - (this.inflight[key] ?? 0));
  }

  decay(key) {
    const p = this.penalty[key] ?? 0;
    if (!p) return;
    const steps = Math.floor((this.now() - (this.lastOver[key] ?? 0)) / PENALTY_DECAY_MS);
    if (steps > 0) {
      this.penalty[key] = Math.max(0, p - steps);
      this.lastOver[key] = this.now();
    }
  }

  /** Weighted pick over { modelId: weight } by weight x headroom; null when nothing has room. */
  pick(weights, r) {
    const options = [];
    for (const [id, w] of Object.entries(weights)) {
      const res = this.resolve(id);
      if (!res || w <= 0) continue;
      const room = this.headroom(res.key);
      if (room <= 0) continue;
      options.push({ ...res, weight: w * Math.min(room, 1_000) });
    }
    if (!options.length) return null;
    const total = options.reduce((a, o) => a + o.weight, 0);
    let x = r() * total;
    for (const o of options) if ((x -= o.weight) < 0) return o;
    return options[options.length - 1];
  }

  /** Mark a call started; returns whether it took this machine's last slot of the model. */
  start(key) {
    this.inflight[key] = (this.inflight[key] ?? 0) + 1;
    return this.inflight[key] >= this.share(key);
  }

  /**
   * Mark a call finished and turn its error into the one recorded: a no_capacity or timeout at
   * full share becomes "over_capacity" / "timeout_over_capacity" and backs the model off.
   */
  finish(key, error, atCap) {
    this.inflight[key] = Math.max(0, (this.inflight[key] ?? 1) - 1);
    if ((error === "no_capacity" || error === "timeout") && atCap) {
      this.penalty[key] = Math.min(this.share(key), (this.penalty[key] ?? 0) + 1);
      this.lastOver[key] = this.now();
      return error === "timeout" ? "timeout_over_capacity" : "over_capacity";
    }
    return error;
  }

  /** Per-model caps on this machine, for the logs. */
  view() {
    return Object.fromEntries(Object.keys(this.netCap).map((k) => [k, { networkCap: this.netCap[k], share: this.share(k), inflight: this.inflight[k] ?? 0, penalty: this.penalty[k] ?? 0 }]));
  }
}
