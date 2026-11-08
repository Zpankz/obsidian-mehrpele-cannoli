// Seeded randomness for mock runs, so a mock run of the same canvas makes the
// same choices every time (DESIGN §14: run-engine tests use a seeded RNG).

/** A function returning floats in [0, 1), like Math.random. */
export type Rng = () => number;

/** mulberry32: a small, fast 32-bit PRNG. Not for cryptography. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit FNV-1a hash of a string's UTF-16 code units. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The default seed for a run: a hash of the canvas JSON as given. */
export function seedFromCanvas(canvas: unknown): number {
  return hashString(JSON.stringify(canvas) ?? "");
}

/** A uniformly chosen element, or undefined for an empty array. */
export function pick<T>(
  rng: Rng,
  items: readonly T[] | undefined,
): T | undefined {
  if (!items || items.length === 0) return undefined;
  return items[Math.floor(rng() * items.length)];
}
