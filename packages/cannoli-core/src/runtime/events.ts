import type { CannoliObjectStatus } from "../graph";
import type { Lint } from "../language/lints";
import type { Message, ModelRef, Usage } from "../model/types";

/** Events supported by the current engine. Agent/retry/approval arrive with those phases. */
export type RunEvent =
  | {
      t: "run-start";
      runId: string;
      canvasPath: string;
      canvasHash: string;
      at: number;
    }
  | { t: "node-status"; id: string; status: CannoliObjectStatus; at: number }
  | {
      t: "model-request";
      id: string;
      callId: string;
      model: ModelRef;
      messages: Message[];
      tools?: string[];
    }
  | { t: "text-delta"; id: string; callId: string; text: string }
  | {
      t: "model-finish";
      id: string;
      callId: string;
      usage: Usage;
      ttftMs?: number;
      ms: number;
    }
  | { t: "lint"; lint: Lint }
  | {
      t: "run-finish";
      status: "completed" | "stopped" | "error";
      usage: Usage;
      costUsd: number | null;
      at: number;
    };

/** Synchronous delivery in execution order. A failing observer cannot break a run. */
export class RunEventBus {
  private readonly listeners = new Set<(event: RunEvent) => void>();
  private readonly pending: RunEvent[] = [];
  private delivering = false;

  subscribe(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: RunEvent): void {
    try {
      this.pending.push(structuredClone(event));
    } catch {
      return;
    }
    if (this.delivering) return;
    this.delivering = true;
    try {
      for (const queued of this.pending) {
        for (const listener of [...this.listeners]) {
          try {
            void Promise.resolve(listener(structuredClone(queued))).catch(
              () => {},
            );
          } catch {
            /* Observers do not control execution. */
          }
        }
      }
    } finally {
      this.pending.length = 0;
      this.delivering = false;
    }
  }
}
