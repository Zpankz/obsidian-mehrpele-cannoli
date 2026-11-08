// Builds test/support/egress-entry.ts with the plugin's esbuild options into dist/<name>/ (gitignored)
// and imports it. Only the entry, format and output change; stubs and the fetch inject stay.
import { resolve } from "node:path";
import { buildPlugin } from "../../esbuild.config.mjs";

export type Bundled = typeof import("./egress-entry");

export async function buildBundled(name: string): Promise<Bundled> {
  const outfile = resolve(import.meta.dir, "..", "..", "dist", name, "entry.mjs");
  await buildPlugin({
    production: false,
    write: true,
    overrides: {
      entryPoints: [resolve(import.meta.dir, "egress-entry.ts")],
      format: "esm",
      outfile,
      sourcemap: false,
      minify: false,
      banner: { js: "" },
      logLevel: "silent",
    },
  });
  return (await import(`${outfile}?t=${Date.now()}`)) as Bundled;
}
