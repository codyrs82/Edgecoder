// Copyright (c) 2025 EdgeCoder
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
  constructor({ machines = 1, index = 0, oversub = 1.5, autoSlots = 3, autoShare = 0, capacity = null, now = () => Date.now() } = {}) {
    Object.assign(this, { machines, index, oversub, autoSlots, autoShare, now });
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
    // "auto" lands on any model: its share of every slot (at least autoSlots).
    const total = Object.values(models).reduce((a, m) => a + Math.max(0, m.slots ?? 0), 0);
    this.netCap.auto = Math.max(this.autoSlots, Math.ceil(total * this.oversub * Math.min(1, Math.max(0, this.autoShare))));
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

  /**
   * Weighted pick over { modelId: weight } by weight x headroom; null when nothing has room.
   * avoid: capacity keys this caller must not use (a buyer's own agents hold them: no self-dealing).
   */
  pick(weights, r, avoid = null) {
    const options = [];
    for (const [id, w] of Object.entries(weights)) {
      const res = this.resolve(id);
      if (!res || w <= 0) continue;
      if (avoid?.has?.(res.key)) continue;
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

  /** This machine's whole-slot share of the model's real slots (no oversubscription). */
  slotShare(key) {
    const slots = key === "auto" ? 0 : this.capacity?.models?.[key]?.slots ?? DEFAULT_SLOTS[key] ?? 0;
    return shareOf(slots, this.machines, this.index, key);
  }

  /**
   * Slot utilization as this machine sees it: calls in flight over its share of the real slots,
   * summed over `keys` (the models its buyers may use; default all). 0..1; null with no slots.
   */
  utilization(keys = null) {
    let busy = 0, slots = 0;
    const classes = new Set();
    for (const k of keys ?? Object.keys(this.netCap)) {
      const s = this.slotShare(k);
      if (s <= 0) continue;
      slots += s;
      busy += Math.min(s, this.inflight[k] ?? 0);
      for (const c of this.capacity?.models?.[k]?.classes ?? []) classes.add(c);
    }
    // A machine's slots are shared by every model it holds (a Mac with 4 slots counts 4 for each of
    // its models): never count more slots than the classes holding these models have.
    const classSlots = [...classes].reduce((a, c) => a + (this.capacity?.classes?.[c]?.slots ?? Infinity), 0);
    if (classes.size && Number.isFinite(classSlots)) slots = Math.min(slots, classSlots / this.machines);
    return slots > 0 ? Math.min(1, busy / slots) : null;
  }

  /** Per-model caps on this machine, for the logs. */
  view() {
    return Object.fromEntries(Object.keys(this.netCap).map((k) => [k, { networkCap: this.netCap[k], share: this.share(k), inflight: this.inflight[k] ?? 0, penalty: this.penalty[k] ?? 0 }]));
  }
}

/**
 * Arrival-rate control: a load test holds its load instead of stopping.
 *
 * - schedule mode (ramp, steady, saturate, soak): the stage list says the rate, but never above
 *   `ceiling`. A breach (real-failure rate over the profile's threshold in the 30 s window) steps
 *   the rate down to the last rate that ran a clean window (or x0.7 when there is none lower) and
 *   makes that the ceiling, so later, higher stages hold the highest sustainable rate. Another
 *   breach steps down again, never below minRate. The run goes on to --duration.
 * - adaptive mode (the sustain profile): starts at startRate and every probeEverySec multiplies the
 *   rate by 1.5 while slot utilization is under the target band (and nothing breached); inside the
 *   band [low, high] it holds; above it, or on a breach, it steps down. After the probe it adjusts
 *   gently (x1.15 / x0.85) every adjustEverySec. A breach ceiling relaxes by 10% after 10 clean minutes.
 *
 * Errors never stop a run here; see fatalStop for what does.
 */
export class RateGovernor {
  constructor({ mode = "schedule", maxRate = Infinity, minRate = 0.02, startRate = null, breach = { errorRate: 0.1, minCalls: 20 }, target = [0.7, 0.85], probeEverySec = 60, adjustEverySec = 120, now = () => Date.now() } = {}) {
    Object.assign(this, { mode, maxRate, minRate, breach, target, probeEverySec, adjustEverySec, now });
    this.ceiling = Infinity;
    this.lastGood = 0;
    this.rate = Math.min(maxRate, startRate ?? minRate);
    this.phase = mode === "adaptive" ? "probe" : "schedule";
    this.lastAdjustMs = now();
    this.lastBreachMs = 0;
    this.lastRelaxMs = 0;
    this.utilSum = 0;
    this.utilN = 0;
    this.breaches = 0;
  }

  /** A new schedule stage: its rate, held under the ceiling. Adaptive mode keeps its own rate. */
  setStage(scheduled) {
    if (this.mode === "adaptive") return this.rate;
    this.rate = Math.max(0, Math.min(scheduled, this.ceiling, this.maxRate));
    return this.rate;
  }

  /** One utilization sample (0..1 or null), averaged until the next adjustment. */
  sample(util) {
    if (util === null || util === undefined || !Number.isFinite(util)) return;
    this.utilSum += util;
    this.utilN++;
  }

  #set(rate) {
    this.rate = Math.max(this.minRate, Math.min(this.maxRate, this.ceiling, rate));
    this.lastAdjustMs = this.now();
    this.utilSum = 0;
    this.utilN = 0;
    return this.rate;
  }

  /**
   * The 30 s window at a tick: { calls, failures }. Returns null (nothing changed) or
   * { action, rate, from, ... } for the log: backoff | probe_up | nudge_up | nudge_down | hold.
   */
  observe({ calls = 0, failures = 0 } = {}) {
    const now = this.now();
    const from = this.rate;
    const errorRate = calls ? failures / calls : 0;
    const breached = calls >= this.breach.minCalls && errorRate > this.breach.errorRate;
    if (breached) {
      if (now - this.lastBreachMs <= 30_000) return null; // one step per window
      this.lastBreachMs = now;
      this.breaches++;
      const down = this.lastGood > 0 && this.lastGood < from ? this.lastGood : from * 0.7;
      this.ceiling = Math.max(this.minRate, down);
      this.lastGood = 0;
      if (this.mode === "adaptive") this.phase = "hold";
      return { action: "backoff", from, rate: this.#set(down), ceiling: this.ceiling, errorRate: Math.round(errorRate * 1000) / 1000 };
    }
    if (calls >= Math.max(1, Math.ceil(this.breach.minCalls / 2))) this.lastGood = from;
    // A breach ceiling relaxes after 10 clean minutes (the trouble may have been a restart).
    if (Number.isFinite(this.ceiling) && now - Math.max(this.lastBreachMs, this.lastRelaxMs) > 600_000) {
      this.ceiling = this.ceiling * 1.1 >= this.maxRate ? Infinity : this.ceiling * 1.1;
      this.lastRelaxMs = now;
    }
    if (this.mode !== "adaptive") return null;
    const every = (this.phase === "probe" ? this.probeEverySec : this.adjustEverySec) * 1000;
    if (now - this.lastAdjustMs < every || !this.utilN) return null;
    const util = this.utilSum / this.utilN;
    const [low, high] = this.target;
    const u = Math.round(util * 1000) / 1000;
    if (util > high) {
      this.phase = "hold";
      return { action: "nudge_down", from, rate: this.#set(from * 0.85), util: u };
    }
    if (util < low && from < Math.min(this.maxRate, this.ceiling)) {
      const action = this.phase === "probe" ? "probe_up" : "nudge_up";
      return { action, from, rate: this.#set(from * (this.phase === "probe" ? 1.5 : 1.15)), util: u };
    }
    if (this.phase === "probe") this.phase = "hold";
    this.#set(from);
    return { action: "hold", from, rate: from, util: u };
  }
}

/** Errors that mean the coordinator (or the API in front of it) is down, not busy. */
export const DOWN_ERRORS = new Set(["network_error", "http_500", "http_502", "http_504", "http_520", "http_521", "http_522", "http_523", "http_524", "http_530"]);

/**
 * Whether a run must stop: only for real failure, never for capacity. Arguments: the 30 s window
 * ({ calls, errors: { type: n } }) and how many consecutive ticks the coordinator looked down.
 * Returns { stop, downTicks } where stop is null or "auth_failed" | "coordinator_down".
 * Budget and balance stops (budget_exhausted, all_users_stopped) are decided by the caller.
 */
export function fatalStop(window, downTicks = 0, { downTicksToStop = 12 } = {}) {
  const calls = window?.calls ?? 0;
  const errs = window?.errors ?? {};
  const auth = errs.auth_error ?? 0;
  if (auth >= 3 && auth / Math.max(1, calls) >= 0.5) return { stop: "auth_failed", downTicks };
  const down = Object.entries(errs).reduce((a, [k, n]) => a + (DOWN_ERRORS.has(k) ? n : 0), 0);
  const isDown = calls >= 3 && down / calls >= 0.9;
  const ticks = isDown ? downTicks + 1 : 0;
  // 12 ticks of 10 s: two minutes of nothing but connection failures and 5xx.
  return { stop: ticks >= downTicksToStop ? "coordinator_down" : null, downTicks: ticks };
}

/**
 * A pick with an "auto" share: with probability autoShare the call leaves the model to the
 * network (model "auto": the coordinator's best-fit routing picks model, class and machine), else
 * it names a model from the mix. When the side drawn has no room the other is tried. A buyer may
 * use auto even when it hosts agents: best-fit never places a call on the requester's own agents.
 * weights: { modelId: weight } (an "auto" entry in it is ignored; the share decides).
 */
export function pickWithAutoShare(planner, weights, r, avoid = null, autoShare = 0) {
  const { auto: _ignored, ...named } = weights;
  const share = Math.min(1, Math.max(0, Number(autoShare) || 0));
  const auto = () => (share > 0 ? planner.pick({ auto: 1 }, r, avoid) : null);
  if (share > 0 && r() < share) return auto() ?? planner.pick(named, r, avoid);
  return planner.pick(named, r, avoid) ?? auto();
}

/**
 * What a buyer's balance means for it: "ok", "pause" or "stop".
 *
 * `balance` is /v1/account's cSats at the last refresh, which already has the reserves of the
 * buyer's calls then in flight taken out (each call sets aside ~50-750 cSats up front and is
 * charged far less). `spent` is what calls started after that refresh were charged (calls already
 * in flight at the refresh are not added again: their reserve was already out of `balance`).
 * Below `minBalance` with calls of its own still in flight, the shortfall may be set-aside money
 * that comes back, so the buyer pauses until the next refresh; it stops only when nothing is in flight.
 */
export function balanceAction({ balance, spent = 0, inflight = 0, minBalance }) {
  if (balance === null || balance === undefined || !Number.isFinite(minBalance)) return "ok";
  if (balance - spent >= minBalance) return "ok";
  return inflight > 0 ? "pause" : "stop";
}

/** --model: pin every named-model call to one model ("qwen2.5-coder:1.5b" or "network/..."), or the mix as is. */
export function pinWeights(weights, pin) {
  if (!pin) return weights;
  return { [pin.includes("/") || pin === "auto" ? pin : `network/${pin}`]: 1 };
}
