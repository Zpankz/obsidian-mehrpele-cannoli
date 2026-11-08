// The engine's public surface (README: Security): an exact list, so a hosted action such as
// bake or callCannoliFunction can't be re-exported unnoticed.
import { expect, test } from "bun:test";
import * as engine from "../src/flows/engine";

test("re-exports only the run API, the canvas schema and the marker", () => {
  expect(Object.keys(engine).sort()).toEqual([
    "ENGINE_MARKER",
    "LLMProvider",
    "Run",
    "RunController",
    "RunEventBus",
    "canvasDataSchema",
    "resultsRun",
    "run",
  ]);
});
