                                                                                                
// client is stubbed, so its smith.langchain.com hosts and the is-network-error entry are gone. Each entry is an exact
// (module, literal snippet) pair: a hit passes only if the sourcemap attributes it to `module`
// (a metafile input path, matched as a path suffix) AND it lies inside an occurrence of `snippet`
// in the shipped main.js. Every entry must still match, so a stale entry fails the scan.
//
// Never add: cannoli.website, esm.town, val.town, posthog/segment/mixpanel hosts, or any OTLP
// /v1/traces URL. bundle.test.ts keeps those at zero and rejects entries that match them.
export interface ScanAllowEntry {
  module: string;
  snippet: string;
  reason: string;
}

// SDK protocol values contain the substring "arize"; these are not telemetry hosts.
export const SCAN_ALLOWLIST: ScanAllowEntry[] = [
  { module: "/@ai-sdk/anthropic/src/anthropic-language-model.ts", snippet: '"summarized"', reason: "Anthropic thinking display protocol value, not an Arize endpoint." },
  { module: "/@ai-sdk/anthropic/src/anthropic-language-model-options.ts", snippet: '"summarized"', reason: "Anthropic thinking display schema value, not an Arize endpoint." },
  { module: "/@ai-sdk/anthropic/src/anthropic-language-model-options.ts", snippet: '"summarize"', reason: "Anthropic compaction schema value, not an Arize endpoint." },
];
