// Base64 without Node's Buffer, so core runs in browsers and on Obsidian mobile
// (DESIGN §13.3). btoa is available in browsers, workers and Node >= 16.

// btoa takes a "binary string" (one char per byte). Build it in chunks:
// String.fromCharCode(...bytes) on a large array overflows the call stack.
const CHUNK = 0x8000;

/** Standard base64 (with padding) of the bytes, same as Buffer#toString("base64"). */
export function arrayBufferToBase64(
  data: ArrayBuffer | ArrayBufferView,
): string {
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
