                                                                                                
// BUILT bundle (stubs plus the fetch and console injects) through runCanvas with a real key in
// secret storage; the provider is a fake on 127.0.0.1 that answers 400 with the key in its body.
// Watched: notices, the run record, the outcome, settings, every console method, unhandled
// rejections and uncaught errors. None may hold the key, plain, URL-encoded or base64.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { secretForms } from "../src/run/redact";
import { type Bundled, buildBundled } from "./support/bundled";
import { fakeApp, fileOf } from "./support/fake-app";
import { startFakeLlm } from "./support/fake-llm";
import { FAKE_KEY, fixture, HELLO, runnerHarness } from "./support/runner";

const SECRET_ID = "mehrpele-flows-key-openai-compatible";
const FLOW = "Flows/Hello world.canvas";
const METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

let B: Bundled;
const server = startFakeLlm({ echoKey: true });
beforeAll(async () => {
  B = await buildBundled("key-leak");
}, 120_000);
afterAll(() => server.stop());

function show(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack ?? ""}`;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

describe("a provider error that quotes the key", () => {
  test("never puts the key in a notice, record, outcome, console line or uncaught error", async () => {
    const raw = {
      providers: { openai_compatible: { baseUrl: server.baseUrl, model: "fake-model", secretId: SECRET_ID } },
      defaultProvider: "openai_compatible",
      network: { allowLocalhost: false },
    };
    const fake = fakeApp({ [FLOW]: fixture(HELLO) });
    fake.secrets.set(SECRET_ID, FAKE_KEY);
    const settings = B.normalizeSettings(raw);
    let h!: ReturnType<typeof runnerHarness>;
    const hostFetch = B.createHostFetch({
      getSettings: () => settings,
      transport: (url, init) => globalThis.fetch(url, init),
      onRequest: (e) => h.egress.dispatch(e),
    });
    h = runnerHarness(fake, raw, { loadEngine: async () => ({ Run: B.Run, RunController: B.RunController, RunEventBus: B.RunEventBus }), hostFetch });

    const logged: string[] = [];
    const uncaught: string[] = [];
    const real = Object.fromEntries(METHODS.map((m) => [m, console[m]]));
    for (const m of METHODS) console[m] = (...args: unknown[]) => logged.push(`${m}: ${args.map(show).join(" ")}`);
    const onUncaught = (e: unknown) => uncaught.push(`uncaught: ${show(e)}`);
    const onRejection = (e: unknown) => uncaught.push(`rejection: ${show(e)}`);
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onRejection);
    const off = B.installEgress(hostFetch);
    let out: Awaited<ReturnType<Bundled["runCanvas"]>>;
    try {
      out = await B.runCanvas(h.deps, fileOf(FLOW), { skipConfirm: true });
      await new Promise((r) => setTimeout(r, 100)); // late console lines and throws land here
    } finally {
      off();
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onRejection);
      for (const m of METHODS) console[m] = real[m] as never;
    }

    // The provider really saw the key and quoted it back, and the run ended on that error.
    expect(server.hits.length).toBeGreaterThan(0);
    expect(server.hits.every((x) => x.auth === `Bearer ${FAKE_KEY}`)).toBe(true);
    expect(out.status).toBe("error");
    expect(out.reason).toContain(`Incorrect API key provided: ‹secret:${SECRET_ID}›`);
    expect(logged.length).toBeGreaterThan(0);

    const records = [...fake.files].filter(([p]) => p.startsWith(".mehrpele-cannoli/")).map(([, v]) => v);
    expect(records.length).toBe(1);
    const artefacts: [string, string][] = [
      ["outcome", JSON.stringify(out)],
      ["settings", h.host.json ?? ""],
      ...records.map((r): [string, string] => ["record", r]),
      ...h.notices.map((n): [string, string] => ["notice", n]),
      ...logged.map((l): [string, string] => ["console", l]),
      ...uncaught.map((u): [string, string] => ["uncaught", u]),
    ];
    const leaks = artefacts.filter(([, text]) => secretForms(FAKE_KEY).some((f) => text.includes(f)));
    expect(leaks).toEqual([]);
    expect(uncaught).toEqual([]);
  }, 30_000);
});
