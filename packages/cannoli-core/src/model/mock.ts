// MockModelPort: a deterministic ModelPort for tests and hosts without a
// model. The same request always gets the same reply and usage.
import type { ModelPort } from "./port";
import type {
  GenerateRequest,
  GenerateResult,
  Message,
  ModelStreamEvent,
} from "./types";

export interface MockModelPortOptions {
  /** The reply, or a function of the request. Defaults to "Mock response". */
  text?: string | ((req: GenerateRequest) => string);
}

function promptText(req: GenerateRequest): string {
  const text = (m: Message) =>
    typeof m.content === "string"
      ? m.content
      : m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
  return (req.instructions ?? "") + req.messages.map(text).join("");
}

/** About 4 characters a token, as the mock run estimates. */
const tokens = (text: string) => Math.ceil(text.length / 4);

export class MockModelPort implements ModelPort {
  /** Every request this port received, in order. */
  readonly requests: GenerateRequest[] = [];

  constructor(private readonly options: MockModelPortOptions = {}) {}

  private reply(req: GenerateRequest): GenerateResult {
    if (req.signal.aborted) throw req.signal.reason;
    this.requests.push(req);
    const { text: option = "Mock response" } = this.options;
    const text = typeof option === "function" ? option(req) : option;
    return {
      text,
      messages: [{ role: "assistant", content: text }],
      usage: {
        inputTokens: tokens(promptText(req)),
        outputTokens: tokens(text),
      },
      finishReason: "stop",
    };
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.reply(req);
  }

  /** The reply word by word, then its usage, then finish. */
  async *stream(req: GenerateRequest): AsyncGenerator<ModelStreamEvent> {
    const result = this.reply(req);
    for (const word of result.text.split(/(?<= )/)) {
      if (req.signal.aborted) {
        yield { type: "error", error: req.signal.reason };
        return;
      }
      yield { type: "text-delta", text: word };
    }
    if (result.usage) yield { type: "usage", usage: result.usage };
    yield { type: "finish", result };
  }
}
