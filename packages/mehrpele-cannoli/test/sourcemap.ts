// Minimal source-map reader for the bundle scan: maps an offset in the generated (shipped)
// main.js back to the input module that produced it. Only the source index is needed.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DIGIT = new Map([...B64].map((c, i) => [c, i]));

interface RawMap {
  sources: string[];
  mappings: string;
}

/** Per generated line: sorted [column, sourceIndex] pairs. */
type LineSegments = Array<[number, number]>;

/** The signed fields of one base64-VLQ segment. */
function decodeSegment(seg: string): number[] {
  const fields: number[] = [];
  let value = 0;
  let shift = 0;
  for (const ch of seg) {
    const d = DIGIT.get(ch);
    if (d === undefined) throw new Error(`bad VLQ char ${ch}`);
    value += (d & 31) << shift;
    if (d & 32) {
      shift += 5;
      continue;
    }
    fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = 0;
    shift = 0;
  }
  return fields;
}

function decode(mappings: string): LineSegments[] {
  let source = 0;
  return mappings.split(";").map((line) => {
    const segs: LineSegments = [];
    let col = 0;
    for (const seg of line ? line.split(",") : []) {
      const fields = decodeSegment(seg);
      col += fields[0] ?? 0;
      if (fields.length < 4) continue;
      source += fields[1] ?? 0;
      segs.push([col, source]);
    }
    return segs;
  });
}

/** Offsets where each line of `code` starts. */
function lineStartsOf(code: string): number[] {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** Index of the last line starting at or before `offset` (binary search). */
function lineAt(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Source index of the last segment starting at or before `col`, or null. */
function sourceAt(segs: LineSegments, col: number): number | null {
  let found: number | null = null;
  for (const [c, s] of segs) {
    if (c > col) break;
    found = s;
  }
  return found;
}

/** Returns `moduleAt(offset)`: the source path for a generated offset, or null if unmapped. */
export function moduleLocator(code: string, mapJson: string): (offset: number) => string | null {
  const map = JSON.parse(mapJson) as RawMap;
  const lines = decode(map.mappings);
  const lineStarts = lineStartsOf(code);
  return (offset) => {
    const line = lineAt(lineStarts, offset);
    const found = sourceAt(lines[line] ?? [], offset - (lineStarts[line] ?? 0));
    return found === null ? null : (map.sources[found] ?? null);
  };
}
