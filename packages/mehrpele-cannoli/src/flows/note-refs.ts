                                                                                                  
// refresh the frame's output nodes after the runner writes that note.
import type { CannoliCanvas } from "./translate";

const LINK = /\[\[([^\]]+)\]\]/g;

/** `Folder/Name.md#Heading|alias` -> `folder/name` (lower case, no heading, alias or .md). */
const notePath = (ref: string): string =>
  ref.split("|")[0].split("#")[0].trim().replace(/\.md$/i, "").toLowerCase();

const lastSegment = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** Same note: same path, or one side is a bare name matching the other's file name. */
function sameNote(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return (!a.includes("/") || !b.includes("/")) && lastSegment(a) === lastSegment(b);
}

/** Canvas ids of the nodes that reference note `name` (a reference name, `Name#Heading` allowed). */
export function nodesReferencing(canvas: CannoliCanvas, name: string): string[] {
  const want = notePath(name);
  const ids: string[] = [];
  for (const n of canvas.nodes) {
    if (n.type === "file" && typeof n.file === "string") {
      if (sameNote(notePath(n.file), want)) ids.push(n.id);
    } else if (typeof n.text === "string") {
      for (const m of n.text.matchAll(LINK)) {
        if (sameNote(notePath(m[1]), want)) {
          ids.push(n.id);
          break;
        }
      }
    }
  }
  return ids;
}
