                                                                                              
// from the parsed canvas (a probe Run's canvasData), shown in the first-run confirmation and
// hashed into settings.confirmed[path].
import { linkpathOf } from "./vault-file-manager";

export interface ReferenceSet {
  providerHost: string | null;
  /** Frozen resource bindings used to scope this confirmation. */
  bindings?: [string, string][];
  notesRead: string[];
  notesWritten: string[];
  /** Create-note nodes (names are chosen at run time). */
  notesCreated: number;
  /** A create-note node takes its folder from an arrow, so it may create outside the flow folder. */
  createsOutsideFolder: boolean;
  /** A note is named by a variable ({{@name}}), so which note is read or written is chosen at run time. */
  dynamicNotes: boolean;
  /** Writes into the active editor's selection. */
  writesSelection: boolean;
  httpHosts: string[];
  /** An HTTP node builds its URL host from a variable. */
  dynamicHttp: boolean;
}

interface RefLike {
  name: string;
  type: string;
  shouldExtract?: boolean;
}
interface NodeLike {
  id: string;
  cannoliData?: { type?: string; text?: string; references?: RefLike[] };
}
interface EdgeLike {
  fromNode: string;
  toNode: string;
  cannoliData?: { type?: string; edgeModifier?: string };
}
export interface CanvasDataLike {
  nodes: NodeLike[];
  edges: EdgeLike[];
}

const NO_CURRENT_NOTE = "No current note";
const URL_RE = /\bhttps?:\/\/([^\s/"'`<>\\]+)/gi;
const sorted = (s: Set<string>): string[] => [...s].sort((a, b) => a.localeCompare(b));

/** Hosts named in an HTTP node's text; `dynamic` when a host is built from {{…}}. */
export function hostsInText(text: string): { hosts: string[]; dynamic: boolean } {
  const hosts = new Set<string>();
  let dynamic = false;
  for (const m of text.matchAll(URL_RE)) {
    const authority = m[1];
    if (authority.includes("{{") || authority.includes("}}")) {
      dynamic = true;
      continue;
    }
    const host = authority.replace(/^[^@]*@/, "").replace(/[),.;]+$/, "").toLowerCase();
    if (host) hosts.add(host);
  }
  if (/\bhttps?:\/\/\{\{/i.test(text)) dynamic = true;
  return { hosts: sorted(hosts), dynamic };
}

export function collectReferences(data: CanvasDataLike | null, providerHost: string | null): ReferenceSet {
  const read = new Set<string>();
  const written = new Set<string>();
  const http = new Set<string>();
  const set: ReferenceSet = {
    providerHost,
    notesRead: [],
    notesWritten: [],
    notesCreated: 0,
    createsOutsideFolder: false,
    dynamicNotes: false,
    writesSelection: false,
    httpHosts: [],
    dynamicHttp: false,
  };
  if (!data) return set;

  const incoming = new Map<string, EdgeLike[]>();
  for (const e of data.edges) {
    const list = incoming.get(e.toNode) ?? [];
    list.push(e);
    incoming.set(e.toNode, list);
  }

  for (const node of data.nodes) {
    const cd = node.cannoliData;
    if (!cd) continue;
    const isReferenceNode = cd.type === "reference";
    const inEdges = incoming.get(node.id) ?? [];
    for (const ref of cd.references ?? []) {
      switch (ref.type) {
        case "note": {
          // {{NOTE}} without an obsidianCurrentNote arg: the core's placeholder, not a note.
          if (ref.name === NO_CURRENT_NOTE) break;
          const name = linkpathOf(ref.name);
          read.add(name);
          if (isReferenceNode && inEdges.length > 0) written.add(name);
          break;
        }
        case "variable":
          // {{@name}} (a note named by a variable); plain {{name}} variables don't extract.
          if (ref.shouldExtract) set.dynamicNotes = true;
          break;
        case "create-note":
          set.notesCreated++;
          if (inEdges.some((e) => e.cannoliData?.edgeModifier === "folder")) set.createsOutsideFolder = true;
          break;
        case "selection":
          if (isReferenceNode && inEdges.length > 0) set.writesSelection = true;
          break;
      }
    }
    if (cd.type === "http" && cd.text) {
      const { hosts, dynamic } = hostsInText(cd.text);
      for (const h of hosts) http.add(h);
      if (dynamic) set.dynamicHttp = true;
    }
  }
  set.notesRead = sorted(read);
  set.notesWritten = sorted(written);
  set.httpHosts = sorted(http);
  return set;
}
