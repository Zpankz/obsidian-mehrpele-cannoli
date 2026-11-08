import { CannoliObjectKind, CannoliObjectStatus } from "../graph";
import { CannoliVertex } from "../graph/objects/CannoliVertex";
import type { Run } from "../run";

/**
 * Mark every node that was still running with a warning, so a stopped run
 * shows where it was cut off. Call before the run records its stop time:
 * updates that arrive after it are dropped.
 */
export function warnExecutingNodes(run: Run, message: string): void {
  for (const object of Object.values(run.graph)) {
    if (
      object instanceof CannoliVertex &&
      object.kind === CannoliObjectKind.Node &&
      object.status === CannoliObjectStatus.Executing
    ) {
      object.warning(message);
    }
  }
}
