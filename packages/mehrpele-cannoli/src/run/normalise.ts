                                                                                                
// reference for non-markdown files ("Could not find reference"), so before the probe and the real
// run, and only there, file nodes it cannot handle become content text nodes:
//   - a markdown (or extensionless) file with a subpath -> "{{[[Note#Heading]]}}", a whole-text
//     reference whose "#Heading" the VaultFileManager splits off;
//   - a non-markdown file (a known attachment extension) -> its link text "[[x.pdf#page=3]]" (a
//     bare link is not a reference); a dotted name like "v1.2" is still a note;
//   - a dotted note name without a subpath ("Daily 2026.11.05") gets ".md", which the core needs;
//   - a subcannoli (.canvas file, colour "2") stays a file node;
//   - an uncoloured text node that is only a pele view embed "![[view:…]]" -> its link text
//     "[[view:…]]", so the view is content and never a model call.
// Converted nodes get colour "6": a text node's colour picks its kind in the core (uncoloured is a
// call node, "2" Http, "5" Search), while a file node is always content.
// "Copy as Cannoli canvas" and "Save as .canvas" keep the faithful file nodes.
import { isAttachment } from "./attachments";

const MARKDOWN = /\.md$/i;
const VIEW_EMBED = /^!(\[\[view:[^\]]*\]\])$/i;

type NodeLike = Record<string, unknown> & { type?: unknown; file?: unknown; subpath?: unknown; color?: unknown; text?: unknown };

function normaliseNode(node: NodeLike): NodeLike {
  if (node.type === "text" && typeof node.text === "string" && !node.color) {
    const view = node.text.trim().match(VIEW_EMBED);
    return view ? { ...node, text: view[1], color: "6" } : node;
  }
  // A red (colour "1") node is ignored by the core; converting it would make it run.
  if (node.type !== "file" || typeof node.file !== "string" || node.color === "1") return node;
  const file = node.file;
  const subpath = typeof node.subpath === "string" && node.subpath ? `#${node.subpath.replace(/^#/, "")}` : "";
  const markdown = !isAttachment(file);
  if (markdown && !subpath) {
                                                                                                     
    const dotted = (file.split("/").pop() ?? "").includes(".") && !MARKDOWN.test(file);
    return dotted ? { ...node, file: `${file}.md` } : node;
  }
  if (/\.canvas$/i.test(file) && node.color === "2") return node;
  const { file: _f, subpath: _s, ...rest } = node;
  const text = markdown ? `{{[[${file.replace(MARKDOWN, "")}${subpath}]]}}` : `[[${file}${subpath}]]`;
  return { ...rest, type: "text", text, color: "6" };
}

/** A copy of canvas JSON with engine-hostile file nodes rewritten; anything else passes through. */
export function normaliseForEngine<T>(canvas: T): T {
  const data = canvas as { nodes?: unknown } | null;
  if (!data || typeof data !== "object" || !Array.isArray(data.nodes)) return canvas;
  const copy = structuredClone(data) as { nodes: NodeLike[] };
  copy.nodes = copy.nodes.map((n) => (n && typeof n === "object" ? normaliseNode(n) : n));
  return copy as T;
}
