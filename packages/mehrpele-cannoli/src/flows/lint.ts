// Flow lint (C4): what the translation lost or could not decide. Shown as a warning chip on the
// frame (never a modal) and listed in the run record. Only an unsupported diagram blocks a run.
import { EDGE_PREFIXES, edgeKindOfColor, type Translation } from "./translate";

/** `unplaced`: run objects the IdMap could not put on the diagram (added when the run ends). */
export type LintCode = "unsupported" | "dropped" | "alias" | "ambiguous-edge" | "config" | "unplaced";

export interface LintIssue {
  level: "warning" | "error";
  code: LintCode;
  message: string;
}

export interface LintResult {
  /** True when the flow must not run (the reason is the first error). */
  blocked: boolean;
  issues: LintIssue[];
}

/** Diagram types that translate to Cannoli nodes and edges (Pele's parsed type names). */
const SUPPORTED = new Set(["flowchart", "graph", "flowchart-v2", "state", "stateDiagram", "stateDiagram-v2"]);

export function lintFlow(t: Translation, frameDiagramType?: string): LintResult {
  const issues: LintIssue[] = [];
  const type = t.type !== "unknown" ? t.type : frameDiagramType ?? "unknown";
  if (!SUPPORTED.has(type) || t.fidelity === "embed") {
    issues.push({
      level: "error",
      code: "unsupported",
      message: `A ${type} diagram cannot run as a flow. Use a flowchart or a state diagram.`,
    });
  }
  for (const w of t.configWarnings) issues.push({ level: "warning", code: "config", message: w });
  for (const d of t.dropped) issues.push({ level: "warning", code: "dropped", message: `Not carried into the flow: ${d}` });
  for (const n of t.notes) issues.push({ level: "warning", code: "alias", message: n });
  if (t.fidelity !== "embed") {
    const label = (id: string) => t.canvas.nodes.find((n) => n.id === id)?.peleId ?? id;
    for (const e of t.canvas.edges) {
      const byColor = edgeKindOfColor(e.color);
      const byPrefix = e.label ? EDGE_PREFIXES[e.label[0]] : undefined;
      if (byColor && byColor !== "ignore" && byPrefix && byColor !== byPrefix) {
        issues.push({
          level: "warning",
          code: "ambiguous-edge",
          message: `Edge ${label(e.fromNode)} → ${label(e.toNode)}: its class says ${byColor} but its label prefix "${e.label![0]}" says ${byPrefix}; ${byColor} wins.`,
        });
      }
    }
  }
  return { blocked: issues.some((i) => i.level === "error"), issues };
}
