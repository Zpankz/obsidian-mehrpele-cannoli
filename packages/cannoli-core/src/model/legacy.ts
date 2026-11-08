// Converts between the legacy GenericCompletionResponse shape and the Message
// model (DESIGN §4.2). Edge payloads, chatFormatString and bake.ts keep the
// legacy shape until they migrate; LangchainModelPort converts back before
// calling LLMProvider, so the round trip must keep everything LangChain or
// the graph reads.
import type {
  GenericCompletionParams,
  GenericCompletionResponse,
  GenericModelConfig,
  ImageReference,
} from "../providers";
import type {
  ContentPart,
  GenerateRequest,
  GenerateResult,
  Message,
  ModelRef,
  ProviderId,
  ToolCallPart,
  Usage,
} from "./types";

/** What a Message keeps for the LangChain path in providerOptions.langchain. */
interface LangchainMessageOptions {
  /** The legacy role, when it isn't one of the four Message roles. */
  role?: string | null;
}

const ROLES = new Set<string>(["system", "user", "assistant", "tool"]);

const PROVIDER_IDS: Record<string, ProviderId> = {
  openai: "openai",
  anthropic: "anthropic",
  ollama: "ollama",
  gemini: "google",
  azure_openai: "openai",
  groq: "openai-compatible",
};

/** A model ref for display and routing; the exact legacy config travels in providerOptions.langchain. */
export function toModelRef(provider?: string, model?: string): ModelRef {
  return `${PROVIDER_IDS[provider ?? "openai"] ?? "openai-compatible"}:${model ?? ""}`;
}

function mediaTypeOf(url: string): string {
  return /^data:([^;,]+)[;,]/.exec(url)?.[1] ?? "image/*";
}

function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

function fromLegacyMessage(
  m: GenericCompletionResponse,
  previous?: GenericCompletionResponse,
): Message {
  let message: Message;
  if ("function_call" in m) {
    // LLMProvider.convertMessages sends any message with this key as an AIMessage.
    const parts: ContentPart[] = [];
    if (m.content) parts.push({ type: "text", text: m.content });
    if (m.function_call) {
      // LangChain tool calls also carry id and type; keep them as they are.
      const { name, args, ...extra } = m.function_call;
      const call: ToolCallPart = {
        type: "tool-call",
        toolCallId: m.function_call_id ?? "",
        toolName: name,
        input: args,
      };
      if (Object.keys(extra).length)
        call.providerOptions = { langchain: extra };
      parts.push(call);
    }
    message = { role: "assistant", content: parts.length ? parts : m.content };
  } else if (m.role === "tool") {
    message = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: m.function_call_id ?? "",
          toolName: previous?.function_call?.name ?? "unknown",
          output: m.content,
        },
      ],
    };
  } else {
    message = {
      role: ROLES.has(m.role ?? "") ? (m.role as Message["role"]) : "user",
      content: m.content,
    };
  }
  if (m.role !== message.role) {
    const langchain: LangchainMessageOptions = { role: m.role ?? null };
    message.providerOptions = { langchain };
  }
  return message;
}

/** Legacy messages and their image references to Messages. */
export function fromLegacyMessages(
  messages: GenericCompletionResponse[],
  imageReferences: ImageReference[] = [],
): Message[] {
  return messages.map((m, i) => {
    const message = fromLegacyMessage(m, messages[i - 1]);
    const images: ContentPart[] = imageReferences
      .filter((ref) => ref.messageIndex === i)
      .map((ref) => ({
        type: "image",
        data: ref.url,
        mediaType: mediaTypeOf(ref.url),
      }));
    if (images.length) {
      const parts: ContentPart[] =
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content;
      message.content = [...parts, ...images];
    }
    return message;
  });
}

function toLegacyMessage(m: Message): GenericCompletionResponse {
  const langchain = m.providerOptions?.langchain as
    | LangchainMessageOptions
    | undefined;
  const role =
    langchain && "role" in langchain ? (langchain.role ?? undefined) : m.role;
  const parts = typeof m.content === "string" ? [] : m.content;
  const content = textOf(m.content);

  const call = parts.find((p): p is ToolCallPart => p.type === "tool-call");
  if (m.role === "assistant" && call) {
    return {
      role,
      content,
      function_call_id: call.toolCallId || undefined,
      function_call: {
        name: call.toolName,
        args: call.input as Record<string, unknown>,
        ...(call.providerOptions?.langchain as Record<string, unknown>),
      },
    };
  }

  const result = parts.find((p) => p.type === "tool-result");
  if (m.role === "tool" && result?.type === "tool-result") {
    return {
      role,
      content:
        typeof result.output === "string"
          ? result.output
          : JSON.stringify(result.output),
      function_call_id: result.toolCallId || undefined,
    };
  }

  return { role, content };
}

/** Messages to legacy messages, with image parts as image references. */
export function toLegacyMessages(messages: Message[]): {
  messages: GenericCompletionResponse[];
  imageReferences?: ImageReference[];
} {
  const imageReferences: ImageReference[] = [];
  messages.forEach((m, messageIndex) => {
    if (typeof m.content === "string") return;
    for (const part of m.content) {
      if (part.type !== "image") continue;
      const url = typeof part.data === "string" ? part.data : part.data.href;
      imageReferences.push({ url, messageIndex });
    }
  });
  return {
    messages: messages.map(toLegacyMessage),
    ...(imageReferences.length ? { imageReferences } : {}),
  };
}

/** A legacy completion request to a GenerateRequest. */
export function fromLegacyParams(
  params: GenericCompletionParams,
  signal: AbortSignal,
): GenerateRequest {
  const {
    messages,
    imageReferences,
    temperature,
    max_tokens,
    functions,
    function_call,
    ...config
  } = params;
  const request: GenerateRequest = {
    model: toModelRef(config.provider, config.model),
    messages: fromLegacyMessages(messages, imageReferences),
    // The rest of the legacy config. provider and model stay even when unset,
    // so LLMProvider falls back to its defaults rather than to the model ref.
    providerOptions: {
      langchain: { provider: config.provider, model: config.model, ...config },
    },
    signal,
  };
  if (functions) {
    request.tools = functions.map((f) => ({
      name: f.name,
      description: f.description,
      inputSchema: f.parameters,
    }));
  }
  if (function_call) request.toolChoice = { toolName: function_call.name };
  if (temperature !== undefined) request.temperature = temperature;
  if (max_tokens !== undefined) request.maxOutputTokens = max_tokens;
  return request;
}

/** A GenerateRequest to the legacy completion request LLMProvider takes. */
export function toLegacyParams(req: GenerateRequest): GenericCompletionParams {
  const config = (req.providerOptions?.langchain ?? {}) as GenericModelConfig;
  const separator = req.model.indexOf(":");
  const messages: Message[] = req.instructions
    ? [{ role: "system", content: req.instructions }, ...req.messages]
    : req.messages;
  const providerId = req.model.slice(0, separator);
  const params: GenericCompletionParams = {
    provider: providerId === "google" ? "gemini" : providerId,
    model: req.model.slice(separator + 1),
    ...config,
    ...toLegacyMessages(messages),
  };
  if (req.tools) {
    params.functions = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
  }
  if (typeof req.toolChoice === "object") {
    params.function_call = { name: req.toolChoice.toolName };
  }
  if (req.temperature !== undefined) params.temperature = req.temperature;
  if (req.maxOutputTokens !== undefined)
    params.max_tokens = req.maxOutputTokens;
  return params;
}

/** A legacy completion to a GenerateResult. */
export function fromLegacyResponse(
  response: GenericCompletionResponse,
  usage?: Usage,
): GenerateResult {
  return {
    text: response.content,
    messages: fromLegacyMessages([response]),
    ...(usage ? { usage } : {}),
    finishReason: response.function_call ? "tool-calls" : "stop",
  };
}

/** A GenerateResult to the legacy completion the graph reads. */
export function toLegacyResponse(
  result: GenerateResult,
): GenericCompletionResponse {
  const last = result.messages.at(-1);
  return last
    ? toLegacyMessage(last)
    : { role: "assistant", content: result.text };
}
