// Golden comparison (BRIEF contract): five college canvases, mock runs through the companion's
// real run path (run-golden.ts: built bundle, runCanvas, Math.random = 0, no network). The
// normalised result must equal expected/<slug>.json byte for byte. The expected files are the
                                                                                            
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Bundled, buildBundled } from "../support/bundled";
import { fixture } from "../support/runner";
import { GOLDEN } from "./golden-flows";
import { serialise } from "./normalize";
import { runGolden } from "./run-golden";

let B: Bundled;
beforeAll(async () => {
  B = await buildBundled("golden");
}, 120_000);

describe("golden canvases (mock, built bundle, runCanvas)", () => {
  for (const [slug, rel] of Object.entries(GOLDEN)) {
    test(slug, async () => {
      const expected = readFileSync(join(import.meta.dir, "expected", `${slug}.json`), "utf8");
      const r = await runGolden(B, slug, fixture(rel));
      expect(r.outcome?.status).toBe("complete");
      expect(r.network).toEqual([]);
      expect(r.io).toEqual([]);
      expect(serialise(r.normalised)).toBe(expected);
    }, 20_000);
  }
});
