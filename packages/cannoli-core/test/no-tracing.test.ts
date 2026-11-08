import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LLMProvider } from "src/providers";

const coreRoot = fileURLToPath(new URL("..", import.meta.url));

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });

describe("no Phoenix/Arize tracing", () => {
  it("core source has no Phoenix, Arize or OpenTelemetry code", () => {
    const hits = sourceFiles(join(coreRoot, "src")).filter((file) =>
      /phoenix|\barize|opentelemetry|tracingConfig/i.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(hits).toEqual([]);
  });

  it("core depends on no tracing packages", () => {
    const pkg = JSON.parse(
      readFileSync(join(coreRoot, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    const tracing = Object.keys(pkg.dependencies).filter((name) =>
      /^@arizeai\/|^@opentelemetry\/|^web-instrumentation-langchain$/.test(
        name,
      ),
    );
    expect(tracing).toEqual([]);
  });
});

// LangChain adds a LangSmith tracer to every call when one of these is "true".
const TRACING_ENV = {
  LANGSMITH_TRACING: "true",
  LANGSMITH_TRACING_V2: "true",
  LANGCHAIN_TRACING: "true",
  LANGCHAIN_TRACING_V2: "true",
  LANGSMITH_API_KEY: "test-key",
  LANGCHAIN_API_KEY: "test-key",
  LANGSMITH_ENDPOINT: "http://tracing.invalid",
  LANGCHAIN_ENDPOINT: "http://tracing.invalid",
  // Await callbacks inline so a tracer, if attached, runs before we check.
  LANGCHAIN_CALLBACKS_BACKGROUND: "false",
};

describe("LangSmith tracing can't be switched on from the environment", () => {
  const saved: Record<string, string | undefined> = {};
  const fetchMock = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response("{}", { status: 200 }),
  );

  beforeAll(() => {
    for (const [key, value] of Object.entries(TRACING_ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    vi.stubGlobal("fetch", fetchMock);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.unstubAllGlobals();
  });

  const provider = () => {
    const llm = new LLMProvider({
      configs: [{ provider: "ollama", model: "fake" }],
    });
    // The fake model makes no network calls, so any fetch is tracing.
    llm.getChatClient = () =>
      new FakeListChatModel({ responses: ["one", "two", "three"] });
    return llm;
  };

  it("completion, function call and stream make no network call", async () => {
    const llm = provider();
    const messages = [{ role: "user", content: "hi" }];

    const completion = await llm.getCompletion({ messages });
    expect(completion.content).toBe("one");

    await llm.getCompletion({
      messages,
      functions: [{ name: "choice", parameters: {} }],
      function_call: { name: "choice" },
    });

    let streamed = "";
    for await (const chunk of await llm.getCompletionStream({ messages })) {
      streamed += chunk;
    }
    expect(streamed).toBe("one");

    // LangSmith batches runs on a short timer; give it time to flush.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([]);
  });
});
