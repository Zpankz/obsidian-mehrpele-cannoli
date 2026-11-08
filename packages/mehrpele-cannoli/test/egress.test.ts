                                                                                       
import { describe, expect, test } from "bun:test";
import {
  createHostFetch,
  decide,
  EgressDispatcher,
  type EgressEvent,
  hostMatches,
  providerHosts,
  type RequestUrlParamLike,
  requestUrlTransport,
  textFetcher,
  type Transport,
} from "../src/run/egress";
import { fetch as shimFetch, installEgress } from "../src/run/fetch-shim";
import { electronRequestUrl } from "./support/electron-request-url";
import { type FlowsSettings, normalizeSettings } from "../src/settings/types";
import { runCanvas } from "../src/run/runner";
import { fakeApp, fileOf } from "./support/fake-app";
import { fixture, HELLO, openaiSettings, records, runnerHarness } from "./support/runner";

const settings = (extra: Record<string, unknown> = {}): FlowsSettings =>
  normalizeSettings({
    providers: { openai: { secretId: "k" }, openai_compatible: { baseUrl: "http://10.0.0.5:8080/v1" } },
    network: { allow: ["api.example.org", "*.hooks.example.com"], askFirstHost: true, allowLocalhost: true },
    ...extra,
  });

const u = (s: string) => new URL(s);

describe("decide", () => {
  test("provider hosts (host and port), localhost, allow globs, everything else", () => {
    const s = settings();
    expect([...providerHosts(s)]).toEqual(["api.openai.com", "10.0.0.5:8080"]);
    expect(decide(s, u("https://api.openai.com/v1/chat/completions"))).toBe("allow");
    expect(decide(s, u("http://10.0.0.5:8080/v1/x"))).toBe("allow");
    expect(decide(s, u("http://10.0.0.5:9999/v1/x"))).toBe("deny");
    expect(decide(s, u("https://api.anthropic.com/v1/messages"))).toBe("deny");
    expect(decide(s, u("http://localhost:11434/api"))).toBe("allow");
    expect(decide(s, u("http://127.0.0.1:1/"))).toBe("allow");
    expect(decide(s, u("https://api.example.org/x"))).toBe("ask");
    expect(decide(s, u("https://a.hooks.example.com/x"))).toBe("ask");
    expect(decide(s, u("https://hooks.example.com/x"))).toBe("deny");
    expect(decide(s, u("https://evil.example.org/x"))).toBe("deny");
    expect(decide(s, u("file:///etc/passwd"))).toBe("deny");
    expect(decide(s, u("https://smith.langchain.com/runs"))).toBe("deny");
  });

  test("approved hosts, ask off and localhost off", () => {
    expect(decide(settings({ network: { allow: ["api.example.org"], approvedHosts: ["api.example.org"] } }), u("https://api.example.org/"))).toBe("allow");
    expect(decide(settings({ network: { allow: ["api.example.org"], askFirstHost: false } }), u("https://API.example.org/"))).toBe("allow");
    expect(decide(settings({ network: { allowLocalhost: false } }), u("http://localhost:1/"))).toBe("deny");
  });

  test("hostMatches is anchored and case-insensitive", () => {
    expect(hostMatches("*.example.org", "a.example.org")).toBe(true);
    expect(hostMatches("*.example.org", "example.org")).toBe(false);
    expect(hostMatches("example.org", "example.org.evil.com")).toBe(false);
    expect(hostMatches("EXAMPLE.org", "example.ORG")).toBe(true);
    expect(hostMatches("a.b", "aXb")).toBe(false);
    expect(hostMatches("  ", "x")).toBe(false);
  });
});

function harness(s: FlowsSettings, answer = true) {
  const sent: string[] = [];
  const asks: string[] = [];
  const approved: string[] = [];
  const events: EgressEvent[] = [];
  const transport: Transport = async (url) => {
    sent.push(url);
    return new Response("ok");
  };
  const hostFetch = createHostFetch({
    getSettings: () => s,
    transport,
    askHost: async (h) => {
      asks.push(h);
      await Bun.sleep(5);
      return answer;
    },
    onApprove: (h) => {
      approved.push(h);
      s.network.approvedHosts.push(h);
    },
    onRequest: (e) => events.push(e),
  });
  return { hostFetch, sent, asks, approved, events };
}

describe("createHostFetch", () => {
  test("a denied host throws and the transport is never called", async () => {
    const h = harness(settings());
    await expect(h.hostFetch("https://evil.example.net/x?k=1")).rejects.toThrow("Host not allowed: evil.example.net");
    await expect(h.hostFetch("not a url")).rejects.toThrow("Host not allowed: not a url");
    expect(h.sent).toEqual([]);
    expect(h.events).toEqual([{ url: "https://evil.example.net/x", host: "evil.example.net", allowed: false }]);
  });

  test("concurrent first requests to a host ask once; the approval persists", async () => {
    const s = settings();
    const h = harness(s);
    await Promise.all([h.hostFetch("https://api.example.org/a"), h.hostFetch("https://api.example.org/b")]);
    await h.hostFetch("https://api.example.org/c");
    expect(h.asks).toEqual(["api.example.org"]);
    expect(h.approved).toEqual(["api.example.org"]);
    expect(h.sent).toEqual(["https://api.example.org/a", "https://api.example.org/b", "https://api.example.org/c"]);
    expect(s.network.approvedHosts).toEqual(["api.example.org"]);
  });

  test("a declined prompt denies, and asks again next time", async () => {
    const h = harness(settings(), false);
    await expect(h.hostFetch("https://api.example.org/a")).rejects.toThrow("Host not allowed: api.example.org");
    await expect(h.hostFetch("https://api.example.org/a")).rejects.toThrow("Host not allowed");
    expect(h.asks).toEqual(["api.example.org", "api.example.org"]);
    expect(h.sent).toEqual([]);
  });

  test("Request inputs keep method, headers and body", async () => {
    let seen: RequestInit | null = null;
    const hf = createHostFetch({
      getSettings: () => settings(),
      transport: async (_url, init) => {
        seen = init;
        return new Response("ok");
      },
    });
    await hf(new Request("https://api.openai.com/v1/x", { method: "POST", headers: { "x-a": "1" }, body: "hi" }), { headers: { "x-b": "2" } });
    const init = seen as unknown as RequestInit;
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-a")).toBe("1");
    expect(new Headers(init.headers).get("x-b")).toBe("2");
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe("hi");
  });

  test("textFetcher returns errors as values", async () => {
    const hf = createHostFetch({ getSettings: () => settings(), transport: async () => new Response("nope", { status: 500 }) });
    const tf = textFetcher(hf);
    expect(await tf("https://api.openai.com/x", {})).toEqual(new Error("HTTP 500: nope"));
    expect(String(await tf("https://evil.example.net/x", {}))).toBe("HostNotAllowedError: Host not allowed: evil.example.net");
    const ok = textFetcher(createHostFetch({ getSettings: () => settings(), transport: async () => new Response("body") }));
    expect(await ok("https://api.openai.com/x", {})).toBe("body");
  });
});

describe("fetch shim", () => {
  test("with no egress installed every request is refused; install routes, uninstall restores", async () => {
    await expect(shimFetch("https://api.openai.com/v1/models")).rejects.toThrow("Host not allowed: api.openai.com");
    const seen: string[] = [];
    const off = installEgress(async (input) => {
      seen.push(String(input));
      return new Response("routed");
    });
    expect(await (await shimFetch("https://x.example.org/")).text()).toBe("routed");
    off();
    await expect(shimFetch(new URL("https://x.example.org/"))).rejects.toThrow("Host not allowed: x.example.org");
    expect(seen).toEqual(["https://x.example.org/"]);
  });

  test("an old uninstall does not remove a newer egress", async () => {
    const offA = installEgress(async () => new Response("a"));
    const offB = installEgress(async () => new Response("b"));
    offA();
    expect(await (await shimFetch("https://x.example.org/")).text()).toBe("b");
    offB();
  });
});

describe("requestUrlTransport", () => {
  test("maps the request and the response, with no throw on HTTP errors", async () => {
    const calls: any[] = [];
    const t = requestUrlTransport(async (p) => {
      calls.push(p);
      return { status: 404, headers: { "content-type": "application/json" }, arrayBuffer: new TextEncoder().encode('{"e":1}').buffer as ArrayBuffer };
    });
    const res = await t("https://api.openai.com/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"a":1}' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ e: 1 });
    expect(calls[0]).toEqual({
      url: "https://api.openai.com/x",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
      contentType: "application/json",
      throw: false,
    });
  });

  test("non-string bodies become ArrayBuffers; 204 has no body; aborted signals throw", async () => {
    let body: unknown;
    const t = requestUrlTransport(async (p) => {
      body = p.body;
      return { status: 204, headers: {}, arrayBuffer: new ArrayBuffer(0) };
    });
    const res = await t("https://a.example.org/", { method: "PUT", body: new Uint8Array([1, 2]) });
    expect(res.status).toBe(204);
    expect(new Uint8Array(body as ArrayBuffer)).toEqual(new Uint8Array([1, 2]));
    const ac = new AbortController();
    ac.abort();
    await expect(t("https://a.example.org/", { signal: ac.signal })).rejects.toThrow("aborted");
  });

  test("headers the browser controls never reach requestUrl (Electron rejects them)", async () => {
    const seen: RequestUrlParamLike[] = [];
    const t = requestUrlTransport(
      electronRequestUrl(seen, async () => ({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0) })),
    );
    const forbidden = {
      "Content-Length": "7",
      Host: "api.openai.com",
      Connection: "keep-alive",
      "Keep-Alive": "timeout=5",
      "Transfer-Encoding": "chunked",
      Upgrade: "h2c",
      TE: "trailers",
      Trailer: "x",
      "Proxy-Authorization": "Basic aaaa",
      "Sec-Fetch-Mode": "cors",
      Cookie2: "a=b",
      Date: "Tue, 03 Nov 2026 00:00:00 GMT",
      Expect: "100-continue",
      Via: "1.1 proxy",
      Origin: "app://obsidian.md",
      Referer: "app://obsidian.md/",
      "Accept-Encoding": "gzip",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "x",
    };
    const kept = { authorization: "Bearer fake-key-for-tests-aaaa", "user-agent": "OpenAI/JS", "x-stainless-os": "MacOS", accept: "application/json" };
    const res = await t("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { ...forbidden, ...kept, "Content-Type": "application/json" },
      body: '{"a":1}',
    });
    expect(res.status).toBe(200);
    expect(seen[0].headers).toEqual({ ...kept, "content-type": "application/json" });
  });
});

describe("per-run egress", () => {
  test("tagged events reach only their run; untagged (SDK) ones reach every active run, marked shared", async () => {
    const d = new EgressDispatcher();
    const seen: Record<string, EgressEvent[]> = { a: [], b: [] };
    const offA = d.subscribe("a", (e) => seen.a.push(e));
    d.subscribe("b", (e) => seen.b.push(e));
    const hostFetch = createHostFetch({ getSettings: settings, transport: async () => new Response("ok"), onRequest: (e) => d.dispatch(e) });
    await hostFetch("https://api.openai.com/v1/a", {}, "a");
    await hostFetch("https://api.openai.com/v1/sdk");
    offA();
    await hostFetch("https://api.openai.com/v1/sdk-after");
    const ev = (path: string, shared?: boolean) => ({ url: `https://api.openai.com/v1/${path}`, host: "api.openai.com", allowed: true, ...(shared ? { shared } : {}) });
    expect(seen.a).toEqual([ev("a"), ev("sdk", true)]);
    expect(seen.b).toEqual([ev("sdk", true), ev("sdk-after")]);
  });

  test("two runs at once: each record holds its own engine requests, never the other run's", async () => {
    const A = "Flows/A.canvas";
    const B = "Flows/B.canvas";
    const fake = fakeApp({ [A]: fixture(HELLO), [B]: fixture(HELLO) });
    let arrived = 0;
    let bothStarted!: () => void;
    const barrier = new Promise<void>((r) => (bothStarted = r));
    const loadEngine = async () => {
      const m = await import("../src/flows/engine");
      type Args = ConstructorParameters<typeof m.Run>[0];
      class Fetching extends m.Run {
        constructor(private readonly given: Args) {
          super(given);
        }
        async start() {
          if (++arrived === 2) bothStarted();
          await barrier;
          // what an HTTP node does: the engine's own fetcher, then provider traffic via the shim
          await this.given.fetcher?.(`https://api.openai.com/v1/${this.given.runName}`, { method: "GET" });
          await h.deps.hostFetch(`https://api.openai.com/v1/sdk-${this.given.runName}`);
          return super.start();
        }
      }
      return { ...m, Run: Fetching as typeof m.Run };
    };
    const h = runnerHarness(fake, openaiSettings(), { loadEngine });
    h.deps.hostFetch = createHostFetch({
      getSettings: () => normalizeSettings(openaiSettings()),
      transport: async () => new Response("ok"),
      onRequest: (e) => h.egress.dispatch(e),
    });
    const [a, b] = await Promise.all([
      runCanvas(h.deps, fileOf(A), { isMock: true, skipConfirm: true }),
      runCanvas(h.deps, fileOf(B), { isMock: true, skipConfirm: true }),
    ]);
    expect([a.status, b.status]).toEqual(["complete", "complete"]);
    const urls = (flow: string) =>
      records(fake)
        .find((r) => r.flowPath === flow)
        .egress.map((e: EgressEvent) => `${e.url.replace("https://api.openai.com/v1/", "")}${e.shared ? " (shared)" : ""}`)
        .sort();
    expect(urls(A)).toEqual(["A", "sdk-A (shared)", "sdk-B (shared)"]);
    expect(urls(B)).toEqual(["B", "sdk-A (shared)", "sdk-B (shared)"]);
  });
});
