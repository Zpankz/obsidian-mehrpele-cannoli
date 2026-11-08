                                                                                              
// the LangSmith API client (smith.langchain.com). Tracing is forced off (tracing-off.ts), and
// even if a tracer were created, this client sends nothing.
export class Client {
  constructor(_config?: unknown) {}
  async createRun(_run?: unknown): Promise<void> {}
  async updateRun(_runId?: string, _run?: unknown): Promise<void> {}
  async batchIngestRuns(_batch?: unknown): Promise<void> {}
  async multipartIngestRuns(_batch?: unknown): Promise<void> {}
  async awaitPendingTraceBatches(): Promise<void> {}
  async flush(): Promise<void> {}
  getHostUrl(): string {
    return "";
  }
}
