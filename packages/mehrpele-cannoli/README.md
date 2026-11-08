# Mehrpele Flows

Run Cannoli-format flows from Mehrpele diagrams or standalone canvases in Obsidian. This is an unofficial companion, not affiliated with Obsidian or Cannoli.

## Install

This source tree is a development build. Build with `bun install --frozen-lockfile` and `bun run check`. Copy `main.js`, `manifest.json` and `styles.css` from the repository root into your vault's `.obsidian/plugins/mehrpele-cannoli` folder, reload Obsidian, and enable Mehrpele Flows under Community plugins. No public release or BRAT installation is implied by this source tree.

## Development

`bun run check` verifies provenance, types, lint, tests, licensing and the browser bundle. Canonical engine tests and host-independent companion tests are included. `export-tests.json` classifies the host-renderer integration tests that remain required in the development monorepo. They are not replaced by a canned renderer here.

## Network use

Starting a non-mock flow sends its prompts, flow data and referenced note content to the selected model provider. Built-in provider endpoints are OpenAI, Anthropic, Google Gemini and Groq; Azure, Ollama and OpenAI-compatible providers use the URL you configure. HTTP nodes may contact their declared and approved hosts. Network settings control allowed hosts, first-host approval and localhost access. Requests use Obsidian's requestUrl transport. Keys stay in secure storage; configuration holds only selected key identifiers. Mock runs send no model requests and do not write output notes.

There is no telemetry, tracing export, cannoli-server connection or hosted action execution. Canonical engine source contains those upstream features, but browser build adapters exclude or refuse them. Install/update links can open GitHub. Manually downloading a release, or using Obsidian/BRAT for updates, contacts GitHub; this companion does not download itself or run a background updater.

## Companion plugins

Install Mehrpele to run flows from Mermaid diagrams. Standalone canvas runs can run without the host plugin. Configure providers and network permissions in Mehrpele Flows settings.

## Third-party code

Engine by Nicholas Golden and the Cannoli contributors. Canonical source comes from https://github.com/DeabLabs/cannoli and the modernized fork https://github.com/Zpankz/cannoli. Its exact revision and hashes are in `packages/cannoli-core/UPSTREAM.json`. `NOTICE.md` records provenance, and `THIRD-PARTY-NOTICES.md` contains licenses for code in the production bundle. Legacy provider clients installed for canonical types/tests are not bundled into the browser plugin.

## License

MIT for the companion and host API. Canonical core licensing is preserved verbatim in its package. Production dependency license texts and notices are retained in the third-party notice inventory.
