                                                                                               
// written through the vault adapter after redact(). Only the newest `runs.keep` are kept.
import type { LintIssue } from "../flows/lint";
import type { ConfirmSection } from "./confirm";
import type { EgressEvent } from "./egress";
import type { ModelUsage } from "./events";
import type { NodeRow } from "./persistor";
import type { RunStatus } from "./registry";

export const RUNS_DIR = ".mehrpele-cannoli/runs";

export interface RunRecord {
  version: 1;
  runId: string;
  flowPath: string;
                                                                                          
  frameKey?: string;
  sourceHash?: string;
  status: RunStatus;
  reason?: string;
  message?: string;
  isMock: boolean;
  provider: string | null;
  providerHost: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  confirmation: { prompted: boolean; skipped: boolean; sections: ConfirmSection[] } | null;
  nodes: NodeRow[];
  egress: EgressEvent[];
  /** Flow lint at run start (C4). */
  lint?: LintIssue[];
  results?: Record<string, string>;
  usage?: unknown;
  /** Modern runtime totals, distinct from the legacy model-keyed usage record. */
  modelUsage?: ModelUsage;
  coreRunId?: string;
}

export interface AdapterLike {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  write(path: string, data: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  remove(path: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** yyyy-mm-dd in UTC. */
export const dayOf = (d: Date): string => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** 20261104T165400Z-k3f9: sorts by start time, then a random suffix. */
export function makeRunId(d: Date, random: () => number = Math.random): string {
  const stamp = `${dayOf(d).replace(/-/g, "")}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  let suffix = "";
  for (let i = 0; i < 4; i++) suffix += Math.floor(random() * 36).toString(36);
  return `${stamp}-${suffix}`;
}

export const recordPath = (runId: string, d: Date): string => `${RUNS_DIR}/${dayOf(d)}/${runId}.json`;

async function ensureDir(adapter: AdapterLike, path: string): Promise<void> {
  let acc = "";
  for (const part of path.split("/")) {
    acc = acc ? `${acc}/${part}` : part;
    if (!(await adapter.exists(acc))) await adapter.mkdir(acc);
  }
}

/** Deletes the oldest records beyond `keep`, and day folders left empty. Returns how many went. */
export async function pruneRecords(adapter: AdapterLike, keep: number): Promise<number> {
  if (!(await adapter.exists(RUNS_DIR))) return 0;
  const { folders } = await adapter.list(RUNS_DIR);
  const all: string[] = [];
  const byDay = new Map<string, string[]>();
  for (const day of folders) {
    const files = (await adapter.list(day)).files.filter((f) => f.endsWith(".json"));
    byDay.set(day, files);
    all.push(...files);
  }
  // Paths sort by day folder, then by run id (start time).
  all.sort();
  const doomed = all.slice(0, Math.max(0, all.length - keep));
  for (const f of doomed) await adapter.remove(f);
  const gone = new Set(doomed);
  for (const [day, files] of byDay) {
    if (files.every((f) => gone.has(f))) {
      const rest = await adapter.list(day);
      if (rest.files.length === 0 && rest.folders.length === 0) await adapter.rmdir(day, false);
    }
  }
  return doomed.length;
}

/** Writes an (already redacted) record and applies retention. Returns the record's path. */
export async function writeRecord(adapter: AdapterLike, record: RunRecord, started: Date, keep: number): Promise<string> {
  const path = recordPath(record.runId, started);
  await ensureDir(adapter, path.slice(0, path.lastIndexOf("/")));
  await adapter.write(path, JSON.stringify(record, null, 2) + "\n");
  await pruneRecords(adapter, keep);
  return path;
}
