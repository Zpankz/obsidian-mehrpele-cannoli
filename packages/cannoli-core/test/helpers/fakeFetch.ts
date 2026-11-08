// A fetch that answers like a provider (JSON or SSE) and records each request,
// so the AI SDK adapter runs its real provider code without a network.

export interface FakeRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal | null;
}

type Reply = (req: FakeRequest) => Response | Promise<Response>;

export function fakeFetch(reply: Reply) {
  const requests: FakeRequest[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    const req = { url, headers, body, signal: init?.signal };
    requests.push(req);
    return reply(req);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function sseResponse(events: unknown[]): Response {
  const text =
    events
      .map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`)
      .join("") + "data: [DONE]\n\n";
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** An OpenAI-style chat completion (Ollama, Groq, OpenAI-compatible). */
export function chatCompletion(
  message: Record<string, unknown>,
  usage: Record<string, unknown> = { prompt_tokens: 3, completion_tokens: 2 },
  finishReason = "stop",
) {
  return {
    id: "c1",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [
      {
        index: 0,
        message: { role: "assistant", ...message },
        finish_reason: finishReason,
      },
    ],
    usage,
  };
}

/** OpenAI-style stream chunks: one per text delta, then a usage chunk. */
export function chatChunks(
  deltas: string[],
  usage: Record<string, unknown> = { prompt_tokens: 3, completion_tokens: 2 },
) {
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => ({
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices,
    ...extra,
  });
  return [
    ...deltas.map((content, i) =>
      chunk([
        {
          index: 0,
          delta: i === 0 ? { role: "assistant", content } : { content },
          finish_reason: null,
        },
      ]),
    ),
    chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
    chunk([], { usage }),
  ];
}

/** An Ollama endpoint that streams `text` in words, or answers it as JSON. */
export function ollamaFetch(text: string) {
  return fakeFetch((req) =>
    req.body.stream
      ? sseResponse(chatChunks(text.split(/(?<= )/)))
      : jsonResponse(chatCompletion({ content: text })),
  );
}
