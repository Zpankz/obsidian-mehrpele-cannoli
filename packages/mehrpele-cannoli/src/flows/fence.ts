                                                                           
//
//   ```mermaid cannoli
//   %% pele-cannoli: {"v":1,"args":{"topic":"lemons"}} %%
//   flowchart LR
//     ...
//
// The config line is a Mermaid comment, so the host renders the fence unchanged. Unknown keys
// are ignored; bad JSON is a lint warning, never an error.

/** The fence token that marks a flow. */
export const FLOW_TOKEN = "cannoli";

                                                                             
export function isFlowFrame(frame: { fenceRest: string }): boolean {
  return frame.fenceRest.split(/\s+/).some(token => token === "workflow" || token === FLOW_TOKEN);
}

export interface FlowConfig {
  /** Run arguments (RunArgs.args), every value a string. */
  args: Record<string, string>;
}

export interface ConfigResult {
  config: FlowConfig;
  /** Problems with the config line, as lint warnings. */
  warnings: string[];
}

const CONFIG_LINE = /^\s*%%\s*pele-cannoli:\s*(.*?)\s*%%\s*$/;

   
                                                                                                
                                                                                               
   
function configLines(lines: string[]): boolean[] {
  let quoted = false;
  return lines.map((l) => {
    if (!quoted && /^\s*%%/.test(l)) return CONFIG_LINE.test(l);
    if ((l.match(/"/g)?.length ?? 0) % 2) quoted = !quoted;
    return false;
  });
}

/** The source without its `%% pele-cannoli: … %%` lines. */
export function stripConfigLines(source: string): string {
  const lines = source.split("\n");
  const config = configLines(lines);
  return lines.filter((_, i) => !config[i]).join("\n");
}

/** Reads the first `%% pele-cannoli: {…} %%` line. No line means no args and no warnings. */
export function parseFlowConfig(source: string): ConfigResult {
  const config: FlowConfig = { args: {} };
  const warnings: string[] = [];
  const lines = source.split("\n");
  const isConfig = configLines(lines);
  const line = lines.find((_, i) => isConfig[i]);
  if (!line) return { config, warnings };
  const body = CONFIG_LINE.exec(line)?.[1] ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    warnings.push(`The pele-cannoli config line is not valid JSON (${e instanceof Error ? e.message : String(e)}); it was ignored.`);
    return { config, warnings };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.push("The pele-cannoli config line must be a JSON object; it was ignored.");
    return { config, warnings };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== undefined && obj.v !== 1) warnings.push(`pele-cannoli config version ${JSON.stringify(obj.v)} is not 1; reading it as version 1.`);
  const args = obj.args;
  if (args !== undefined) {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      warnings.push("pele-cannoli config: args must be an object of name: value pairs; it was ignored.");
    } else {
      for (const [name, value] of Object.entries(args as Record<string, unknown>)) {
        if (typeof value === "string") config.args[name] = value;
        else if (typeof value === "number" || typeof value === "boolean") config.args[name] = String(value);
        else warnings.push(`pele-cannoli config: arg "${name}" is not a string; it was ignored.`);
      }
    }
  }
  return { config, warnings };
}

/**
 * The 0-based line of the opening fence of the code block that contains `cursorLine`, or null.
 * Frame keys are `sourcePath#<that line>` (the host's LP widget lineStart).
 */
export function fenceLineAt(lines: string[], cursorLine: number): number | null {
  let open: { line: number; marker: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (open) {
      if (m && m[1][0] === open.marker[0] && m[1].length >= open.marker.length && lines[i].trim() === m[1]) {
        if (cursorLine >= open.line && cursorLine <= i) return open.line;
        open = null;
      }
    } else if (m) {
      open = { line: i, marker: m[1] };
    }
    if (!open && i >= cursorLine) return null;
  }
  return open && cursorLine >= open.line ? open.line : null;
}

/** The fence line of a frame key `sourcePath#fenceLine`, or null when the key has none. */
export function fenceLineOfKey(key: string): number | null {
  const m = /#(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}

/** Parses the "Run with args…" text: one `name=value` per line; blank lines and `#` comments skipped. */
export function parseArgsText(text: string): { args: Record<string, string>; errors: string[] } {
  const args: Record<string, string> = {};
  const errors: string[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    const name = eq > 0 ? line.slice(0, eq).trim() : "";
    if (!name) {
      errors.push(`Line ${i + 1}: expected name=value`);
      return;
    }
    args[name] = line.slice(eq + 1).trim();
  });
  return { args, errors };
}

/** The "Run with args…" prefill: one `name=value` per line. */
export function formatArgsText(args: Record<string, string>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

   
                                                                                                
                                                                          
   
export function sourceHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}
