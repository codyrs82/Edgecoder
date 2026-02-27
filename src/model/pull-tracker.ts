// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

export interface PullProgress {
  model: string;
  status: string;
  progressPct: number;
  completed: number;
  total: number;
  startedAtMs: number;
  error?: string;
}

export class PullTracker {
  private current: PullProgress | null = null;

  getProgress(): PullProgress | null {
    return this.current ? { ...this.current } : null;
  }

  startPull(model: string): void {
    this.current = {
      model,
      status: "pulling",
      progressPct: 0,
      completed: 0,
      total: 0,
      startedAtMs: Date.now(),
    };
  }

  updateProgress(status: string, completed: number, total: number): void {
    if (!this.current) return;
    this.current.status = status;
    this.current.completed = completed;
    this.current.total = total;
    this.current.progressPct = total > 0 ? Math.round((completed / total) * 100) : 0;
  }

  completePull(): void {
    this.current = null;
  }

  failPull(error: string): void {
    if (this.current) {
      this.current.status = "error";
      this.current.error = error;
    }
  }
}
