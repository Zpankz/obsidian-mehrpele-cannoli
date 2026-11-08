// Compile-only consumer regression: runtimes such as Bun add static helpers to fetch.
// An injected browser transport must not have to implement those runtime helpers.
import type { RunArgs } from "../../src/run";
import type { AiSdkModelPortOptions } from "../../src/model/ai-sdk/adapter";
import { createProviderModel } from "../../src/model/ai-sdk/providers";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Merge a runtime's static helper into the global fetch function.
  namespace fetch {
    const preconnect: (url: string) => void;
  }
}

const transport = async (_input: RequestInfo | URL, _init?: RequestInit) =>
  new Response("ok");
const runOptions: Pick<RunArgs, "modelFetch"> = { modelFetch: transport };
const sdkOptions: AiSdkModelPortOptions = { providers: [], fetch: transport };
const providerFetch: Parameters<typeof createProviderModel>[2] = transport;
void [runOptions, sdkOptions, providerFetch];
