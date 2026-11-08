// Core must run on Obsidian mobile, so it may not use Node built-ins (DESIGN §13.3).
// This bundles core with esbuild for platform=browser and reports:
//   - imports of Node built-in modules (fs, path, node:crypto, ...);
//   - free references to Node-only globals (Buffer, process, __dirname, ...).
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

const coreRoot = fileURLToPath(new URL("..", import.meta.url));
const NODE_GLOBALS = ["Buffer", "process", "__dirname", "__filename", "global"];
const marker = (name: string) => `__CANNOLI_NODE_GLOBAL_${name}__`;
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

function isBuiltin(spec: string): boolean {
  const bare = spec.replace(/^node:/, "").split("/")[0];
  return builtins.has(spec) || builtins.has(bare) || spec.startsWith("node:");
}

// Paths relative to core, with dependencies shown from their node_modules entry.
function shortPath(file: string): string {
  const i = file.lastIndexOf("node_modules/");
  return i >= 0 ? file.slice(i) : file.replace(coreRoot, "");
}

async function nodeUsage(opts: { includeDependencies: boolean }) {
  const findings: string[] = [];
  const flagBuiltins: Plugin = {
    name: "flag-node-builtins",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (!isBuiltin(args.path)) return undefined;
        findings.push(`import "${args.path}" in ${shortPath(args.importer)}`);
        return { path: args.path, external: true };
      });
    },
  };
  const result = await build({
    absWorkingDir: coreRoot,
    entryPoints: ["src/index.ts"],
    bundle: true,
    write: false,
    metafile: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    logLevel: "silent",
    // src/ imports some modules as "src/..." (tsconfig baseUrl ".").
    alias: { src: "./src" },
    packages: opts.includeDependencies ? undefined : "external",
    // `define` swaps only free (global) references, so local variables named
    // `process` or `global` are left alone.
    define: Object.fromEntries(NODE_GLOBALS.map((g) => [g, marker(g)])),
    plugins: [flagBuiltins],
  });

  // esbuild prefixes each module's code with a `// path/to/file` comment.
  const out = result.outputFiles[0].text;
  let file = "?";
  for (const line of out.split("\n")) {
    const header = line.match(/^\/\/ (\S+\.[cm]?[jt]sx?)$/);
    if (header) file = shortPath(header[1]);
    for (const g of NODE_GLOBALS) {
      if (line.includes(marker(g))) findings.push(`global ${g} in ${file}`);
    }
  }
  const inputs = Object.keys(result.metafile.inputs);
  return { findings: [...new Set(findings)].sort(), inputs };
}

describe("browser-safe", () => {
  describe("core only", () => {
    let result: Awaited<ReturnType<typeof nodeUsage>> | undefined;
    let buildError: unknown;

    beforeAll(async () => {
      try {
        result = await nodeUsage({ includeDependencies: false });
      } catch (e) {
        buildError = e;
      }
    }, 60_000);

    it("builds successfully", () => {
      expect(buildError).toBeUndefined();
      expect(result).toBeDefined();
    });

    it("bundles core sources", () => {
      expect(result!.inputs).toContain("src/run.ts");
      expect(
        result!.inputs.filter((p) => p.startsWith("src/")).length,
      ).toBeGreaterThan(30);
    });

    // CallNode.ts used Buffer until P0.4 replaced it with src/util/base64.ts.
    it("has no node builtins", () => {
      expect(result!.findings).toEqual([]);
    });
  });

  describe("including dependencies", () => {
    let result: Awaited<ReturnType<typeof nodeUsage>> | undefined;
    let buildError: unknown;

    beforeAll(async () => {
      try {
        result = await nodeUsage({ includeDependencies: true });
      } catch (e) {
        buildError = e;
      }
    }, 120_000);

    it("builds successfully", () => {
      expect(buildError).toBeUndefined();
      expect(result).toBeDefined();
    });

    it("bundles core and dependency sources", () => {
      expect(result!.inputs).toContain("src/run.ts");
      expect(result!.inputs.length).toBeGreaterThan(500);
    });

    it("finds no node globals or builtins in core's own sources", () => {
      expect(result!.findings.filter((f) => / in src\//.test(f))).toEqual([]);
    });

    // Third-party code still pulls in Buffer, process, `global` and `path` even after
    // LangChain is gone (e.g. ollama, tiny-invariant, semver, whatwg-fetch). This case
    // stays expected-fail until an allowlist of
    // `typeof`-guarded references is added; don't flip it when dependencies change.
    it.fails("has no node builtins", () => {
      expect(result!.findings).toEqual([]);
    });
  });
});
