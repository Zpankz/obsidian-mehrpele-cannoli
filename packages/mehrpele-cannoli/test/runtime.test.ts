import { describe, expect, test } from "bun:test";
import { normalizeSettings } from "../src/settings/types";
import { RunUsage } from "../src/run/events";
import { buildLlmConfig } from "../src/run/llm-configs";
import { RunViewPersistor } from "../src/run/persistor";
import { runSecrets } from "../src/run/secrets";

describe("run-scoped secret resolution", () => {
  test("logical names resolve only the selected id, and auth follows rotations and revocation", () => {
    const reads: string[] = [];
    let value: string | null = "fake-first-secret";
    const s = runSecrets({ getSecret: id => (reads.push(id), value), setSecret: () => {} }, "openai", "selected-key");
    const config = buildLlmConfig(normalizeSettings({}), "openai", s.apiKey);
    expect(reads).toEqual([]);
    expect(s.resolver.names()).toEqual(["OPENAI_API_KEY"]);
    expect(s.resolver.get("selected-key")).toBeNull();
    expect(s.resolver.get("VALTOWN_API_KEY")).toBeNull();
    expect(reads).toEqual([]);
    const redact = s.redactor.text;
    expect(config.apiKey).toBe("fake-first-secret");
    value = "fake-rotated-secret";
    expect(config.apiKey).toBe("fake-rotated-secret");
    expect(redact("fake-first-secret fake-rotated-secret")).toBe("‹secret:selected-key› ‹secret:selected-key›");
    expect(reads).toEqual(["selected-key", "selected-key"]);
    value = null;
    expect(() => config.apiKey).toThrow("not in secure storage");
  });
  test("mock/keyless resolver does not read storage", () => {
    let reads = 0;
    const s = runSecrets({ getSecret: () => (reads++, "unused"), setSecret: () => {} }, "openai", undefined);
    expect(s.resolver.names()).toEqual([]);
    expect(s.resolver.get("OPENAI_API_KEY")).toBeNull();
    expect(s.apiKey()).toBeUndefined();
    expect(reads).toBe(0);
  });
});

describe("runtime events", () => {
  test("batched snapshots cannot revert a newer node status", async () => {
    const view = new RunViewPersistor();
    view.seed({ nodes: [{ id: "n", text: "node" }] });
    view.onEvent({ t: "node-status", id: "n", status: "complete" as never, at: 1 });
    await view.editNode({ id: "n", cannoliData: { status: "executing" } });
    view.sync({ n: { status: "pending" } });
    await view.start({ nodes: [{ id: "n", text: "node" }] });
    expect(view.list()[0]!.status).toBe("complete");
    await view.addError("n", "diagnostic");
    view.onEvent({ t: "node-status", id: "n", status: "complete" as never, at: 2 });
    expect(view.list()[0]).toMatchObject({ status: "error", message: "diagnostic" });
  });
  test("usage deduplicates calls, preserves unknown cost and accepts terminal totals", () => {
    const usage = new RunUsage();
    expect(usage.snapshot()).toBeNull();
    const event = { t: "model-finish" as const, id: "n", callId: "one", usage: { inputTokens: 4, outputTokens: 3 }, ms: 10 };
    usage.accept(event);
    usage.accept(event);
    expect(usage.snapshot()).toEqual({ inputTokens: 4, outputTokens: 3, costUsd: null });
    usage.accept({ t: "model-finish", id: "n", callId: "two", usage: { inputTokens: 2, outputTokens: 1, costUsd: 0.01 }, ms: 1 });
    expect(usage.snapshot()).toEqual({ inputTokens: 6, outputTokens: 4, costUsd: null });
    usage.accept({ t: "run-start", runId: "core-run", canvasPath: "note.md", canvasHash: "hash", at: 0 });
    usage.accept({ t: "run-finish", status: "stopped", usage: { inputTokens: 7, outputTokens: 5 }, costUsd: null, at: 20 });
    expect(usage.snapshot()).toEqual({ inputTokens: 7, outputTokens: 5, costUsd: null });
    expect(usage.coreRunId).toBe("core-run");
  });
});
