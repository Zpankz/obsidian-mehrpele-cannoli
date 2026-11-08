import type { HostStatus } from "../host/connect";

export const SHOW_HOST_URL = "obsidian://show-plugin?id=mehrpele";

/** What the settings tab shows for each host status (README: Host connection). */
const STATUS_VIEW: Record<HostStatus, { text: string; button: string | null }> = {
  attached: { text: "Connected to Mehrpele", button: null },
  "too-old": { text: "Update Mehrpele to run flows from diagrams", button: "Update" },
  missing: { text: "Install Mehrpele to run flows from diagrams", button: "Install" },
};

/** The settings-tab line for `status`; an attached host adds its version. */
export function statusText(status: HostStatus, hostVersion: string | null): string {
  const { text } = STATUS_VIEW[status];
  return status === "attached" && hostVersion ? `${text} ${hostVersion}` : text;
}

/** The label of the button that opens Mehrpele in the plugin browser, or null for none. */
export function statusButtonLabel(status: HostStatus): string | null {
  return STATUS_VIEW[status].button;
}
