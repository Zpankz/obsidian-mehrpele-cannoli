// Golden normaliser for lane companion-c3 (BRIEF "Golden comparison contract").
// Dependency-free: copy verbatim into packages/mehrpele-cannoli/test/golden/.
//
// Shape (keys sorted at every depth; arrays keep their order):
//   { message: string|null,
//     objects: { [id]: { status: string, text: string|null } },  // every run.graph object
//     reason: string|null,
//     results: unknown|null,
//     vaultLog: string[] }                                         // fake-vault calls, in call order
//
// A run that never reported a stoppage normalises to reason/message/results = null.

export interface NormalisedRun {
  message: string | null;
  objects: Record<string, { status: string; text: string | null }>;
  reason: string | null;
  results: unknown;
  vaultLog: string[];
}

type StoppageLike = { reason?: unknown; message?: unknown; results?: unknown } | null | undefined;
type RunLike = { graph: Record<string, { status?: unknown; text?: unknown }> };

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined || typeof v === "function") continue;
      out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function normalize(stoppage: StoppageLike, run: RunLike, vaultLog: readonly string[]): NormalisedRun {
  const objects: NormalisedRun["objects"] = {};
  for (const id of Object.keys(run.graph).sort()) {
    const o = run.graph[id];
    objects[id] = { status: String(o.status), text: typeof o.text === "string" ? o.text : null };
  }
  // JSON round trip drops undefined/functions and makes results plain data before sorting.
  const results = stoppage?.results === undefined ? null : JSON.parse(JSON.stringify(stoppage.results));
  return sortKeys({
    message: typeof stoppage?.message === "string" ? stoppage.message : null,
    objects,
    reason: typeof stoppage?.reason === "string" ? stoppage.reason : null,
    results: results ?? null,
    vaultLog: [...vaultLog],
  }) as NormalisedRun;
}

/** Stable serialisation used for the expected/*.json files (2-space indent, trailing newline). */
export function serialise(n: NormalisedRun): string {
  return JSON.stringify(n, null, 2) + "\n";
}
