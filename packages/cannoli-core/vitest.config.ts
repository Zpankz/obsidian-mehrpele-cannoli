import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // src/ imports some modules as "src/..." via tsconfig baseUrl ".".
    alias: [
      {
        find: /^src\//,
        replacement: fileURLToPath(new URL("./src/", import.meta.url)),
      },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
