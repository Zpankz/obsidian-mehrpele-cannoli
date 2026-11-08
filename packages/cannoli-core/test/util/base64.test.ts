import { describe, expect, it } from "vitest";
import { arrayBufferToBase64 } from "../../src/util/base64";

// Bytes covering every value, plus lengths that exercise each padding case.
function bytes(length: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length }, (_, i) => (i * 37 + 11) % 256);
}

describe("arrayBufferToBase64", () => {
  it("encodes ArrayBuffer identically to Buffer", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 255, 256, 257, 70_000]) {
      const view = bytes(length);
      const expected = Buffer.from(view).toString("base64");
      expect(arrayBufferToBase64(view.buffer), `length ${length}`).toBe(
        expected,
      );
    }
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(arrayBufferToBase64(all.buffer)).toBe(
      Buffer.from(all).toString("base64"),
    );
  });

  it("encodes only the viewed bytes of a typed array", () => {
    const backing = bytes(16);
    const view = backing.subarray(3, 11);
    expect(arrayBufferToBase64(view)).toBe(
      Buffer.from(view).toString("base64"),
    );
  });
});
