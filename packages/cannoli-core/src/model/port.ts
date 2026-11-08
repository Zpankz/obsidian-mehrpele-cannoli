import type {
  GenerateRequest,
  GenerateResult,
  Message,
  ModelStreamEvent,
} from "./types";

/** The one way the engine calls a model (DESIGN §4.2). */
export interface ModelPort {
  generate(req: GenerateRequest): Promise<GenerateResult>;
  stream(req: GenerateRequest): AsyncIterable<ModelStreamEvent>;
}

/**
 * A port that can also run the legacy goal node's MCP agent. Only the
 * LangChain port can; the agent runtime replaces this in P3.6.
 */
export interface GoalAgentPort extends ModelPort {
  goal(
    req: GenerateRequest,
    opts?: { onReasoningMessagesUpdated?: (messages: Message[]) => void },
  ): Promise<GenerateResult>;
}

export function canRunGoalAgent(port: ModelPort): port is GoalAgentPort {
  return typeof (port as Partial<GoalAgentPort>).goal === "function";
}
