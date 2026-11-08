// Test-only client seam: upstream goal tests install a mocked fetch for their
// reserved .test server. Production keeps the refusing RPC package and aliases.
import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";
import upstream from "../vitest.config";

export default mergeConfig(upstream, {
  resolve: { alias: [{ find: "@deablabs/cannoli-server/rpc", replacement: fileURLToPath(new URL("./test-server-rpc.ts", import.meta.url)) }] },
});
