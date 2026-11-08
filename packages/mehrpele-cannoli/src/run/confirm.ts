                                                                                                
// is stored in settings.confirmed[path] and the prompt returns when the set or the provider host
// changes. skipConfirm (the API) does not prompt but still records what was skipped.
import type { ReferenceSet } from "./references";
import { hasFolder } from "./vault-file-manager";

export interface ConfirmSection {
  title: string;
  items: string[];
}

/** Stable JSON of the set (fixed key order, sorted lists). */
export function canonicalJson(set: ReferenceSet): string {
  return JSON.stringify([
    ["providerHost", set.providerHost],
    ["notesRead", [...set.notesRead].sort()],
    ["notesWritten", [...set.notesWritten].sort()],
    ["notesCreated", set.notesCreated],
    ["createsOutsideFolder", set.createsOutsideFolder],
    ["dynamicNotes", set.dynamicNotes],
    ["writesSelection", set.writesSelection],
    ["httpHosts", [...set.httpHosts].sort()],
    ["dynamicHttp", set.dynamicHttp],
    ...(set.bindings ? [["bindings", [...set.bindings].sort(([a],[b]) => a.localeCompare(b))]] : []),
  ]);
}

/** sha256 (hex) of the canonical JSON. */
export async function referenceSetHash(set: ReferenceSet): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(set));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whether the stored confirmation for `path` still covers this set. */
export function isConfirmed(confirmed: Record<string, string>, path: string, hash: string): boolean {
  return confirmed[path] === hash;
}

const orNone = (items: string[]): string[] => (items.length ? items : ["None"]);

export const NEW_NOTE_MARK = " (new, created next to the flow note)";
/** A missing name with folders is never created on write, so the run will error there. */
export const NOT_CREATED_MARK = " (new; not created: names with folders must exist)";

   
                                                                                               
                                                                                           
   
export function confirmSections(set: ReferenceSet, opts: { isMissing?(name: string): boolean } = {}): ConfirmSection[] {
  const written = set.notesWritten.map((n) => (opts.isMissing?.(n) ? n + (hasFolder(n) ? NOT_CREATED_MARK : NEW_NOTE_MARK) : n));
  if (set.writesSelection) written.push("The selection in the active editor");
  if (set.notesCreated > 0) {
    const n = set.notesCreated;
    const where = set.createsOutsideFolder ? "in a folder chosen while the flow runs" : "in the flow's folder";
    written.push(`${n} new ${n === 1 ? "note" : "notes"}, ${where}`);
  }
  const read = [...set.notesRead];
  if (set.dynamicNotes) {
    read.push("Notes named while the flow runs");
    written.push("Notes named while the flow runs");
  }
  const http = [...set.httpHosts];
  if (set.dynamicHttp) http.push("Hosts built while the flow runs (each must be on the network allow list)");
  return [
    { title: "Model provider", items: [set.providerHost ?? "None"] },
    { title: "Notes read", items: orNone(read) },
    { title: "Notes written", items: orNone(written) },
    { title: "HTTP hosts", items: orNone(http) },
  ];
}

export const EMBEDS_NOTE = "Embedded notes inside these notes are also sent.";

/**
 * The line under the sections when the flow reads notes: getNote inlines their ![[embeds]], so
 * those notes are sent too. Display only; it is not part of the reference set or its hash.
 */
export function confirmFootnote(sections: ConfirmSection[]): string | null {
  const read = sections.find((s) => s.title === "Notes read");
  return read && !(read.items.length === 1 && read.items[0] === "None") ? EMBEDS_NOTE : null;
}
