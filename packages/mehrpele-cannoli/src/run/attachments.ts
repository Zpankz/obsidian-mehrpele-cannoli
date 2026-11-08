                                                                                                 
// make an unresolved name an attachment: "Meeting 2026.11" or "v1.2" is a note, "x.pdf" is not.
// Shared by normaliseForEngine and the VaultFileManager so both draw the line in one place.

export const ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  "pdf",
  // images
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "svg",
  "webp",
  "avif",
  // audio
  "mp3",
  "wav",
  "m4a",
  "ogg",
  "3gp",
  "flac",
  "webm",
  // video
  "mp4",
  "ogv",
  "mov",
  "mkv",
  // Obsidian's own non-markdown files
  "canvas",
  "base",
]);

/** True when a name or path (no subpath) ends in a known attachment extension, in any case. */
export function isAttachment(name: string): boolean {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 && ATTACHMENT_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}
