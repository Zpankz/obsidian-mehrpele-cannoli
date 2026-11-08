// Prompts: the first-run confirmation, the first request to an allowed host and replacing a
// running flow. Each resolves true only on an explicit "yes"; closing the modal means no.
import { type App, Modal, Setting } from "obsidian";
import { type ConfirmSection, confirmFootnote } from "../run/confirm";

interface AskOptions {
  title: string;
  intro: string;
  sections?: ConfirmSection[];
  /** A line under the sections. */
  footnote?: string;
  yes: string;
  no?: string;
  warning?: boolean;
}

class AskModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private opts: AskOptions,
    private resolve: (ok: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, opts } = this;
    this.setTitle(opts.title);
    contentEl.addClass("mehrpele-flows-ask");
    contentEl.createEl("p", { text: opts.intro });
    for (const section of opts.sections ?? []) {
      const block = contentEl.createDiv({ cls: "mehrpele-flows-ask-section" });
      block.createEl("h4", { text: section.title });
      const list = block.createEl("ul");
      for (const item of section.items) list.createEl("li", { text: item });
    }
    if (opts.footnote) contentEl.createEl("p", { text: opts.footnote });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText(opts.no ?? "Cancel").onClick(() => this.answer(false)))
      .addButton((b) => {
        b.setButtonText(opts.yes).onClick(() => this.answer(true));
        if (opts.warning) b.setWarning();
        else b.setCta();
      });
  }

  private answer(ok: boolean): void {
    this.answered = true;
    this.resolve(ok);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.answered) this.resolve(false);
  }
}

function ask(app: App, opts: AskOptions): Promise<boolean> {
  return new Promise((resolve) => new AskModal(app, opts, resolve).open());
}

export function confirmFlow(app: App, flowPath: string, sections: ConfirmSection[]): Promise<boolean> {
  return ask(app, {
    title: "Run this flow?",
    intro: `First run of ${flowPath} (or it changed since you confirmed it). It will use:`,
    sections,
    footnote: confirmFootnote(sections) ?? undefined,
    yes: "Run",
  });
}

export function askHost(app: App, host: string): Promise<boolean> {
  return ask(app, {
    title: "Allow this host?",
    intro: `A flow wants to send a request to ${host}. It matches your network allow list. Allow it from now on?`,
    yes: "Allow",
    no: "Block",
  });
}

export function confirmReplace(app: App, flowPath: string): Promise<boolean> {
  return ask(app, {
    title: "Flow already running",
    intro: `${flowPath} is already running. Stop it and start again?`,
    yes: "Stop and restart",
    warning: true,
  });
}

class ArgsModal extends Modal {
  private result: string | null = null;

  constructor(
    app: App,
    private initial: string,
    private resolve: (text: string | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle("Run with args");
    contentEl.addClass("mehrpele-flows-ask");
    contentEl.createEl("p", { text: "One name=value per line. These replace the flow's config args for this run." });
    const area = contentEl.createEl("textarea", { cls: "mehrpele-flows-args" });
    area.value = this.initial;
    area.rows = 6;
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Run")
          .setCta()
          .onClick(() => {
            this.result = area.value;
            this.close();
          }),
      );
    area.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolve(this.result);
  }
}

/** The "Run with args…" prompt: resolves the edited `name=value` text, or null when cancelled. */
export function askArgs(app: App, initial: string): Promise<string | null> {
  return new Promise((resolve) => new ArgsModal(app, initial, resolve).open());
}
