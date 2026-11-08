import type { RunEvent } from "../flows/engine";

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** Counts each call once; terminal usage is authoritative, including stopped runs. */
export class RunUsage {
  private readonly calls = new Map<string, Extract<RunEvent, { t: "model-finish" }>["usage"]>();
  private terminal: ModelUsage | null = null;
  coreRunId?: string;

  accept(event: RunEvent): ModelUsage | null {
    if (event.t === "run-start") this.coreRunId = event.runId;
    if (event.t === "model-finish") this.calls.set(event.callId, event.usage);
    if (event.t === "run-finish") this.terminal = {
      inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens, costUsd: event.costUsd,
    };
    return this.snapshot();
  }

  snapshot(): ModelUsage | null {
    if (this.terminal) return { ...this.terminal };
    if (!this.calls.size) return null;
    const calls = [...this.calls.values()];
    return {
      inputTokens: calls.reduce((n, u) => n + u.inputTokens, 0),
      outputTokens: calls.reduce((n, u) => n + u.outputTokens, 0),
      costUsd: calls.every(u => typeof u.costUsd === "number" && Number.isFinite(u.costUsd))
        ? calls.reduce((n, u) => n + u.costUsd!, 0) : null,
    };
  }
}
