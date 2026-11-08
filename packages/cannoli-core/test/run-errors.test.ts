import { describe, expect, it } from "vitest";
import { fakeVault, runCanvas } from "./helpers/run";

const box = { x: 0, y: 0, width: 200, height: 100 };

// A file node feeding an output node, as Obsidian saves it: no `text`.
const fileNodeCanvas = (fileNode: Record<string, unknown>) => ({
  nodes: [
    { id: "note", type: "file", ...box, ...fileNode },
    { id: "out", type: "text", text: "", color: "6", ...box, x: 400 },
  ],
  edges: [
    {
      id: "e1",
      fromNode: "note",
      fromSide: "right",
      toNode: "out",
      toSide: "left",
    },
  ],
});

const plainFileNode = fileNodeCanvas({ file: "Folder/Some Note.md" });

describe("an error while a node executes ends the run", () => {
  it("stops with reason error and the message instead of hanging", async () => {
    const vault = fakeVault(async () => {
      throw new Error("vault offline");
    });
    const { finished, stoppages } = await runCanvas(plainFileNode, {
      vault,
      isMock: false,
    });

    expect(finished).toBe(true);
    expect(stoppages).toHaveLength(1);
    expect(stoppages[0].reason).toBe("error");
    expect(stoppages[0].message).toContain("vault offline");
  });

  it("stops with a clear error when a reference node has no reference", async () => {
    const canvas = fileNodeCanvas({ file: "" });
    const { finished, stoppages } = await runCanvas(canvas);

    expect(finished).toBe(true);
    expect(stoppages).toHaveLength(1);
    expect(stoppages[0].reason).toBe("error");
    expect(stoppages[0].message).toContain("Could not find reference");
  });

  it("a user stop still wins, and a later node error adds no second stoppage", async () => {
    let fail: (e: Error) => void = () => {};
    const vault = fakeVault(
      () => new Promise<string>((_resolve, reject) => (fail = reject)),
    );
    const { finished, stoppages } = await runCanvas(plainFileNode, {
      vault,
      isMock: false,
      afterStart: async (run) => {
        run.stop();
        fail(new Error("vault offline"));
      },
    });

    expect(finished).toBe(true);
    expect(stoppages.map((s) => s.reason)).toEqual(["user"]);
  });
});
