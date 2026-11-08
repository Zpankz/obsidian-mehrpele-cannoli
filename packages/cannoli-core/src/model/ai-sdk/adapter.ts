import type { ModelFetch } from "../fetch";
// AiSdkModelPort: ModelPort over the Vercel AI SDK v7 (DESIGN §4.2, P1.3).
// Structured output (`req.output`, Output.choice) comes in P1.4; until then
// legacy forced function calls go through a single forced tool.
import {
  generateText,
  isStepCount,
  jsonSchema,
  streamText,
  tool,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type SystemModelMessage,
  type ToolChoice,
  type ToolSet,
} from "ai";
import { safeKeyName } from "../../utility";
import type { GenericModelConfig } from "../../providers";
import type { ModelPort } from "../port";
import { apiIdFor } from "../registry";
import type {
  ContentPart,
  GenerateRequest,
  GenerateResult,
  Message,
  ModelStreamEvent,
  ToolCallPart,
  Usage,
} from "../types";
import {
  createProviderModel,
  LEGACY_PROVIDER_IDS,
  type AiSdkProviderConfig,
} from "./providers";

export interface AiSdkModelPortOptions {
  providers: AiSdkProviderConfig[];
  /** The fetch every provider uses; the global fetch when unset. */
  fetch?: ModelFetch;
  /** Takes calls no configured provider can serve. */
  fallback?: ModelPort;
  /** Model steps per call; the default 1 returns tool calls to the caller. */
  maxSteps?: number;
}

type SdkProviderOptions = Record<string, Record<string, never>>;
type Part = Exclude<ModelMessage["content"], string>[number];

/** Request options without the LangChain-only entry. */
function sdkProviderOptions(
  options: Record<string, unknown> | undefined,
): SdkProviderOptions | undefined {
  if (!options) return undefined;
  const { langchain: _langchain, ...rest } = options;
  return Object.keys(rest).length ? (rest as SdkProviderOptions) : undefined;
}

function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
}

/**
 * An image as a base64 (or bytes) file part; the SDK deprecates image parts.
 * URLs are fetched here, so they never reach the provider.
 */
async function imagePart(
  part: Extract<ContentPart, { type: "image" }>,
  fetch: ModelFetch,
  signal?: AbortSignal,
): Promise<Part> {
  const data = typeof part.data === "string" ? part.data : part.data.href;
  const dataUrl = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(data);
  if (dataUrl) {
    const [, mediaType, base64, payload] = dataUrl;
    return {
      type: "file",
      data: base64 ? payload : btoa(decodeURIComponent(payload)),
      mediaType: mediaType ?? part.mediaType,
    };
  }
  if (/^https?:\/\//i.test(data)) {
    const response = await fetch(data, { signal });
    if (!response.ok) {
      throw new Error(`Could not fetch image ${data}: ${response.status}`);
    }
    const mediaType = response.headers.get("content-type") ?? part.mediaType;
    return {
      type: "file",
      data: new Uint8Array(await response.arrayBuffer()),
      mediaType: mediaType.split(";")[0],
    };
  }
  // Already base64.
  return { type: "file", data, mediaType: part.mediaType };
}

function toolResultOutput(part: Extract<ContentPart, { type: "tool-result" }>) {
  const { output, isError } = part;
  if (typeof output === "string") {
    return isError
      ? { type: "error-text" as const, value: output }
      : { type: "text" as const, value: output };
  }
  const value = (output ?? null) as never;
  return isError
    ? { type: "error-json" as const, value }
    : { type: "json" as const, value };
}

function toolCallOf(part: ToolCallPart): Part {
  const providerOptions = sdkProviderOptions(part.providerOptions);
  return {
    type: "tool-call",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: part.input,
    ...(providerOptions ? { providerOptions } : {}),
  };
}

async function toModelMessage(
  m: Message,
  fetch: ModelFetch,
  signal?: AbortSignal,
): Promise<ModelMessage> {
  const providerOptions = sdkProviderOptions(m.providerOptions);
  const extra = providerOptions ? { providerOptions } : {};
  if (m.role === "system") {
    return { role: "system", content: textOf(m.content), ...extra };
  }
  if (typeof m.content === "string") {
    // A tool turn needs a tool result; plain text from one is user text.
    const role = m.role === "tool" ? "user" : m.role;
    return { role, content: m.content, ...extra };
  }
  const parts: Part[] = [];
  for (const part of m.content) {
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text });
        break;
      case "image":
        if (m.role === "user") parts.push(await imagePart(part, fetch, signal));
        break;
      case "file":
        parts.push({
          type: "file",
          data: part.data,
          mediaType: part.mediaType,
          ...(part.filename ? { filename: part.filename } : {}),
        });
        break;
      case "reasoning":
        if (m.role === "assistant") {
          parts.push({ type: "reasoning", text: part.text });
        }
        break;
      case "tool-call":
        if (m.role === "assistant") parts.push(toolCallOf(part));
        break;
      case "tool-result":
        parts.push({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: toolResultOutput(part),
        });
        break;
    }
  }
  if (m.role === "tool") {
    const results = parts.filter((p) => p.type === "tool-result");
    if (results.length) {
      return { role: "tool", content: results, ...extra } as ModelMessage;
    }
    return { role: "user", content: textOf(m.content), ...extra };
  }
  return { role: m.role, content: parts, ...extra } as ModelMessage;
}

export interface AiSdkPrompt {
  instructions?: SystemModelMessage[];
  messages: ModelMessage[];
  allowSystemInMessages: boolean;
}

/**
 * The AI SDK prompt for a request. v7 rejects system messages inside
 * `messages` by default: leading ones become `instructions`, and system turns
 * later in the history are allowed explicitly.
 */
export async function toAiSdkPrompt(
  req: GenerateRequest,
  fetch: ModelFetch = globalThis.fetch,
): Promise<AiSdkPrompt> {
  const messages = await Promise.all(
    req.messages.map((m) => toModelMessage(m, fetch, req.signal)),
  );
  const top: SystemModelMessage[] = req.instructions
    ? [{ role: "system", content: req.instructions }]
    : [];
  const firstOther = messages.findIndex((m) => m.role !== "system");
  if (firstOther === -1) {
    // Only system text, which legacy canvases send: keep it as the messages,
    // since the SDK needs at least one.
    return { messages: [...top, ...messages], allowSystemInMessages: true };
  }
  const leading = messages.slice(0, firstOther) as SystemModelMessage[];
  const rest = messages.slice(firstOther);
  const instructions = [...top, ...leading];
  return {
    ...(instructions.length ? { instructions } : {}),
    messages: rest,
    allowSystemInMessages: rest.some((m) => m.role === "system"),
  };
}

function toolSetOf(req: GenerateRequest): ToolSet | undefined {
  if (!req.tools?.length) return undefined;
  const tools: ToolSet = {};
  for (const t of req.tools) {
    // Legacy form edges read safeKeyName(label), as LangChain's formTool did.
    // Keep arbitrary ModelPort tool schemas untouched.
    const schema = t.inputSchema;
    const inputSchema =
      req.providerOptions?.langchain && t.name === "form"
        ? {
            ...schema,
            properties: Object.fromEntries(
              Object.entries(schema.properties ?? {}).map(([key, value]) => [
                safeKeyName(key),
                value,
              ]),
            ),
            ...(Array.isArray(schema.required)
              ? { required: [...new Set(schema.required.map(safeKeyName))] }
              : {}),
          }
        : schema;
    tools[t.name] = tool({
      ...(t.description ? { description: t.description } : {}),
      inputSchema: jsonSchema(inputSchema as never),
    });
  }
  return tools;
}

function toolChoiceOf(
  choice: GenerateRequest["toolChoice"],
): ToolChoice<ToolSet> | undefined {
  if (choice === undefined || typeof choice === "string") return choice;
  return { type: "tool", toolName: choice.toolName };
}

/**
 * The SDK's usage as ours. Counts pass through unsummed; an absent detail
 * stays absent. Usage needs both totals, so one the provider left out is 0;
 * no usage at all is undefined.
 */
export function toUsage(u: LanguageModelUsage | undefined): Usage | undefined {
  if (!u || (u.inputTokens === undefined && u.outputTokens === undefined)) {
    return undefined;
  }
  const usage: Usage = {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
  };
  const cacheRead = u.inputTokenDetails?.cacheReadTokens;
  const cacheWrite = u.inputTokenDetails?.cacheWriteTokens;
  const reasoning = u.outputTokenDetails?.reasoningTokens;
  if (cacheRead !== undefined) usage.cachedInputTokens = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  return usage;
}

/** The SDK's response messages as Messages. */
function fromModelMessages(messages: ModelMessage[]): Message[] {
  return messages.map((m): Message => {
    if (typeof m.content === "string") {
      return { role: m.role, content: m.content };
    }
    const parts: ContentPart[] = [];
    for (const part of m.content as Part[]) {
      switch (part.type) {
        case "text":
          parts.push({ type: "text", text: part.text });
          break;
        case "reasoning":
          parts.push({ type: "reasoning", text: part.text });
          break;
        case "tool-call": {
          const call: ToolCallPart = {
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          };
          if (part.providerOptions) call.providerOptions = part.providerOptions;
          parts.push(call);
          break;
        }
        case "tool-result": {
          const output = part.output;
          parts.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: "value" in output ? output.value : output,
            ...(output.type.startsWith("error") ? { isError: true } : {}),
          });
          break;
        }
      }
    }
    return { role: m.role, content: parts };
  });
}

function assistantMessage(
  reasoning: string,
  text: string,
  calls: ToolCallPart[],
): Message {
  const content: ContentPart[] = [];
  if (reasoning) content.push({ type: "reasoning", text: reasoning });
  if (text) content.push({ type: "text", text });
  content.push(...calls);
  return { role: "assistant", content };
}

function finishReasonOf(reason: FinishReason | undefined): string {
  return reason ?? "unknown";
}

export class AiSdkModelPort implements ModelPort {
  constructor(private readonly options: AiSdkModelPortOptions) {}

  private get fetch(): ModelFetch {
    return this.options.fetch ?? globalThis.fetch;
  }

  /**
   * The provider config and model id for a request, or null when no
   * configured provider serves it. Legacy requests name their provider in
   * providerOptions.langchain, whose baseURL and apiKey win.
   */
  private resolve(
    req: GenerateRequest,
  ): { config: AiSdkProviderConfig; modelId: string } | null {
    const { providers } = this.options;
    const legacy = req.providerOptions?.langchain as
      | GenericModelConfig
      | undefined;
    const separator = req.model.indexOf(":");
    const prefix = req.model.slice(0, separator);

    let config: AiSdkProviderConfig | undefined;
    if (legacy?.provider) {
      const id = LEGACY_PROVIDER_IDS[legacy.provider];
      config = id ? providers.find((p) => p.id === id) : undefined;
    } else {
      config = providers.find((p) => p.id === prefix);
      if (!config) {
        const byKind = providers.filter((p) => p.kind === prefix);
        if (byKind.length === 1) config = byKind[0];
      }
    }
    if (!config) return null;

    if (legacy) {
      // Legacy gemini and groq ignore baseURL; keep that.
      const keepsBaseURL =
        legacy.provider === "gemini" || legacy.provider === "groq";
      config = {
        ...config,
        ...(legacy.apiKey ? { apiKey: legacy.apiKey } : {}),
        ...(legacy.baseURL && !keepsBaseURL ? { baseURL: legacy.baseURL } : {}),
      };
    }
    const modelId =
      legacy?.model ||
      apiIdFor(req.model, config.kind) ||
      config.defaultModel ||
      "";
    return { config, modelId };
  }

  private noProvider(req: GenerateRequest): Error {
    return new Error(
      `No AI SDK provider for "${req.model}". Add one in settings or switch the model engine to LangChain.`,
    );
  }

  /** The options generateText and streamText share. */
  private async callOptions(req: GenerateRequest, model: LanguageModel) {
    const legacy = (req.providerOptions?.langchain ?? {}) as GenericModelConfig;
    const prompt = await toAiSdkPrompt(req, this.fetch);
    const tools = toolSetOf(req);
    const toolChoice = toolChoiceOf(req.toolChoice);
    const providerOptions = sdkProviderOptions(req.providerOptions);
    const num = (v: unknown) => (typeof v === "number" ? v : undefined);
    const settings = {
      temperature: req.temperature,
      maxOutputTokens: req.maxOutputTokens,
      topP: num(legacy.top_p),
      topK: num(legacy.top_k),
      frequencyPenalty: num(legacy.frequency_penalty),
      presencePenalty: num(legacy.presence_penalty),
      seed: num(legacy.seed),
      stopSequences: legacy.stop ? legacy.stop.split(",") : undefined,
    };
    return {
      model,
      ...prompt,
      ...(tools ? { tools } : {}),
      ...(toolChoice ? { toolChoice } : {}),
      ...(providerOptions ? { providerOptions } : {}),
      ...Object.fromEntries(
        Object.entries(settings).filter(([, v]) => v !== undefined),
      ),
      abortSignal: req.signal,
      stopWhen: isStepCount(this.options.maxSteps ?? 1),
    };
  }

  private modelFor(req: GenerateRequest): LanguageModel | null {
    const target = this.resolve(req);
    if (!target) return null;
    return createProviderModel(target.config, target.modelId, this.fetch);
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const model = this.modelFor(req);
    if (!model) {
      if (this.options.fallback) return this.options.fallback.generate(req);
      throw this.noProvider(req);
    }
    const result = await generateText(await this.callOptions(req, model));
    const usage = toUsage(result.usage);
    return {
      text: result.text,
      messages: fromModelMessages(result.responseMessages),
      ...(usage ? { usage } : {}),
      finishReason: finishReasonOf(result.finishReason),
    };
  }

  async *stream(req: GenerateRequest): AsyncGenerator<ModelStreamEvent> {
    const model = this.modelFor(req);
    if (!model) {
      if (this.options.fallback) {
        yield* this.options.fallback.stream(req);
        return;
      }
      throw this.noProvider(req);
    }
    const result = streamText({
      ...(await this.callOptions(req, model)),
      // Errors arrive as stream parts; don't also log them.
      onError: () => {},
    });
    let text = "";
    let reasoning = "";
    const calls: ToolCallPart[] = [];
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          text += part.text;
          yield { type: "text-delta", text: part.text };
          break;
        case "reasoning-delta":
          reasoning += part.text;
          yield { type: "reasoning-delta", text: part.text };
          break;
        case "tool-call": {
          const call: ToolCallPart = {
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          };
          calls.push(call);
          yield { type: "tool-call", call };
          break;
        }
        case "error":
          yield { type: "error", error: part.error };
          return;
        case "abort":
          yield {
            type: "error",
            error:
              req.signal.reason ?? new Error("The model call was stopped."),
          };
          return;
        case "finish": {
          const usage = toUsage(part.totalUsage);
          if (usage) yield { type: "usage", usage };
          yield {
            type: "finish",
            result: {
              text,
              messages: [assistantMessage(reasoning, text, calls)],
              ...(usage ? { usage } : {}),
              finishReason: finishReasonOf(part.finishReason),
            },
          };
          return;
        }
      }
    }
  }
}
