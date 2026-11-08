// The run view (mehrpele-flows-run): node rows with their status, a stop button and the elapsed
// time of the most recent run. Obsidian constructs it only when the leaf is shown; it renders
// from the RunFeed and the run's RunViewPersistor, and never writes the canvas.
import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { RunViewPersistor } from "../run/persistor";
import { type FeedState, formatElapsed, type RunFeed } from "./feed";

export const RUN_VIEW_TYPE = "mehrpele-flows-run";

const STATUS_TEXT: Record<FeedState["status"], string> = {
  running: "Running",
  complete: "Finished",
  error: "Failed",
  stopped: "Stopped",
  refused: "Not run",
};

export class RunView extends ItemView {
  private offFeed: (() => void) | null = null;
  private offRows: (() => void) | null = null;
  private watched: RunViewPersistor | null = null;
  private timer: number | null = null;
  private elapsedEl: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private feed: RunFeed,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return RUN_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Flow run";
  }

  getIcon(): string {
    return "workflow";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("mehrpele-flows-run-view");
    this.offFeed = this.feed.onChange(() => this.render());
    this.render();
  }

  async onClose(): Promise<void> {
    this.offFeed?.();
    this.offFeed = null;
    this.watch(null);
    this.stopTimer();
    this.contentEl.empty();
  }

  private watch(persistor: RunViewPersistor | null): void {
    if (persistor === this.watched) return;
    this.offRows?.();
    this.offRows = null;
    this.watched = persistor;
    if (persistor) this.offRows = persistor.onChange(() => this.renderRows());
  }

  private stopTimer(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    const state = this.feed.state;
    if (!state) {
      el.removeAttribute("data-run-status");
      el.createEl("p", { cls: "mpc-empty", text: "No flow has run yet. Open a canvas and use “Run current canvas”." });
      this.watch(null);
      this.stopTimer();
      return;
    }
    el.setAttr("data-run-status", state.status);
    const header = el.createDiv({ cls: "mpc-header" });
    header.createDiv({ cls: "mpc-flow", text: state.flowPath });
    const line = header.createDiv({ cls: "mpc-status-line" });
    line.createSpan({ cls: "mpc-run-status", text: STATUS_TEXT[state.status] + (state.active?.isMock ? " (mock)" : "") });
    this.elapsedEl = line.createSpan({ cls: "mpc-elapsed" });
    if (state.status === "running" && state.active) {
      const handle = state.active.handle;
      header.createEl("button", { cls: "mpc-stop mod-warning", text: "Stop" }).addEventListener("click", () => handle.stop());
    }
    if (state.reason) header.createDiv({ cls: "mpc-reason", text: state.reason });
    el.createDiv({ cls: "mpc-nodes" });
    this.watch(state.active?.persistor ?? null);
    this.renderRows();
    this.tick();
    this.stopTimer();
    if (state.status === "running") this.timer = window.setInterval(() => this.tick(), 200);
  }

  private tick(): void {
    const state = this.feed.state;
    if (!state || !this.elapsedEl) return;
    this.elapsedEl.setText(formatElapsed((state.endedAt ?? Date.now()) - state.startedAt));
  }

  private renderRows(): void {
    const list = this.contentEl.querySelector<HTMLElement>(".mpc-nodes");
    if (!list) return;
    list.empty();
    for (const row of this.watched?.list() ?? []) {
      const item = list.createDiv({ cls: `mpc-node mpc-s-${row.status}` });
      item.setAttr("data-node-id", row.id);
      item.createSpan({ cls: "mpc-node-status", text: row.status });
      item.createSpan({ cls: "mpc-node-label", text: row.label });
      if (row.message) item.createDiv({ cls: "mpc-node-message", text: row.message });
    }
  }
}
