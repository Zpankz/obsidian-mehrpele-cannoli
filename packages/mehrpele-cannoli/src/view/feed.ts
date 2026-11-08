// What the run view and the status bar show: the most recent run (obsidian-free).
import type { ActiveRun } from "../run/runner";
import type { RunOutcome } from "../run/registry";

export type ViewRunStatus = "running" | "complete" | "error" | "stopped" | "refused";

export interface FeedState {
  flowPath: string;
  status: ViewRunStatus;
  active: ActiveRun | null;
  startedAt: number;
  endedAt: number | null;
  reason?: string;
}

export class RunFeed {
  state: FeedState | null = null;
  private listeners = new Set<() => void>();

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  started(active: ActiveRun): void {
    this.state = { flowPath: active.flowPath, status: "running", active, startedAt: active.handle.startedAt, endedAt: null };
    this.emit();
  }

  ended(flowPath: string, outcome: RunOutcome, active: ActiveRun | null, now = Date.now()): void {
    const cur = this.state;
    if (active) {
      // A replacement run of the same flow may already be showing; keep it.
      if (cur?.active && cur.active !== active) return;
    } else if (cur?.status === "running") {
      return; // a refusal never hides a run in progress
    }
    this.state = {
      flowPath,
      status: outcome.status,
      active,
      startedAt: active?.handle.startedAt ?? now,
      endedAt: now,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
    this.emit();
  }
}

/** "4.2 s", "1 min 05 s". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(Math.floor(s % 60)).padStart(2, "0")} s`;
}
