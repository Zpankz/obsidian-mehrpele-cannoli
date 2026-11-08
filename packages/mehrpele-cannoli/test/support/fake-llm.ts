// An in-process fake OpenAI-compatible server on 127.0.0.1 (shapes from the lane's L1
// fake-llm.ts): POST /v1/chat/completions answers as JSON, or as SSE when body.stream is true, and
// answers a forced tool call with arguments that follow its JSON schema. Every request is kept in
// `hits`. `hang: true` never answers (until the client aborts), for stop tests. `echoKey: true`
// answers 400 with the bearer key quoted in the error body, for leak tests.

export interface Hit {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fillSchema(schema: any, fallback: string): unknown {
  if (!schema || typeof schema !== "object") return fallback;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  switch (schema.type) {
    case "object": {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties ?? {})) o[k] = fillSchema(v, fallback);
      return o;
    }
    case "array":
      return [fillSchema(schema.items, fallback)];
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    default:
      return fallback;
  }
}

function forcedTool(body: any): { name: string; parameters: any } | null {
  const name = body?.tool_choice?.function?.name ?? body?.function_call?.name;
  if (!name) return null;
  const tool = (body.tools ?? [])
    .map((t: any) => t.function)
    .concat(body.functions ?? [])
    .find((f: any) => f?.name === name);
  return { name, parameters: tool?.parameters };
}

export const FAKE_REPLY = "FAKE reply from the test server";

function completion(body: any, n: number) {
  const tool = forcedTool(body);
  const toolCall = tool && {
    id: `call_fake_${n}`,
    type: "function",
    function: { name: tool.name, arguments: JSON.stringify(fillSchema(tool.parameters, FAKE_REPLY)) },
  };
  const legacy = !!tool && !body?.tools && !!body?.functions;
  const message = toolCall
    ? legacy
      ? { role: "assistant", content: null, function_call: toolCall.function }
      : { role: "assistant", content: null, tool_calls: [toolCall] }
    : { role: "assistant", content: FAKE_REPLY };
  const finish = toolCall ? (legacy ? "function_call" : "tool_calls") : "stop";
  return { id: `chatcmpl-fake-${n}`, model: body?.model ?? "fake-model", toolCall, legacy, message, finish };
}

function sse(body: any, n: number): Response {
  const c = completion(body, n);
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({ id: c.id, object: "chat.completion.chunk", created, model: c.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const parts = [chunk({ role: "assistant", content: "" }, null)];
  if (c.toolCall) parts.push(chunk(c.legacy ? { function_call: c.toolCall.function } : { tool_calls: [{ index: 0, ...c.toolCall }] }, null));
  else parts.push(chunk({ content: FAKE_REPLY.slice(0, 10) }, null), chunk({ content: FAKE_REPLY.slice(10) }, null));
  parts.push(chunk({}, c.finish), "data: [DONE]\n\n");
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctl) {
      for (const p of parts) {
        ctl.enqueue(enc.encode(p));
        await sleep(2);
      }
      ctl.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

export function startFakeLlm(opts: { hang?: boolean; echoKey?: boolean } = {}) {
  const hits: Hit[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url);
      const raw = req.method === "GET" ? "" : await req.text();
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        // keep the text
      }
      hits.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization"), body });
      if (opts.echoKey) {
        // A provider that rejects the key and quotes it back, as some do (plain and base64).
        const key = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        const message = `Incorrect API key provided: ${key} (${btoa(key)})`;
        return Response.json({ error: { message, type: "invalid_request_error", code: "invalid_api_key" } }, { status: 400 });
      }
      if (opts.hang) {
        await new Promise<void>((r) => req.signal.addEventListener("abort", () => r()));
        return new Response("aborted", { status: 499 });
      }
      if (req.method === "POST" && /\/chat\/completions$/.test(url.pathname)) {
        const b: any = body && typeof body === "object" ? body : {};
        if (b.stream === true) return sse(b, hits.length);
        const c = completion(b, hits.length);
        return Response.json({
          id: c.id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: c.model,
          choices: [{ index: 0, message: c.message, finish_reason: c.finish, logprobs: null }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      return Response.json({ error: { message: `no route ${req.method} ${url.pathname}` } }, { status: 404 });
    },
  });
  return {
    hits,
    port: server.port as number,
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    stop: () => server.stop(true),
  };
}
