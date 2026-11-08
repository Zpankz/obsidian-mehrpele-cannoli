// The five golden flows (cannoli-core test/fixtures/college), shared by the canvas goldens, the
// Mermaid goldens and the .mmd generator.
export const GOLDEN: Record<string, string> = {
  linear: "1. Basics/1. Hello world.canvas",
  choice: "2. Special arrows/4. Choice arrows.canvas",
  "for-each": "5. Groups/4. Parallel groups.canvas",
  field: "2. Special arrows/3. Field arrows.canvas",
  "note-reference": "4. Vault interaction/1. Referencing notes.canvas",
};

/** Notes the flows reference, present in the fake vault as `# <name>\nMock note body.`. */
export const NOTES = ["Lemons for Cleaning", "Meeting Notes", "Cannoli College/Example notes/Apple Trees"];
