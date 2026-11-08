// Settings load lazily on first need (a command, the file menu, the settings tab or runCanvas),
                                           
import { type FlowsSettings, normalizeSettings } from "./types";

export interface SettingsHost {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export class SettingsStore {
  private value: FlowsSettings | null = null;
  private loading: Promise<FlowsSettings> | null = null;

  constructor(private host: SettingsHost) {}

  /** The loaded settings, or null before the first get(). */
  get current(): FlowsSettings | null {
    return this.value;
  }

  get(): Promise<FlowsSettings> {
    if (this.value) return Promise.resolve(this.value);
    this.loading ??= this.host.loadData().then((raw) => {
      this.value = normalizeSettings(raw);
      return this.value;
    });
    return this.loading;
  }

  /** Applies `change` to the loaded settings and saves them. */
  async update(change: (s: FlowsSettings) => void): Promise<FlowsSettings> {
    const s = await this.get();
    change(s);
    // Re-normalise so nothing outside the schema (an apiKey, say) can reach data.json.
    this.value = normalizeSettings(JSON.parse(JSON.stringify(s)));
    await this.host.saveData(this.value);
    return this.value;
  }
}
