import type { ModelUsage } from "../run";

/** Token counts one model call reported (DESIGN §4.2 Usage, tokens only). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Options every provider call takes. */
export interface CallOptions {
  signal?: AbortSignal;
  /**
   * Called with the usage the provider reported, if it reported any. A stream
   * may call it more than once with a running total; the latest one counts.
   */
  onUsage?: (usage: TokenUsage) => void;
}

/** LangChain's usage_metadata on an AIMessage or the last AIMessageChunk. */
interface UsageMetadataLike {
  input_tokens?: number;
  output_tokens?: number;
}

/** Read LangChain usage_metadata, or undefined when the provider sent none. */
export function usageFromMetadata(
  metadata: UsageMetadataLike | undefined | null,
): TokenUsage | undefined {
  if (!metadata) return undefined;
  const { input_tokens, output_tokens } = metadata;
  if (typeof input_tokens !== "number" && typeof output_tokens !== "number") {
    return undefined;
  }
  return { inputTokens: input_tokens ?? 0, outputTokens: output_tokens ?? 0 };
}

/** Count one call to model, adding its tokens when they were reported. */
export function recordCall(
  usage: Record<string, ModelUsage>,
  model: string | undefined,
  tokens?: TokenUsage,
): void {
  if (!model) return;
  const prev = usage[model];
  const next: ModelUsage = { numberOfCalls: (prev?.numberOfCalls ?? 0) + 1 };
  if (prev?.promptTokens !== undefined || tokens) {
    next.promptTokens = (prev?.promptTokens ?? 0) + (tokens?.inputTokens ?? 0);
  }
  if (prev?.completionTokens !== undefined || tokens) {
    next.completionTokens =
      (prev?.completionTokens ?? 0) + (tokens?.outputTokens ?? 0);
  }
  usage[model] = next;
}
