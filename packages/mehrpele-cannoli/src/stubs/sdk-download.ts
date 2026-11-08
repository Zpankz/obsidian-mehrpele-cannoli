// The companion is a browser/mobile host even when Electron exposes process.
// SDK downloads must use host egress; DNS/socket helpers are unavailable here.
import { fetch as hostFetch } from "../run/fetch-shim";
export const isNodeRuntime = () => false;
export async function getDefaultDownloadFetch() { return hostFetch; }
export function createSafeLookup(): never { throw new Error("Node DNS is unavailable in Mehrpele Flows"); }
