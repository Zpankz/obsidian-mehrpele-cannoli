# Mehrpele Flows

Run Cannoli-format flows from Mehrpele diagrams or standalone canvases in Obsidian. This is an unofficial companion, not affiliated with Obsidian or Cannoli.

## Install

### BRAT (recommended)

1. Install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat) in Obsidian.
2. Open BRAT settings → Add beta plugin and enter `Zpankz/obsidian-mehrpele-cannoli` (not the private monorepo).
3. Choose the latest release, install it, and enable **Mehrpele Flows** under Settings → Community plugins.
4. Keep [Mehrpele](https://github.com/Zpankz/obsidian-mehrpele) enabled to run flows inside diagrams; configure provider keys and network permissions in Mehrpele Flows settings.

### Manual installation

Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/Zpankz/obsidian-mehrpele-cannoli/releases/latest). Copy all three into `<vault configuration folder>/plugins/mehrpele-cannoli` (the configuration folder is normally `.obsidian`), restart Obsidian, and enable Mehrpele Flows under Community plugins. Do not replace the Mehrpele host plugin's files.

For manual updates, stop active flows and disable Mehrpele Flows before replacing its three files, then enable it again. BRAT can manage future updates automatically.

To build from source, run `bun install --frozen-lockfile` and `bun run check`, then use the three files produced at the repository root.

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
