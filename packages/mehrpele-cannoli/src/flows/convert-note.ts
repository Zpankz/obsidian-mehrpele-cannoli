                                                                                                  
// through the host's api.canvas, creates the note and opens it.

interface CanvasLike {
  nodes?: Array<{ type?: string; text?: string; label?: string; [k: string]: unknown }>;
  edges?: Array<{ label?: string; [k: string]: unknown }>;
}

/** `<base><ext>`, else `<base> 2<ext>`, ` 3`…: the first path that does not exist. */
export function freePath(base: string, ext: string, exists: (path: string) => boolean): string {
  let path = `${base}${ext}`;
  for (let n = 2; exists(path); n++) path = `${base} ${n}${ext}`;
  return path;
}

const split = (path: string) => {
  const slash = path.lastIndexOf("/");
  return { dir: path.slice(0, slash + 1), name: path.slice(slash + 1).replace(/\.[^.]+$/, "") };
};

/** `<dir>/<canvas basename> flow.md`, never an existing path. */
export function flowNotePath(canvasPath: string, exists: (path: string) => boolean): string {
  const { dir, name } = split(canvasPath);
  return freePath(`${dir}${name} flow`, ".md", exists);
}

// pele-render canvas/index.ts labelNeedsMarkdown (copied: the companion bundles no pele-render).
const markdownLabel = (s: string): boolean =>
  /\[\[|\*\*|__|`|\$[^$\s]|\n|~~|==[^=]|<br|\[[^\]]+\]\([^)]+\)|(^|\s)#[A-Za-z][\w/-]*|^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>)/m.test(s) ||
  /(^|[^\w*])\*[^*\s][^*]*\*(?!\w)/.test(s);

/**
 * Whether the converted flow needs a `mehrpele` fence: file cards (embeds) or Markdown labels, as
 * pele-render decides. main.ts passes the answer to canvasToMermaid, so source and fence agree.
 */
export function needsMehrpele(canvas: CanvasLike): boolean {
  const nodes = canvas.nodes ?? [];
  return (
    nodes.some((n) => n.type === "file" || (n.type === "text" && markdownLabel(n.text ?? "")) || (n.type === "group" && markdownLabel(n.label ?? ""))) ||
    (canvas.edges ?? []).some((e) => markdownLabel(e.label ?? ""))
  );
}

/** `Converted from [[path|name]].` and the flow fence (longer than any backtick run inside). */
export function flowNoteBody(canvasPath: string, source: string, lang: "mermaid" | "mehrpele"): string {
  const longest = Math.max(0, ...[...source.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  const body = source.endsWith("\n") ? source : `${source}\n`;
  return `Converted from [[${canvasPath}|${split(canvasPath).name}]].\n\n${fence}${lang} cannoli\n${body}${fence}\n`;
}
