/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from "zod";
import {
  AllVerifiedCannoliCanvasNodeData,
  VerifiedCannoliCanvasData,
  VerifiedCannoliCanvasEdgeData,
} from "./graph";

export const hexColorSchema = z.custom<`#${string}`>((v) => {
  return /^#[0-9a-fA-F]{6}$/.test(v);
});

export type HexColor = z.infer<typeof hexColorSchema>;

export const canvasColorSchema = z.union([
  z.literal("1"),
  z.literal("2"),
  z.literal("3"),
  z.literal("4"),
  z.literal("5"),
  z.literal("6"),
  hexColorSchema,
]);

export type CanvasColor = z.infer<typeof canvasColorSchema>;

/**
 * Engine-written cache on a node or edge (DESIGN §3.5). Never needed for semantics:
 * node text stays authoritative, and the field is rebuilt on the next run. No prompts,
 * outputs or secrets go here. Unknown sub-keys are kept so newer engines can add fields.
 */
export const cannoliMetaSchema = z
  .object({
    v: z.number(),
    kind: z.string().optional(),
    specHash: z.string().optional(),
    last: z
      .object({
        runId: z.string().optional(),
        status: z.string().optional(),
        tokens: z.number().optional(),
        costUsd: z.number().optional(),
        at: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type CannoliMeta = z.infer<typeof cannoliMetaSchema>;

// A malformed cache is dropped rather than failing the whole parse.
const cannoliMetaField = cannoliMetaSchema.optional().catch(undefined);

// zod keeps a caught key as `cannoli: undefined`. The plugin copies parsed nodes and
// edges back onto the canvas file with Object.assign, which would then erase the
// file's own (malformed or foreign) value. Remove the key so the file keeps it.
const withoutUndefinedCannoli = <T extends { cannoli?: unknown }>(
  item: T,
): T => {
  if (!("cannoli" in item) || item.cannoli !== undefined) return item;
  const copy = { ...item };
  delete copy.cannoli;
  return copy;
};

const canvasNodeDataSchema = z
  .object({
    id: z.string(),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    color: z.string().optional(),
    text: z.string().optional(),
    type: z.string(),
    cannoli: cannoliMetaField,
  })
  .passthrough();

export type CanvasNodeData = z.infer<typeof canvasNodeDataSchema> & {
  [key: string]: any;
};

export const canvasFileDataSchema = canvasNodeDataSchema
  .merge(
    z.object({
      type: z.literal("file"),
      file: z.string(),
      subpath: z.string().optional(),
    }),
  )
  .passthrough();

export type CanvasFileData = z.infer<typeof canvasFileDataSchema>;

const canvasTextDataSchema = canvasNodeDataSchema
  .merge(
    z.object({
      type: z.literal("text"),
      text: z.string(),
    }),
  )
  .passthrough();

export type CanvasTextData = z.infer<typeof canvasTextDataSchema>;

export const canvasLinkDataSchema = canvasNodeDataSchema
  .merge(
    z.object({
      type: z.literal("link"),
      url: z.string(),
    }),
  )
  .passthrough();

export type CanvasLinkData = z.infer<typeof canvasLinkDataSchema>;

/** The background image rendering style */
export type BackgroundStyle = "cover" | "ratio" | "repeat";

export const canvasGroupDataSchema = canvasNodeDataSchema
  .merge(
    z.object({
      type: z.literal("group"),
      label: z.string().optional(),
      background: z.string().optional(),
      backgroundStyle: z
        .union([z.literal("cover"), z.literal("ratio"), z.literal("repeat")])
        .optional(),
    }),
  )
  .passthrough();

export type CanvasGroupData = z.infer<typeof canvasGroupDataSchema>;

export const nodeSideSchema = z.union([
  z.literal("top"),
  z.literal("right"),
  z.literal("bottom"),
  z.literal("left"),
]);

export type NodeSide = z.infer<typeof nodeSideSchema>;

export const edgeEndSchema = z.union([z.literal("none"), z.literal("arrow")]);

export type EdgeEnd = z.infer<typeof edgeEndSchema>;

export const allCanvasNodeDataSchema = z.union([
  canvasFileDataSchema,
  canvasTextDataSchema,
  canvasLinkDataSchema,
  canvasGroupDataSchema,
]);

export type AllCanvasNodeData = z.infer<typeof allCanvasNodeDataSchema>;

export const canvasEdgeDataSchema = z
  .object({
    id: z.string(),
    fromNode: z.string(),
    fromSide: nodeSideSchema,
    fromEnd: edgeEndSchema.optional(),
    toNode: z.string(),
    toSide: nodeSideSchema,
    toEnd: edgeEndSchema.optional(),
    color: z.string().optional(),
    label: z.string().optional(),
    cannoli: cannoliMetaField,
  })
  .passthrough();

export type CanvasEdgeData = z.infer<typeof canvasEdgeDataSchema> & {
  [key: string]: any;
};

export const canvasDataSchema = z.object({
  nodes: z.array(allCanvasNodeDataSchema.transform(withoutUndefinedCannoli)),
  edges: z.array(canvasEdgeDataSchema.transform(withoutUndefinedCannoli)),
});

export type CanvasData = z.infer<typeof canvasDataSchema>;

/** A single flush, in order. Node/edge edits update existing objects only. */
export type PersistorEdit =
  | { type: "node"; node: AllVerifiedCannoliCanvasNodeData }
  | { type: "edge"; edge: VerifiedCannoliCanvasEdgeData }
  | { type: "error" | "warning"; id: string; message: string }
  | { type: "label"; id: string; label: string };

export interface Persistor {
  /** Hosts can atomically apply a flush instead of rewriting once per edit. */
  applyBatch?(edits: readonly PersistorEdit[]): Promise<void>;
  /** Resolve only when queued edits are durable; reject on persistence failure. */
  flush?(): Promise<void>;
  start(canvasData: VerifiedCannoliCanvasData): Promise<void>;
  editNode(newNode: AllVerifiedCannoliCanvasNodeData): Promise<void>;
  editEdge(newEdge: VerifiedCannoliCanvasEdgeData): Promise<void>;
  addError(nodeId: string, message: string): Promise<void>;
  addWarning(nodeId: string, message: string): Promise<void>;
  editOriginalParallelGroupLabel(
    originalGroupId: string,
    label: string,
  ): Promise<void>;
  setConfig(config: Record<string, unknown>): void;
}
