import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
export default defineConfig([
  globalIgnores(["node_modules", "packages/cannoli-core", "**/test", "scripts", "**/esbuild.config.*", "**/main.js", "eslint.config.mjs"]),
  ...obsidianmd.configs.recommended,
  { files: ["packages/mehrpele-cannoli/src/**/*.ts", "packages/mehrpele-api/src/**/*.ts"], languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
]);
