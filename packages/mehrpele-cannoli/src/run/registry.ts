// Running flows, keyed by vault path (canvases) or frame key `sourcePath#fenceLine` (Mermaid flows,
                                                                  

export type RunStatus = "complete" | "error" | "stopped" | "refused";

export interface RunOutcome {
  status: RunStatus;
  reason?: string;
  recordPath?: string;
}

export interface RunHandle {
  /** The registry key: a vault path, or a frame key. */
  path: string;
  runId: string;
  startedAt: number;
  /** `reason` ends up in the stopped record and the notice (e.g. "Flow source changed, run stopped"). */
  stop(reason?: string): void;
  /** Settles when the run has finished and its record is written. */
  done: Promise<RunOutcome>;
}

export class RunRegistry {
  private runs = new Map<string, RunHandle>();
  private listeners = new Set<() => void>();

  get size(): number {
    return this.runs.size;
  }

  has(path: string): boolean {
    return this.runs.has(path);
  }

  get(path: string): RunHandle | undefined {
    return this.runs.get(path);
  }

  list(): RunHandle[] {
    return [...this.runs.values()];
  }

  add(handle: RunHandle): void {
    if (this.runs.has(handle.path)) throw new Error(`A run of ${handle.path} is already registered`);
    this.runs.set(handle.path, handle);
    this.emit();
  }

  /** Removes the entry only if it is still this run (a replacement may already be registered). */
  remove(path: string, runId: string): void {
    if (this.runs.get(path)?.runId !== runId) return;
    this.runs.delete(path);
    this.emit();
  }

  /** Stops the run of `path`. Returns false if none is running. */
  stop(path: string, reason?: string): boolean {
    const h = this.runs.get(path);
    if (!h) return false;
    h.stop(reason);
    return true;
  }

  /** Stops every run; returns how many were running. */
  stopAll(): number {
    const all = this.list();
    for (const h of all) h.stop();
    return all.length;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}
