// Settings tab. Order: network disclosure, Providers, Network, Runs, then the Mehrpele host row.
// data.json holds only SecretStorage ids; key values go straight into app.secretStorage and the
// tab never reads one back (getSecret is called only by the runner, for the picked id).
import { type App, Modal, Notice, type Plugin, PluginSettingTab, SecretComponent, Setting, SettingGroup } from "obsidian";
import type { HostConnection } from "../host/connect";
import { cannoliDataExists, IMPORT_BANNER, IMPORT_DONE, type ImportApp, importCannoliKeys } from "./import-cannoli";
import { isValidSecretId, type SecretStorageLike, suggestSecretId } from "./secrets";
import { SHOW_HOST_URL, statusButtonLabel, statusText } from "./status";
import type { SettingsStore } from "./store";
import { DEFAULT_MODELS, type FlowsSettings, PROVIDER_LABELS, PROVIDERS, type ProviderId } from "./types";

export const DISCLOSURE =
  "Flows send the text of the nodes they run to the model provider you choose below. Mehrpele Flows contacts only that provider, localhost if you allow it, and hosts on your network allow list. Keys stay in Obsidian's secure storage; this plugin's data.json holds only their names.";

/** Providers whose base URL can be changed (the others use their fixed API host). */
const HAS_BASE_URL: ReadonlySet<ProviderId> = new Set(["openai", "anthropic", "azure_openai", "ollama", "openai_compatible"]);
const BASE_URL_HINT: Partial<Record<ProviderId, string>> = {
  openai: "Leave empty for api.openai.com.",
  anthropic: "Leave empty for api.anthropic.com.",
  azure_openai: "Your deployment URL, for example https://name.openai.azure.com/openai/deployments/name.",
  ollama: "Leave empty for http://localhost:11434.",
  openai_compatible: "Required, for example http://localhost:1234/v1.",
};

type SecretApp = App & { secretStorage?: SecretStorageLike };

class AddKeyModal extends Modal {
  constructor(
    app: App,
    private provider: ProviderId,
    private onSave: (id: string, value: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle(`Add a ${PROVIDER_LABELS[this.provider]} key`);
    let id = suggestSecretId(this.provider);
    let value = "";
    new Setting(contentEl)
      .setName("Name")
      .setDesc("Lowercase letters, digits and dashes. Other plugins see only this name.")
      .addText((t) => t.setValue(id).onChange((v) => (id = v.trim())));
    new Setting(contentEl).setName("Key").addText((t) => {
      t.inputEl.type = "password";
      t.inputEl.autocomplete = "off";
      t.onChange((v) => (value = v.trim()));
    });
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Save")
        .setCta()
        .onClick(() => {
          if (!isValidSecretId(id)) return new Notice("Use lowercase letters, digits and dashes for the name.");
          if (!value) return new Notice("Paste the key first.");
          this.onSave(id, value);
          this.close();
        }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class MehrpeleFlowsSettingTab extends PluginSettingTab {
  private unsubscribe: (() => void) | null = null;
  private cannoliDetected = false;
  private generation = 0;

  constructor(
    app: App,
    plugin: Plugin,
    private connection: HostConnection,
    private store: SettingsStore,
  ) {
    super(app, plugin);
  }

  display(): void {
    // The host may have been enabled since the last check without firing an event.
    this.connection.refresh();
    this.unsubscribe?.();
    this.unsubscribe = this.connection.onChange(() => this.render());
    const gen = ++this.generation;
    this.containerEl.empty();
    // Settings and Cannoli's file are looked at only now, when the tab opens.
    void Promise.all([this.store.get(), cannoliDataExists(this.app as unknown as ImportApp)]).then(([, detected]) => {
      if (gen !== this.generation) return;
      this.cannoliDetected = detected;
      this.render();
    });
  }

  hide(): void {
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.containerEl.empty();
  }

  private get secretStorage(): SecretStorageLike | undefined {
    return (this.app as SecretApp).secretStorage;
  }

  private save(change: (s: FlowsSettings) => void, rerender = false): void {
    void this.store.update(change).then(() => rerender && this.render());
  }

  private render(): void {
    const settings = this.store.current;
    if (!settings) return;
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("mehrpele-flows-settings");

    containerEl.createEl("p", { cls: "mehrpele-flows-disclosure", text: DISCLOSURE });

    if (this.cannoliDetected) {
      const banner = containerEl.createDiv({ cls: "mehrpele-flows-import-banner" });
      banner.createSpan({ text: IMPORT_BANNER });
      banner.createEl("button", { text: "Import keys" }).addEventListener("click", () => void this.importKeys());
    }

    this.renderProviders(settings);
    this.renderNetwork(settings);
    this.renderRuns(settings);
    this.renderHost();
  }

  private async importKeys(): Promise<void> {
    try {
      const settings = await this.store.get();
      const result = await importCannoliKeys(this.app, settings);
      await this.store.update(() => undefined);
      new Notice(result.imported.length || result.baseUrls.length ? IMPORT_DONE : "Cannoli has no provider keys to import.");
    } catch (e) {
      new Notice(`Could not import from Cannoli: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.render();
  }

  private renderProviders(settings: FlowsSettings): void {
    const group = new SettingGroup(this.containerEl).setHeading("Providers").addClass("mehrpele-flows-providers");
    group.addSetting((s) =>
      { s
        .setName("Default provider")
        .setDesc("Flows use this provider unless they name another one.")
        .addDropdown((d) => {
          d.addOption("", "None");
          for (const p of PROVIDERS) d.addOption(p, PROVIDER_LABELS[p]);
          d.setValue(settings.defaultProvider ?? "").onChange((v) =>
            this.save((st) => {
              st.defaultProvider = (v || null) as ProviderId | null;
              if (v === "ollama") st.providers.ollama ??= {};
            }),
          );
        }); },
    );
    group.addSetting((s) =>
      { s
        .setName("Import keys from Cannoli")
        .setDesc("Copies the Cannoli plugin's provider keys into secure storage. Cannoli's own file is not changed.")
        .addButton((b) => b.setButtonText("Import").onClick(() => void this.importKeys())); },
    );

    for (const p of PROVIDERS) {
      const entry = settings.providers[p] ?? {};
      const pg = new SettingGroup(this.containerEl).setHeading(PROVIDER_LABELS[p]).addClass("mehrpele-flows-provider", `mehrpele-flows-provider-${p}`);
      if (p !== "ollama") {
        pg.addSetting((s) => {
          s.setName("API key").setDesc(
            p === "openai_compatible" ? "Optional. Pick a key from secure storage." : "Pick a key from secure storage, or add one.",
          );
          const storage = this.secretStorage;
          if (!storage) {
            s.setDesc("Secure storage needs Obsidian 1.11.4 or later.");
            return;
          }
          s.addComponent((el) =>
            new SecretComponent(this.app, el).setValue(entry.secretId ?? "").onChange((v) =>
              this.save((st) => {
                st.providers[p] = { ...st.providers[p], secretId: v || undefined };
              }),
            ),
          );
          s.addExtraButton((b) =>
            b
              .setIcon("plus")
              .setTooltip("Add key")
              .onClick(() =>
                new AddKeyModal(this.app, p, (id, value) => {
                  storage.setSecret(id, value);
                  this.save((st) => {
                    st.providers[p] = { ...st.providers[p], secretId: id };
                  }, true);
                }).open(),
              ),
          );
        });
      }
      if (HAS_BASE_URL.has(p)) {
        pg.addSetting((s) =>
          { s
            .setName("Base URL")
            .setDesc(BASE_URL_HINT[p] ?? "")
            .addText((t) =>
              t.setValue(entry.baseUrl ?? "").onChange((v) =>
                this.save((st) => {
                  st.providers[p] = { ...st.providers[p], baseUrl: v.trim() || undefined };
                }),
              ),
            ); },
        );
      }
      pg.addSetting((s) =>
        { s.setName("Model").addText((t) =>
          t
            .setPlaceholder(DEFAULT_MODELS[p])
            .setValue(entry.model ?? "")
            .onChange((v) =>
              this.save((st) => {
                st.providers[p] = { ...st.providers[p], model: v.trim() || undefined };
              }),
            ),
        ); },
      );
    }
  }

  private renderNetwork(settings: FlowsSettings): void {
    const group = new SettingGroup(this.containerEl).setHeading("Network").addClass("mehrpele-flows-network");
    group.addSetting((s) =>
      { s
        .setName("Allowed hosts")
        .setDesc("Hosts HTTP nodes may reach, one per line. * matches any part of a name, as in *.example.org.")
        .addTextArea((t) =>
          t.setValue(settings.network.allow.join("\n")).onChange((v) =>
            this.save((st) => {
              st.network.allow = v.split("\n").map((x) => x.trim()).filter(Boolean);
            }),
          ),
        ); },
    );
    group.addSetting((s) =>
      { s
        .setName("Ask before the first request to each host")
        .addToggle((t) => t.setValue(settings.network.askFirstHost).onChange((v) => this.save((st) => void (st.network.askFirstHost = v)))); },
    );
    group.addSetting((s) =>
      { s
        .setName("Allow localhost")
        .setDesc("Lets flows reach servers on this computer, such as Ollama.")
        .addToggle((t) => t.setValue(settings.network.allowLocalhost).onChange((v) => this.save((st) => void (st.network.allowLocalhost = v)))); },
    );
    group.addSetting((s) => {
      const approved = settings.network.approvedHosts;
      s.setName("Approved hosts").setDesc(approved.length ? approved.join(", ") : "None yet.");
      if (approved.length) {
        s.addButton((b) => b.setButtonText("Forget all").onClick(() => this.save((st) => void (st.network.approvedHosts = []), true)));
      }
    });
  }

  private renderRuns(settings: FlowsSettings): void {
    const group = new SettingGroup(this.containerEl).setHeading("Runs").addClass("mehrpele-flows-runs");
    group.addSetting((s) =>
      { s
        .setName("Run records to keep")
        .setDesc("Records are saved in .mehrpele-cannoli/runs in this vault, with keys removed.")
        .addText((t) => {
          t.inputEl.type = "number";
          t.inputEl.min = "1";
          t.setValue(String(settings.runs.keep)).onChange((v) => {
            const n = Number(v);
            if (Number.isFinite(n) && n >= 1) this.save((st) => void (st.runs.keep = Math.floor(n)));
          });
        }); },
    );
  }

  private renderHost(): void {
    const status = this.connection.status;
    const setting = new Setting(this.containerEl).setName("Mehrpele").setDesc(statusText(status, this.connection.hostVersion));
    setting.settingEl.addClass("mehrpele-flows-host-status", `mehrpele-flows-host-${status}`);
    const label = statusButtonLabel(status);
    if (label) {
      setting.addButton((button) =>
        button.setButtonText(label).onClick(() => {
          window.open(SHOW_HOST_URL);
        }),
      );
    }
  }
}
