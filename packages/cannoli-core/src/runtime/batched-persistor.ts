import { CannoliObjectStatus } from "../graph";
import type { Persistor, PersistorEdit } from "../persistor";

type ObjectEdit = Extract<PersistorEdit, { type: "node" | "edge" }>;
const status = (edit: ObjectEdit) =>
  (edit.type === "node" ? edit.node : edit.edge).cannoliData.status;

/** Coalesces snapshots without delaying graph execution. flush() is the durability boundary. */
export class BatchedPersistor implements Persistor {
  private readonly pending = new Map<string, PersistorEdit>();
  private readonly statuses = new Map<string, CannoliObjectStatus>();
  private readonly writtenStatuses = new Map<string, CannoliObjectStatus>();
  private readonly seenExecuting = new Set<string>();
  private readonly paints = new Map<
    string,
    { executing: ObjectEdit; until?: number }
  >();
  private timer?: ReturnType<typeof setTimeout>;
  private deadline = Infinity;
  private readonly writtenAt = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  private failure?: unknown;
  private started = false;
  private startup: Promise<void> = Promise.resolve();

  constructor(private readonly target: Persistor) {}

  async start(data: Parameters<Persistor["start"]>[0]): Promise<void> {
    if (this.started) await this.flush();
    this.started = true;
    this.statuses.clear();
    this.writtenStatuses.clear();
    this.writtenAt.clear();
    this.seenExecuting.clear();
    this.paints.clear();
    this.startup = this.target.start(data);
    await this.startup;
  }

  setConfig(config: Record<string, unknown>): void {
    this.target.setConfig(config);
  }
  editNode(node: Parameters<Persistor["editNode"]>[0]): Promise<void> {
    return this.object({ type: "node", node });
  }
  editEdge(edge: Parameters<Persistor["editEdge"]>[0]): Promise<void> {
    return this.object({ type: "edge", edge });
  }
  addError(id: string, message: string): Promise<void> {
    return this.put(
      `error:${JSON.stringify([id, message])}`,
      { type: "error", id, message },
      true,
    );
  }
  addWarning(id: string, message: string): Promise<void> {
    return this.put(
      `warning:${JSON.stringify([id, message])}`,
      { type: "warning", id, message },
      true,
    );
  }
  editOriginalParallelGroupLabel(id: string, label: string): Promise<void> {
    return this.put(`label:${id}`, { type: "label", id, label }, false);
  }

  private object(edit: ObjectEdit): Promise<void> {
    const id = edit.type === "node" ? edit.node.id : edit.edge.id;
    const key = `${edit.type}:${id}`;
    const next = status(edit);
    const changed = this.statuses.get(key) !== next;
    this.statuses.set(key, next);
    if (
      next === CannoliObjectStatus.Executing &&
      !this.seenExecuting.has(key)
    ) {
      this.seenExecuting.add(key);
      this.paints.set(key, { executing: structuredClone(edit) });
    }
    return this.put(key, edit, changed);
  }

  private put(
    key: string,
    edit: PersistorEdit,
    urgent: boolean,
  ): Promise<void> {
    this.pending.set(key, structuredClone(edit));
    this.schedule(
      urgent
        ? Date.now()
        : Math.max(Date.now(), (this.writtenAt.get(key) ?? -Infinity) + 250),
    );
    // Existing graph callers enqueue without awaiting. Errors are reported by flush().
    return Promise.resolve();
  }

  private schedule(at: number): void {
    if (this.failure || (this.timer && this.deadline <= at)) return;
    if (this.timer) clearTimeout(this.timer);
    this.deadline = at;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.deadline = Infinity;
        void this.drain().catch(() => {});
      },
      Math.max(0, at - Date.now()),
    );
  }

  private drain(final = false): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      const chosen: [string, PersistorEdit][] = [];
      const starting: string[] = [];
      let nextPaint = Infinity;
      for (const [key, edit] of this.pending) {
        const paint = this.paints.get(key);
        if (paint && (edit.type === "node" || edit.type === "edge")) {
          if (paint.until === undefined) {
            chosen.push([
              key,
              status(edit) === CannoliObjectStatus.Executing
                ? edit
                : paint.executing,
            ]);
            starting.push(key);
            continue;
          }
          if (status(edit) !== CannoliObjectStatus.Executing) {
            if (Date.now() < paint.until) {
              nextPaint = Math.min(nextPaint, paint.until);
              continue;
            }
            this.paints.delete(key);
          }
        }
        // Chat response nodes execute/complete for every chunk. Compare the
        // coalesced status with the last painted one, not intermediate updates.
        if (
          !final &&
          (edit.type === "node" || edit.type === "edge") &&
          this.writtenStatuses.get(key) === status(edit) &&
          Date.now() < (this.writtenAt.get(key) ?? -Infinity) + 250
        ) {
          nextPaint = Math.min(
            nextPaint,
            (this.writtenAt.get(key) ?? -Infinity) + 250,
          );
          continue;
        }
        chosen.push([key, edit]);
      }
      if (chosen.length) {
        // Delete only the snapshots being written: updates during I/O stay queued.
        for (const [key, edit] of chosen) {
          if (this.pending.get(key) === edit) this.pending.delete(key);
        }
        try {
          const edits = chosen.map(([, edit]) => edit);
          if (this.target.applyBatch) await this.target.applyBatch(edits);
          else for (const edit of edits) await this.apply(edit);
          const now = Date.now();
          for (const [key, edit] of chosen) {
            this.writtenAt.set(key, now);
            if (edit.type === "node" || edit.type === "edge")
              this.writtenStatuses.set(key, status(edit));
          }
          for (const key of starting) {
            const paint = this.paints.get(key);
            if (paint) {
              paint.until = now + 300;
              nextPaint = Math.min(nextPaint, paint.until);
            }
          }
        } catch (error) {
          this.failure = error;
          throw error;
        }
      }
      if (this.pending.size)
        this.schedule(
          Number.isFinite(nextPaint)
            ? nextPaint
            : Math.min(
                ...[...this.pending.keys()].map(
                  (key) => (this.writtenAt.get(key) ?? -Infinity) + 250,
                ),
              ),
        );
    });
    return this.queue;
  }

  private async apply(edit: PersistorEdit): Promise<void> {
    switch (edit.type) {
      case "node":
        return this.target.editNode(edit.node);
      case "edge":
        return this.target.editEdge(edit.edge);
      case "error":
        return this.target.addError(edit.id, edit.message);
      case "warning":
        return this.target.addWarning(edit.id, edit.message);
      case "label":
        return this.target.editOriginalParallelGroupLabel(edit.id, edit.label);
    }
  }

  async flush(): Promise<void> {
    await this.startup;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.deadline = Infinity;
    await this.drain(true);
    while (this.pending.size) {
      const until = Math.min(
        ...[...this.pending.keys()].map(
          (key) => this.paints.get(key)?.until ?? Date.now(),
        ),
      );
      if (Number.isFinite(until) && until > Date.now()) {
        await new Promise((resolve) => setTimeout(resolve, until - Date.now()));
      }
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.deadline = Infinity;
      await this.drain(true);
    }
    await this.target.flush?.();
  }
}
