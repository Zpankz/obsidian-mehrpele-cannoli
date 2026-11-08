// Builds Mehrpele Flows into main.js.
//
//   bun esbuild.config.mjs production   one minified build, writes main.js + build-report.json
//   bun esbuild.config.mjs              watch mode (dev)
//
// The tests import `buildPlugin` and build in memory (write: false), so no test depends on a
// pre-built main.js.
import esbuild from "esbuild";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const coreRoot = resolve(here, "..", "cannoli-core");
// Use the pinned SDK sources to replace its two Node-only modules at module
// boundaries. No dependency file or vendored core source is rewritten.
const sdkRequire = createRequire(resolve(coreRoot, "package.json"));
const sdkPackage = sdkRequire.resolve("ai/package.json");
const sdkDependencies = createRequire(sdkPackage);
const sdkSources = new Map([["ai", resolve(dirname(sdkPackage), "src/index.ts")], ["@ai-sdk/provider-utils", resolve(dirname(sdkDependencies.resolve("@ai-sdk/provider-utils/package.json")), "src/index.ts")]]);
const openaiRoot = dirname(sdkRequire.resolve("@ai-sdk/openai/package.json"));
sdkSources.set("pele-openai-chat", resolve(openaiRoot, "src/chat/openai-chat-language-model.ts"));
sdkSources.set("pele-openai-version", resolve(openaiRoot, "src/version.ts"));
const stubsDir = resolve(here, "src", "stubs");
const stub = (file) => resolve(stubsDir, file);
export const BUNDLE_BUDGET = 1_500_000;

/** Modules Obsidian provides at runtime. Node built-ins and electron are NOT external. */
export const EXTERNALS = [
  "obsidian",
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
];

/** The licence banner: both notices first, then cannoli-core's MIT text read from its LICENSE. */
export function licenseBanner() {
  const license = readFileSync(resolve(coreRoot, "LICENSE"), "utf8").trimEnd();
  const upstream = JSON.parse(readFileSync(resolve(coreRoot, "UPSTREAM.json"), "utf8"));
  const copyright = license.split("\n").find((l) => l.startsWith("Copyright"));
  if (!copyright) throw new Error("cannoli-core LICENSE has no Copyright line");
  if (license.includes("*/")) throw new Error("cannoli-core LICENSE would close the banner comment");
  return [
    `/*! cannoli-core: ${copyright}. MIT License, full text below.`,
    "Mehrpele Flows © 2026 Zpankz, MIT",
    "",
    `cannoli-core (https://github.com/DeabLabs/cannoli, modernised in https://github.com/Zpankz/cannoli, vendored at ${upstream.sha}):`,
    "",
    license,
    "",
    "Third-party licence comments are collected at the end of this file.",
    "*/",
  ].join("\n");
}

// ----- stubs -----
// Specifiers that resolve to a stub instead of the real package: cannoli-server's root, /rpc
// and /schemas exactly (the only entry points core imports); every subpath of the telemetry
// packages.
const PACKAGE_STUBS = [
  [/^@ai-sdk\/openai$/, stub("openai-chat.mjs")],
  [/^@ai-sdk\/gateway$/, stub("unconfigured-providers.ts")],
  [/^@openrouter\/ai-sdk-provider$/, stub("unconfigured-providers.ts")],
  // Mehrpele never talks to cannoli-server (README: Security).
  [/^@deablabs\/cannoli-server\/rpc$/, stub("cannoli-server.ts")],
  [/^@deablabs\/cannoli-server\/schemas$/, stub("cannoli-server-schemas.ts")],
  [/^@deablabs\/cannoli-server$/, stub("cannoli-server.ts")],
  // No telemetry or tracing export (README: Security).
  [/^web-instrumentation-langchain(\/.*)?$/, stub("instrumentation.ts")],
  [/^@opentelemetry\//, stub("opentelemetry.ts")],
  [/^@arizeai\//, stub("opentelemetry.ts")],
];

/**
 * The only stub routing: stubbed packages, core's own `src/instrumentation` (Phoenix/OTLP
 * tracing), langsmith's `singletons/otel.js` and `client.js`, and @langchain/core's tracing
 * switch go to src/stubs. A plugin rather than esbuild's `alias`, because `alias` can't reach
 * relative imports.
 */
export const stubPlugin = {
  name: "mehrpele-flows-stubs",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (sdkSources.has(args.path)) return { path: sdkSources.get(args.path) };
      const sdkModule = args.path.startsWith(".") ? resolve(dirname(args.importer), args.path).replace(/\.ts$/, "") : "";
      if (sdkModule.endsWith("/@ai-sdk/provider-utils/src/safe-node-fetch")) return { path: stub("sdk-download.ts") };
      if (sdkModule.endsWith("/ai/src/telemetry/tracing-channel-publisher")) return { path: stub("sdk-tracing.ts") };
      if (args.importer.startsWith(coreRoot + "/")) {
        const source = args.path.startsWith("src/")
          ? resolve(coreRoot, args.path)
          : args.path.startsWith(".") ? resolve(dirname(args.importer), args.path) : "";
        const bridges = {
          [resolve(coreRoot, "src/providers")]: stub("provider-config.ts"),
          [resolve(coreRoot, "src/model/langchain")]: stub("sdk-fallback.ts"),
          [resolve(coreRoot, "src/model/ai-sdk/providers")]: stub("sdk-providers.ts"),
          [resolve(coreRoot, "src/model/ai-sdk/adapter")]: stub("sdk-adapter.ts"),
        };
        if (bridges[source.replace(/\.ts$/, "")]) return { path: bridges[source.replace(/\.ts$/, "")] };
      }
      for (const [re, target] of PACKAGE_STUBS) if (re.test(args.path)) return { path: target };
      if (args.importer.startsWith(coreRoot + "/") && /(^|\/)instrumentation$/.test(args.path)) {
        return { path: stub("instrumentation.ts") };
      }
      // langsmith's OTEL singleton (exporter hooks) -> inert mocks.
      if (args.importer.includes("/node_modules/langsmith/") && /(^|\/)singletons\/otel(\.js)?$/.test(args.path)) {
        return { path: stub("langsmith-otel.ts") };
      }
      // langsmith's API client (smith.langchain.com) -> a client that sends nothing (C3).
      if (args.importer.includes("/node_modules/langsmith/") && /^\.\/client(\.js)?$/.test(args.path)) {
        return { path: stub("langsmith-client.ts") };
      }
      // @langchain/core's env-driven tracing switch -> always off (C3).
      if (args.importer.includes("/node_modules/@langchain/core/") && /(^|\/)utils\/callbacks(\.js)?$/.test(args.path)) {
        return { path: stub("tracing-off.ts") };
      }
      return undefined;
    });
  },
};

/**
 * Build options shared by the script and the tests. `overrides` lets a test build an
 * unminified copy without a sourcemap (to read the lazy-init wrappers).
 */
export function buildOptions({ production = true, write = true, overrides = {} } = {}) {
  return {
    absWorkingDir: here,
    entryPoints: ["src/main.ts"],
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2020",
    // Keep identical Unicode strings directly instead of expanding them into ASCII escapes.
    charset: "utf8",
    treeShaking: true,
    minify: production,
    sourcemap: production ? false : "inline",
    legalComments: "eof",
    banner: { js: licenseBanner() },
    external: EXTERNALS,
    // Core's own "src/..." imports resolve through its tsconfig (baseUrl "."), which esbuild
    // reads per directory. stubPlugin routes everything stubbed.
    plugins: [stubPlugin],
    // Every free `fetch` in bundled code (core, provider SDKs, langsmith) becomes the shim's
                                                                                            
                                                                                            
    inject: [resolve(here, "src", "run", "fetch-shim.ts"), resolve(here, "src", "run", "console-shim.ts")],
    outfile: resolve(here, "main.js"),
    metafile: true,
    write,
    logLevel: write ? "info" : "silent",
    ...overrides,
  };
}

/** One build. With `write: false` the output stays in memory (result.outputFiles). */
export async function buildPlugin(args) {
  const options = buildOptions(args);
  const result = await esbuild.build(options);
  if (options.minify) {
    const output = Object.entries(result.metafile.outputs).find(([path]) => path.endsWith("main.js"))?.[1];
    if (output && output.bytes > BUNDLE_BUDGET) throw new Error(`main.js exceeds ${BUNDLE_BUDGET} bytes: ${output.bytes}`);
    const legacy = Object.keys(result.metafile.inputs).filter(path => /node_modules\/(?:@langchain|langchain|langsmith)(?:\/|$)/.test(path));
    if (legacy.length) throw new Error(`Legacy provider clients entered the companion bundle: ${legacy.join(", ")}`);
  }
  return result;
}

/** Total output bytes and the 15 largest inputs, from the metafile. */
export function sizeReport(metafile) {
  const [outfile, out] = Object.entries(metafile.outputs).find(([f]) => f.endsWith("main.js"));
  const largestInputs = Object.entries(out.inputs)
    .map(([path, v]) => ({ path, bytes: v.bytesInOutput }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 15);
  return { outfile: relative(here, resolve(here, outfile)), totalBytes: out.bytes, largestInputs };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const production = process.argv[2] === "production";
  if (production) {
    const result = await buildPlugin({ production: true, write: true });
    const report = sizeReport(result.metafile);
    writeFileSync(resolve(here, "build-report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(`main.js: ${report.totalBytes} bytes`);
    for (const { path, bytes } of report.largestInputs) console.log(`  ${String(bytes).padStart(9)}  ${path}`);
  } else {
    const ctx = await esbuild.context(buildOptions({ production: false, write: true }));
    await ctx.watch();
  }
}
