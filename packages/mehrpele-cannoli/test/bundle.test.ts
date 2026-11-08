// Bundle checks (README: Bundle checks). Builds in memory; no test depends on a pre-built main.js.
import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import { BUNDLE_BUDGET, buildPlugin, EXTERNALS, licenseBanner, sizeReport } from "../esbuild.config.mjs";
import { ENGINE_MARKER } from "../src/flows/engine";
import { SCAN_ALLOWLIST } from "./scan-allowlist";
import { moduleLocator } from "./sourcemap";

const pkgRoot = resolve(import.meta.dir, "..");
const coreRoot = resolve(pkgRoot, "..", "cannoli-core");
const coreLicense = readFileSync(resolve(coreRoot, "LICENSE"), "utf8").trimEnd();
const BUDGET = BUNDLE_BUDGET;

/**
 * Banned hosts and telemetry (segment matched only as a host), plus the LangSmith hosts
 * (README: Bundle checks, rule 2). Hits pass only through test/scan-allowlist.ts.
 */
const BANNED =
  /phoenix|arize|otlp|exporter-trace|OTLPTraceExporter|posthog|sentry|segment\.io|segment\.com|api\.segment|mixpanel|cannoli\.website|esm\.town|val\.town|https?:\/\/[a-z0-9.-]*smith\.langchain\.com/gi;
/** Never allowlisted: these must have zero hits (README: Bundle checks, rule 1). */
const NEVER = /cannoli\.website|esm\.town|val\.town|posthog|segment\.io|segment\.com|api\.segment|mixpanel|\/v1\/traces/gi;
/** Telemetry/exporter packages that must never be a bundle input. */
const BANNED_INPUT =
  /node_modules\/(@opentelemetry\/(exporter|sdk)[^/]*|@arizeai\/[^/]+|@sentry\/[^/]+|posthog[^/]*|mixpanel[^/]*)\//;

let minified = "";
let readable = "";
let inputs: string[] = [];
let totalBytes = 0;
let moduleAt: (offset: number) => string | null = () => null;

beforeAll(async () => {
  const prod = await buildPlugin({ production: true, write: false });
  minified = prod.outputFiles?.[0]?.text ?? "";
  inputs = Object.keys(prod.metafile.inputs);
  totalBytes = sizeReport(prod.metafile).totalBytes;
  // Attribution: the same production build with an external sourcemap. Its main.js must be
  // byte-identical to the shipped one, so each hit maps to the module that emitted those bytes.
  const mapped = await buildPlugin({ production: true, write: false, overrides: { sourcemap: "external" } });
  const mappedJs = mapped.outputFiles?.find((f) => f.path.endsWith("main.js"))?.text ?? "";
  const mapJson = mapped.outputFiles?.find((f) => f.path.endsWith(".map"))?.text ?? "{}";
  if (mappedJs !== minified) throw new Error("sourcemap build differs from the shipped build");
  moduleAt = moduleLocator(mappedJs, mapJson);
  const dev = await buildPlugin({ production: true, write: false, overrides: { minify: false, sourcemap: false } });
  readable = dev.outputFiles?.[0]?.text ?? "";
}, 120_000);

/** Each match with 60 chars of context, for a readable failure. */
function hits(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60));
}

describe("licence banner", () => {
  test("both notices sit in the first 600 bytes", () => {
    const head = Buffer.from(minified).subarray(0, 600).toString("utf8");
    expect(head.startsWith("/*!")).toBe(true);
    expect(head).toContain("Copyright (c)");
    expect(head).toContain("Mehrpele Flows © 2026 Zpankz, MIT");
  });

  test("the banner carries cannoli-core's full MIT text", () => {
    expect(licenseBanner()).toContain(coreLicense);
    expect(minified.slice(0, licenseBanner().length + 10)).toContain(coreLicense);
  });

  test("NOTICE names the vendored commit from UPSTREAM.json", () => {
    const { sha } = JSON.parse(readFileSync(resolve(coreRoot, "UPSTREAM.json"), "utf8"));
    expect(readFileSync(resolve(pkgRoot, "NOTICE"), "utf8")).toContain(sha);
  });
});

describe("bundle contents", () => {
  test("no Node built-in is bundled", () => {
    const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
    const bad = inputs.filter((p) => p.startsWith("node:") || builtins.has(p));
    expect(bad).toEqual([]);
  });

  test("every require() is an Obsidian-provided external (no electron, no built-ins)", () => {
    const required = [...new Set([...readable.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]))];
    expect(required.filter((r) => !EXTERNALS.includes(r))).toEqual([]);
    expect(required).toContain("obsidian");
  });

  test("every banned-term hit is an allowlisted (module, snippet) pair, and no entry is stale", () => {
    const used = new Set<number>();
    const unexplained: string[] = [];
    for (const m of minified.matchAll(BANNED)) {
      const mod = moduleAt(m.index) ?? "<unmapped>";
      const end = m.index + m[0].length;
      const entry = SCAN_ALLOWLIST.findIndex((e) => {
        if (!mod.endsWith(e.module)) return false;
        for (let at = minified.indexOf(e.snippet); at !== -1; at = minified.indexOf(e.snippet, at + 1)) {
          if (at <= m.index && end <= at + e.snippet.length) return true;
          if (at > m.index) break;
        }
        return false;
      });
      if (entry === -1) unexplained.push(`${mod} :: ${minified.slice(Math.max(0, m.index - 60), end + 60)}`);
      else used.add(entry);
    }
    expect(unexplained).toEqual([]);
    const stale = SCAN_ALLOWLIST.filter((_, i) => !used.has(i)).map((e) => `${e.module} :: ${e.snippet}`);
    expect(stale).toEqual([]);
  });

  test("the allowlist never covers a forbidden host, and those stay at zero", () => {
    for (const e of SCAN_ALLOWLIST) {
      expect(e.snippet).not.toMatch(new RegExp(NEVER.source, "i"));
      expect(e.reason.length).toBeGreaterThan(10);
    }
    expect(hits(minified, NEVER)).toEqual([]);
    expect(hits(readable, NEVER)).toEqual([]);
  });

  test("no telemetry exporter or analytics package is a bundle input", () => {
    expect(inputs.filter((p) => BANNED_INPUT.test(p))).toEqual([]);
    expect(inputs.filter((p) => p.includes("node_modules/langsmith/dist/singletons/otel"))).toEqual([]);
    // C3: langsmith's API client and @langchain/core's env tracing switch are stubbed.
    expect(inputs.filter((p) => /node_modules\/langsmith\/dist\/client\.js$/.test(p))).toEqual([]);
    expect(inputs.filter((p) => /@langchain\/core\/dist\/utils\/callbacks\.js$/.test(p))).toEqual([]);
    expect(inputs.filter(p => /node_modules\/(?:@langchain|langchain|langsmith)(?:\/|$)/.test(p))).toEqual([]);
  });

  // Any reference to eval (direct, indirect `(0,eval)(`) or a Function constructor call, with or without `new`.
  const DYNAMIC_CODE = /\beval\b|\bFunction\s*\(/g;

  test("the dynamic-code pattern catches every form", () => {
    for (const s of ['eval("1")', '(0,eval)("1")', 'Function("return 1")', 'new Function("a","b")', "x=eval"])
      expect(hits(s, DYNAMIC_CODE).length).toBeGreaterThan(0);
    expect(hits("isFunction(x);evaluate(y)", DYNAMIC_CODE)).toEqual([]);
  });

  test("no eval or Function constructor", () => {
    expect(hits(minified, DYNAMIC_CODE)).toEqual([]);
  });

  test(`main.js is at most ${BUDGET} bytes`, () => {
    expect(totalBytes).toBeGreaterThan(0);
    expect(totalBytes).toBeLessThanOrEqual(BUDGET);
  });
});

describe("engine loads lazily", () => {
  test("the engine marker lives inside the init_engine wrapper", () => {
    const start = readable.indexOf("var init_engine = __esm({");
    expect(start).toBeGreaterThan(-1);
    const marker = readable.indexOf(JSON.stringify(ENGINE_MARKER));
    expect(marker).toBeGreaterThan(start);
    // The wrapper body ends at the next top-level `});`.
    const end = readable.indexOf("\n});", start);
    expect(marker).toBeLessThan(end);
  });

  test("init_engine() is called only from the lazy import", () => {
    const calls = [...readable.matchAll(/init_engine\(\)/g)].map((m) => readable.slice(m.index - 20, m.index + 40));
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toMatch(/\.then\(\(\) => \(init_engine\(\), engine_exports\)\)/);
  });
});

describe("source hygiene", () => {
  test("src/ never sets innerHTML, outerHTML or insertAdjacentHTML", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(resolve(pkgRoot, "src"));
    const bad = files.filter((f) => /innerHTML|outerHTML|insertAdjacentHTML/.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });
});
