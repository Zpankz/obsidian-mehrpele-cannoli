import {
  CallNodeType,
  EdgeType,
  FloatingNodeType,
  ReferenceType,
  type CannoliNodeData,
  type VerifiedCannoliCanvasData,
} from "../graph";
import { parseNamedNode, safeKeyName } from "../utility";

export type Lint = {
  code: string;
  severity: "error" | "warning";
  nodeId: string;
  message: string;
};

const CALL_NODE_TYPES: string[] = Object.values(CallNodeType);

/**
 * L-secret-in-prompt: a call-family node (standard call, choose, form) whose
 * text references a secret by name (`{{NAME}}`) would send the secret's value to
 * the LLM. Each such node and secret is an error. The message names the node and
 * the secret, never the value. Content and HTTP nodes may use secrets. A name an
 * incoming variable arrow, a form node's field or a floating node supplies is
 * not flagged: those take precedence over the secret when the reference
 * resolves.
 */
export function lintSecretInPrompt(
  data: VerifiedCannoliCanvasData,
  secretNames: string[],
): Lint[] {
  const secrets = new Set(secretNames);
  if (secrets.size === 0) return [];

  // At runtime a floating node of the same name wins over the secret.
  const floatingNames = new Set<string>();
  for (const node of data.nodes) {
    if (node.cannoliData?.type !== FloatingNodeType.Variable) continue;
    const { name } = parseNamedNode(node.cannoliData.text ?? "");
    if (name !== null) floatingNames.add(name);
  }

  // A form node sends its whole fields object on each non-field arrow, and each
  // field becomes a variable there, keyed by its safe name.
  const formFields = new Map<string, string[]>();
  for (const node of data.nodes) {
    if (node.cannoliData?.type === CallNodeType.Form) {
      formFields.set(node.id, []);
    }
  }
  for (const edge of data.edges) {
    const fields = formFields.get(edge.fromNode);
    const name = edge.cannoliData?.text;
    if (fields && edge.cannoliData?.type === EdgeType.Field && name) {
      fields.push(name, safeKeyName(name));
    }
  }

  const lints: Lint[] = [];
  for (const node of data.nodes) {
    const cannoliData = node.cannoliData as CannoliNodeData | undefined;
    if (!cannoliData || !CALL_NODE_TYPES.includes(cannoliData.type)) continue;

    // So does a variable arrow into the node (or into a group around it).
    const targets = new Set([node.id, ...(cannoliData.groups ?? [])]);
    const incoming = data.edges.filter((edge) => targets.has(edge.toNode));
    const arrowNames = new Set(incoming.map((edge) => edge.cannoliData?.text));
    for (const edge of incoming) {
      if (edge.cannoliData?.type === EdgeType.Field) continue;
      for (const field of formFields.get(edge.fromNode) ?? []) {
        arrowNames.add(field);
      }
    }

    const seen = new Set<string>();
    for (const reference of cannoliData.references ?? []) {
      if (
        reference.type !== ReferenceType.Variable ||
        reference.shouldExtract ||
        !secrets.has(reference.name) ||
        arrowNames.has(reference.name) ||
        floatingNames.has(reference.name) ||
        seen.has(reference.name)
      ) {
        continue;
      }
      seen.add(reference.name);
      lints.push({
        code: "L-secret-in-prompt",
        severity: "error",
        nodeId: node.id,
        message: `L-secret-in-prompt: call node "${node.id}" references the secret {{${reference.name}}}. Secret values are never sent to an LLM; use the secret in an HTTP or action node instead.`,
      });
    }
  }
  return lints;
}
