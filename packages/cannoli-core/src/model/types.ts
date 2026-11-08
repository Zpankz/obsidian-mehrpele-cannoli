// The Message model (DESIGN §4.2). Every model call goes through ModelPort
// with these types; model/legacy.ts converts to and from the older
// GenericCompletionResponse shape the graph still uses.

export type ProviderId =
  | "anthropic"
  | "openai"
  | "google"
  | "openrouter"
  | "ollama"
  | "openai-compatible";

/** "provider:model", e.g. "anthropic:claude-sonnet-5-5". */
export type ModelRef = `${ProviderId}:${string}`;

/** A JSON Schema object (draft 7). */
export type JSONSchema7 = Record<string, unknown>;

/**
 * Options for one provider, keyed by provider name (as in the AI SDK).
 * `langchain` holds what the LangChain path needs that the Message model
 * has no field for.
 */
export type ProviderOptions = Record<string, unknown>;

export type ContentPart =
  | { type: "text"; text: string; cache?: boolean }
  | { type: "image"; data: string | URL; mediaType: string }
  | { type: "file"; data: string; mediaType: string; filename?: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
      providerOptions?: ProviderOptions;
    }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError?: boolean;
    };

export type ToolCallPart = Extract<ContentPart, { type: "tool-call" }>;

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  providerOptions?: ProviderOptions;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  /** Input tokens written to the provider's prompt cache. */
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number | null;
}

export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema: JSONSchema7;
}

export interface GenerateRequest {
  model: ModelRef;
  /** The system prompt. */
  instructions?: string;
  messages: Message[];
  tools?: ToolSpec[];
  toolChoice?: "auto" | "none" | "required" | { toolName: string };
  /** Structured output. */
  output?: { name?: string; schema: JSONSchema7 };
  temperature?: number;
  maxOutputTokens?: number;
  effort?: "low" | "medium" | "high" | "max";
  /** Prompt caching. */
  cache?: "auto" | "off";
  providerOptions?: ProviderOptions;
  signal: AbortSignal;
}

export interface GenerateResult {
  text: string;
  object?: unknown;
  /** The messages the call added: the assistant's reply. */
  messages: Message[];
  /** What the provider reported; absent when it reported nothing. */
  usage?: Usage;
  finishReason: string;
  ttftMs?: number;
}

export type ModelStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; call: ToolCallPart }
  /** The usage so far, as a running total, so a stopped stream still counts. */
  | { type: "usage"; usage: Usage }
  | { type: "finish"; result: GenerateResult }
  | { type: "error"; error: unknown };
