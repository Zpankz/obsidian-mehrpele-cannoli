import type { BuildOptions, BuildResult, Metafile, Plugin } from "esbuild";

export declare const EXTERNALS: string[];
export declare const BUNDLE_BUDGET: number;
export declare function licenseBanner(): string;
export declare const stubPlugin: Plugin;
export interface BuildArgs {
  production?: boolean;
  write?: boolean;
  overrides?: BuildOptions;
}
export declare function buildOptions(args?: BuildArgs): BuildOptions & { metafile: true };
export declare function buildPlugin(args?: BuildArgs): Promise<BuildResult<{ metafile: true }>>;
export declare function sizeReport(metafile: Metafile): {
  outfile: string;
  totalBytes: number;
  largestInputs: Array<{ path: string; bytes: number }>;
};
