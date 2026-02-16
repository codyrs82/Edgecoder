import { ResourceClass } from "../common/types.js";

export interface LoadSnapshot {
  queuedTasks: number;
  activeAgents: number;
}

export function loadMultiplier(load: LoadSnapshot): number {
  const pressure = load.activeAgents === 0 ? 2 : load.queuedTasks / load.activeAgents;
  if (pressure <= 0.5) return 0.8;
  if (pressure <= 1.0) return 1.0;
  if (pressure <= 2.0) return 1.25;
  return 1.6;
}

export function baseRatePerSecond(resourceClass: ResourceClass): number {
  return resourceClass === "gpu" ? 4.0 : 1.0;
}
