import type { Persistor } from "../persistor";
import type {
  GenericCompletionParams,
  GenericCompletionResponse,
} from "../providers";
import type { SecretResolver } from "../secrets";

/** Values shorter than this are config-like (ports, colours), not credentials. */
const MIN_SECRET_LENGTH = 6;

/** `[NAME, value]` for every redactable secret, longest value first. */
type SecretPairs = [string, string][];

/**
 * Replace every secret value in `text` with `«secret:NAME»`. Values are matched
 * literally, longest first, in a single left-to-right pass (so a placeholder is
 * never re-matched). Null, empty and whitespace-only values are skipped, and so
 * are values shorter than 6 characters: those are config-like rather than
 * credentials, and redacting them would mangle ordinary output.
 */
export function redactSecrets(text: string, secrets: SecretResolver): string {
  return redactText(text, secretPairs(secrets));
}

/** Hold a possible credential prefix so chunk boundaries cannot bypass redaction. */
export function streamRedactor(
  secrets: SecretResolver,
): (text: string, final?: boolean) => string {
  const pairs = secretPairs(secrets);
  let pending = "";
  return (text, final = false) => {
    pending += text;
    let out = "";
    let i = 0;
    while (i < pending.length) {
      const remainder = pending.slice(i);
      if (
        !final &&
        pairs.some(
          ([, value]) =>
            value.length > remainder.length && value.startsWith(remainder),
        )
      )
        break;
      const match = pairs.find(([, value]) => pending.startsWith(value, i));
      if (match) {
        out += `«secret:${match[0]}»`;
        i += match[1].length;
      } else out += pending[i++];
    }
    pending = pending.slice(i);
    return out;
  };
}

function redactText(text: string, pairs: SecretPairs): string {
  if (pairs.length === 0 || text === "") return text;

  let out = "";
  let i = 0;
  outer: while (i < text.length) {
    for (const [name, value] of pairs) {
      if (text.startsWith(value, i)) {
        out += `«secret:${name}»`;
        i += value.length;
        continue outer;
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

function secretPairs(secrets: SecretResolver): SecretPairs {
  const pairs: SecretPairs = [];
  for (const name of secrets.names()) {
    const value = secrets.get(name);
    if (value === null || value === undefined || value.trim() === "") continue;
    if (value.length < MIN_SECRET_LENGTH) continue;
    pairs.push([name, value]);
  }
  return pairs.sort((a, b) => b[1].length - a[1].length);
}

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Copy `obj`, redacting each listed key that holds a string. */
function redactKeys(obj: Obj, keys: string[], pairs: SecretPairs): Obj {
  const out = { ...obj };
  for (const key of keys) {
    if (typeof out[key] === "string") {
      out[key] = redactText(out[key] as string, pairs);
    }
  }
  return out;
}

/** Deep-copy `value`, redacting every string in it (free-form data only). */
function redactDeep(value: unknown, pairs: SecretPairs): unknown {
  if (typeof value === "string") return redactText(value, pairs);
  if (value instanceof URL) return redactText(value.href, pairs);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, pairs));
  if (isObj(value)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, pairs);
    return out;
  }
  return value;
}

/** Event-only copy: URLs and metadata must not inherit transport redaction exemptions. */
export function redactEventData<T>(value: T, secrets: SecretResolver): T {
  return redactDeep(value, secretPairs(secrets)) as T;
}

function redactMessage(message: unknown, pairs: SecretPairs): unknown {
  if (!isObj(message)) return message;
  const out = redactKeys(message, ["content"], pairs);
  if (isObj(out.function_call)) {
    out.function_call = {
      ...out.function_call,
      args: redactDeep(out.function_call.args, pairs),
    };
  }
  return out;
}

/** cannoliData: only its text, edge content, messages and version headers. */
function redactCannoliData(data: unknown, pairs: SecretPairs): unknown {
  if (!isObj(data)) return data;
  const out = redactKeys(data, ["text"], pairs);
  if (typeof out.content === "string") {
    out.content = redactText(out.content, pairs);
  } else if (isObj(out.content)) {
    // `{ variableName: value }`: keys are names, values are text.
    out.content = redactKeys(out.content, Object.keys(out.content), pairs);
  }
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((m) => redactMessage(m, pairs));
  }
  if (Array.isArray(out.versions)) {
    out.versions = out.versions.map((v) =>
      isObj(v) ? redactKeys(v, ["header", "subHeader"], pairs) : v,
    );
  }
  return out;
}

/**
 * Redact a canvas node or edge. Only text-bearing fields change (`text`,
 * `label`, and the text inside `cannoliData`); ids, sides, colours, types,
 * file paths and structural arrays are left exactly as they are.
 */
function redactCanvasObject<T>(obj: T, pairs: SecretPairs): T {
  if (pairs.length === 0 || !isObj(obj)) return obj;
  const out = redactKeys(obj, ["text", "label"], pairs);
  if ("cannoliData" in out) {
    out.cannoliData = redactCannoliData(out.cannoliData, pairs);
  }
  return out as T;
}

/**
 * Wrap a Persistor so nothing handed to it carries a secret value. This is the
 * single point where a run passes text to persistence. Secrets are read once
 * per call.
 */
export function redactingPersistor(
  persistor: Persistor,
  secrets: SecretResolver,
): Persistor {
  const text = (value: string) => redactText(value, secretPairs(secrets));
  return {
    ...(persistor.flush ? { flush: () => persistor.flush!() } : {}),
    ...(persistor.applyBatch
      ? {
          applyBatch: (
            edits: Parameters<NonNullable<Persistor["applyBatch"]>>[0],
          ) => {
            const pairs = secretPairs(secrets);
            return persistor.applyBatch!(
              edits.map((edit) => {
                switch (edit.type) {
                  case "node":
                    return {
                      ...edit,
                      node: redactCanvasObject(edit.node, pairs),
                    };
                  case "edge":
                    return {
                      ...edit,
                      edge: redactCanvasObject(edit.edge, pairs),
                    };
                  case "label":
                    return { ...edit, label: text(edit.label) };
                  default:
                    return { ...edit, message: text(edit.message) };
                }
              }),
            );
          },
        }
      : {}),
    start: (canvasData) => {
      const pairs = secretPairs(secrets);
      return persistor.start({
        ...canvasData,
        nodes: canvasData.nodes.map((n) => redactCanvasObject(n, pairs)),
        edges: canvasData.edges.map((e) => redactCanvasObject(e, pairs)),
      });
    },
    editNode: (newNode) =>
      persistor.editNode(redactCanvasObject(newNode, secretPairs(secrets))),
    editEdge: (newEdge) =>
      persistor.editEdge(redactCanvasObject(newEdge, secretPairs(secrets))),
    addError: (nodeId, message) => persistor.addError(nodeId, text(message)),
    addWarning: (nodeId, message) =>
      persistor.addWarning(nodeId, text(message)),
    editOriginalParallelGroupLabel: (originalGroupId, label) =>
      persistor.editOriginalParallelGroupLabel(originalGroupId, text(label)),
    setConfig: (config) => persistor.setConfig(config),
  };
}

/**
 * Copy an LLM request with every secret value in its message text and tool
 * schemas (function descriptions, enums) redacted. Image references and model
 * config are left alone.
 */
export function redactRequest<T extends GenericCompletionParams>(
  request: T,
  secrets: SecretResolver,
): T {
  const pairs = secretPairs(secrets);
  if (pairs.length === 0) return request;
  const out: T = {
    ...request,
    messages: request.messages.map(
      (m) => redactMessage(m, pairs) as GenericCompletionResponse,
    ),
  };
  if (request.functions) {
    out.functions = redactDeep(request.functions, pairs) as T["functions"];
  }
  return out;
}
