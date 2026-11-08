// Test helper: compile a JSON Canvas the same way Run does (schema parse, then
// CannoliFactory.getCannoliData) and return a normalised, snapshot-friendly view.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CannoliFactory } from "../../src/factory";
import { CannoliGraph, type VerifiedCannoliCanvasData } from "../../src/graph";
import { canvasDataSchema } from "../../src/persistor";

export interface CompileOptions {
  contentIsColorless?: boolean;
  resume?: boolean;
  currentNote?: string;
}

export interface CompiledObject {
  id: string;
  [key: string]: unknown;
  cannoliData?: Record<string, unknown>;
}

export interface CompiledCanvas {
  nodes: CompiledObject[];
  edges: CompiledObject[];
}

// Canvas fields that only describe layout or are copied into cannoliData.
// Everything else (ids, types, colours, labels, files, urls, cannoliData) is kept,
// including fromEnd/toEnd: the factory reads them to decide whether an edge counts.
const LAYOUT_KEYS = new Set([
  "x",
  "y",
  "width",
  "height",
  "fromSide",
  "toSide",
  "text",
]);

// Nothing the factory produces today is random or time-based (duplicate ids are
// derived from the original id and loop index). Keep this list for future fields.
const VOLATILE_KEYS = new Set<string>([]);

export function verifiedData(
  canvas: unknown,
  opts: CompileOptions = {},
): VerifiedCannoliCanvasData {
  // The factory mutates its input, so always work on a deep copy.
  const parsed = canvasDataSchema.parse(structuredClone(canvas));
  const factory = new CannoliFactory(
    parsed,
    undefined,
    opts.resume ?? false,
    opts.contentIsColorless ?? false,
    opts.currentNote ?? "No current note",
  );
  return factory.getCannoliData();
}

function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_KEYS.has(key)) continue;
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = normalise(v);
    }
    return out;
  }
  return value;
}

export function normaliseObject(obj: Record<string, unknown>): CompiledObject {
  const kept: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) {
    if (!LAYOUT_KEYS.has(key)) kept[key] = v;
  }
  return normalise(kept) as CompiledObject;
}

export const byId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Compile a canvas and return a normalised, deterministic view of the result. */
export function compileCanvas(
  canvas: unknown,
  opts: CompileOptions = {},
): CompiledCanvas {
  const data = verifiedData(canvas, opts);
  return {
    nodes: data.nodes
      .map((n) => normaliseObject(n as unknown as Record<string, unknown>))
      .sort(byId),
    edges: data.edges
      .map((e) => normaliseObject(e as unknown as Record<string, unknown>))
      .sort(byId),
  };
}

/** Compile and hydrate a CannoliGraph, as Run does before starting. */
export function hydrateGraph(
  canvas: unknown,
  opts: CompileOptions = {},
): CannoliGraph {
  return new CannoliGraph(verifiedData(canvas, opts));
}

export interface CanvasFixture {
  /** Path under the fixture set, without the .canvas extension. */
  name: string;
  /** File-system-safe id used for snapshot file names. */
  slug: string;
  canvas: unknown;
}

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));

/** Load every .canvas file under test/fixtures/<set>, sorted by path. */
export function listFixtures(set: string): CanvasFixture[] {
  const dir = join(FIXTURES, set);
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".canvas"))
    .sort();
  return files.map((file) => {
    const name = relative(dir, join(dir, file))
      .split(sep)
      .join("/")
      .replace(/\.canvas$/, "");
    const slug = `${set}/${name
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")}`;
    return {
      name,
      slug,
      canvas: JSON.parse(readFileSync(join(dir, file), "utf8")),
    };
  });
}
