// Read-only snapshots from Obsidian's native query engine and resolved vault graph.
import { cancellable } from "./cancel";
import type { WorkflowData } from "./workflow";
interface QueryHandler {
  handler(params: Record<string, string>): Promise<string> | string;
}
interface DataApp {
  cli?: { handlers?: Map<string, QueryHandler> };
  metadataCache: { resolvedLinks?: Record<string, Record<string, number>> };
}
export function nativeWorkflowData(app: DataApp): WorkflowData {
  return {
    async readBase(path, view, signal) {
      if (signal?.aborted) throw Error("Workflow stopped before Bases query");
      const registry = app.cli?.handlers;
      const query =
        typeof registry?.get === "function"
          ? registry.get("base:query")
          : undefined;
      if (typeof query?.handler !== "function")
        throw Error(
          "This Obsidian version does not expose native Bases queries; no approximate query was substituted",
        );
      // The native handler reads/query-evaluates the file, even when it is not open.
      // Its JSON values are display strings, not the typed GUI query objects.
      const result = await cancellable(
        () =>
          query.handler({ path, format: "json", ...(view ? { view } : {}) }),
        signal,
      );
      if (signal?.aborted) throw Error("Workflow stopped during Bases query");
      return {
        base: path,
        view: view || null,
        representation: "native-display-rows",
        rows: JSON.parse(result) as unknown,
      };
    },
    links(path) {
      const graph = app.metadataCache.resolvedLinks ?? {};
      const edges = new Map<string, { from: string; to: string }>();
      for (const to of Object.keys(graph[path] ?? {}))
        edges.set(JSON.stringify([path, to]), { from: path, to });
      for (const [from, targets] of Object.entries(graph))
        if (targets[path]) edges.set(JSON.stringify([from, path]), { from, to: path });
      return [...edges.values()].sort((a,b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    },
  };
}
