import {
  createShapeId,
  toRichText,
  type TLArrowShape,
  type TLGeoShape,
  type TLParentId,
  type TLRecord,
  type TLShape,
  type TLShapeId,
} from "@tldraw/tlschema";
import { getIndicesAbove, sortByIndex, type IndexKey } from "@tldraw/utils";

import { getArchitectureResourceTemplate } from "@architect-lab/domain/architecture";
import type {
  AiAddResourceNodeToolCall,
  AiAnnotateResourceToolCall,
  AiConnectResourcesToolCall,
  AiToolCall,
  AiToolCallApplyRequest,
} from "@architect-lab/domain/ai";

interface TldrawStore {
  readonly put: (record: TLRecord) => void;
  readonly get: (id: string) => TLRecord | null;
  readonly getAll: () => Array<TLRecord>;
}

const pageParentId = "page:page" as TLParentId;
const resourceNodeSize = { w: 220, h: 104 };
const annotationNodeSize = { w: 260, h: 92 };
const aiLayoutScale = { x: 1, y: 1.25 };
const aiDiagramGap = 320;
const initialAiOrigin = { x: 160, y: 140 };

interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

interface Position {
  readonly x: number;
  readonly y: number;
}

export const applyAiToolCallsToTldrawStore = (
  store: TldrawStore,
  request: AiToolCallApplyRequest,
) => {
  const existingShapes = currentShapes(store);
  const origin = getAiPlacementOrigin(existingShapes, request);
  const shapeCount = request.toolCalls.filter(
    (toolCall) =>
      toolCall.type === "add_resource_node" ||
      toolCall.type === "connect_resources" ||
      toolCall.type === "annotate_resource",
  ).length;
  const indices = getIndicesAbove(highestShapeIndex(existingShapes), shapeCount);
  const nextIndex = () => {
    const index = indices.shift();
    if (index === undefined) {
      throw new Error("Missing tldraw shape index for AI tool call");
    }
    return index;
  };
  const resourceShapeIds = new Map<string, TLShapeId>();
  const resourceShapes = new Map<TLShapeId, TLShape>();

  for (const shape of existingShapes) {
    resourceShapes.set(shape.id, shape);
  }

  for (const toolCall of request.toolCalls) {
    if (toolCall.type !== "add_resource_node") {
      continue;
    }

    const shape = makeResourceShape(toolCall, origin, nextIndex(), request.jobId);
    resourceShapeIds.set(toolCall.id, shape.id);
    resourceShapes.set(shape.id, shape);
    store.put(shape);
  }

  let edgeIndex = 0;
  for (const toolCall of request.toolCalls) {
    if (toolCall.type !== "connect_resources") {
      continue;
    }

    const sourceId = resolveResourceShapeId(store, resourceShapeIds, toolCall.sourceId);
    const targetId = resolveResourceShapeId(store, resourceShapeIds, toolCall.targetId);
    const source = sourceId === undefined ? undefined : resourceShapes.get(sourceId);
    const target = targetId === undefined ? undefined : resourceShapes.get(targetId);

    if (source === undefined || target === undefined) {
      continue;
    }

    const shape = makeEdgeShape(toolCall, source, target, edgeIndex, nextIndex());
    edgeIndex += 1;
    store.put(shape);
  }

  for (const toolCall of request.toolCalls) {
    if (toolCall.type !== "annotate_resource") {
      continue;
    }

    store.put(makeAnnotationShape(toolCall, origin, nextIndex(), request.jobId));
  }
};

const currentShapes = (store: TldrawStore): Array<TLShape> =>
  store.getAll().filter((record): record is TLShape => record.typeName === "shape");

const highestShapeIndex = (shapes: ReadonlyArray<TLShape>): IndexKey | null => {
  const sorted = [...shapes].sort(sortByIndex);
  return sorted.at(-1)?.index ?? null;
};

const scaledAiPosition = (position: Position): Position => ({
  x: position.x * aiLayoutScale.x,
  y: position.y * aiLayoutScale.y,
});

const getShapeBounds = (shape: TLShape): Bounds | null => {
  if (shape.type === "geo") {
    const w = typeof shape.props.w === "number" ? shape.props.w : resourceNodeSize.w;
    const h = typeof shape.props.h === "number" ? shape.props.h : resourceNodeSize.h;
    return {
      minX: shape.x,
      minY: shape.y,
      maxX: shape.x + w,
      maxY: shape.y + h,
    };
  }

  if (shape.type === "arrow") {
    const start = {
      x: shape.x + shape.props.start.x,
      y: shape.y + shape.props.start.y,
    };
    const end = {
      x: shape.x + shape.props.end.x,
      y: shape.y + shape.props.end.y,
    };
    return {
      minX: Math.min(start.x, end.x),
      minY: Math.min(start.y, end.y),
      maxX: Math.max(start.x, end.x),
      maxY: Math.max(start.y, end.y),
    };
  }

  return null;
};

const mergeBounds = (bounds: ReadonlyArray<Bounds | null>): Bounds | null => {
  const present = bounds.filter((bound): bound is Bounds => bound !== null);
  if (present.length === 0) {
    return null;
  }

  return present.reduce(
    (merged, next) => ({
      minX: Math.min(merged.minX, next.minX),
      minY: Math.min(merged.minY, next.minY),
      maxX: Math.max(merged.maxX, next.maxX),
      maxY: Math.max(merged.maxY, next.maxY),
    }),
    present[0],
  );
};

const getAiToolCallBounds = (toolCalls: ReadonlyArray<AiToolCall>): Bounds | null => {
  const bounds: Array<Bounds> = [];

  for (const toolCall of toolCalls) {
    if (toolCall.type !== "add_resource_node" && toolCall.type !== "annotate_resource") {
      continue;
    }

    const position = scaledAiPosition(toolCall.position);
    const size = toolCall.type === "annotate_resource" ? annotationNodeSize : resourceNodeSize;
    bounds.push({
      minX: position.x,
      minY: position.y,
      maxX: position.x + size.w,
      maxY: position.y + size.h,
    });
  }

  return mergeBounds(bounds);
};

const getAiPlacementOrigin = (
  existingShapes: ReadonlyArray<TLShape>,
  request: AiToolCallApplyRequest,
): Position => {
  const existingJobOrigin = getExistingAiJobOrigin(existingShapes, request.jobId);
  if (existingJobOrigin !== null) {
    return existingJobOrigin;
  }

  const toolCalls = request.toolCalls;
  const planBounds = getAiToolCallBounds(toolCalls);
  const existingBounds = mergeBounds(existingShapes.map(getShapeBounds));

  if (planBounds === null) {
    return initialAiOrigin;
  }

  if (existingBounds === null) {
    const planCenterY = (planBounds.minY + planBounds.maxY) / 2;
    return {
      x: initialAiOrigin.x - planBounds.minX,
      y: initialAiOrigin.y - planCenterY,
    };
  }

  return {
    x: existingBounds.maxX + aiDiagramGap - planBounds.minX,
    y: existingBounds.minY - planBounds.minY,
  };
};

const getExistingAiJobOrigin = (
  existingShapes: ReadonlyArray<TLShape>,
  jobId: string,
): Position | null => {
  for (const shape of existingShapes) {
    const meta = shape.meta;
    if (meta.aiJobId !== jobId) {
      continue;
    }

    const planPosition = getMetaPosition(meta.aiPlanPosition);
    if (planPosition === null) {
      continue;
    }

    const scaledPlanPosition = scaledAiPosition(planPosition);
    return {
      x: shape.x - scaledPlanPosition.x,
      y: shape.y - scaledPlanPosition.y,
    };
  }

  return null;
};

const makeResourceShape = (
  toolCall: AiAddResourceNodeToolCall,
  origin: Position,
  index: IndexKey,
  jobId?: string,
): TLGeoShape => {
  const id = createShapeId(toolCall.id);
  const template = getArchitectureResourceTemplate(toolCall.kind);
  const position = scaledAiPosition(toolCall.position);

  return makeGeoShape({
    id,
    index,
    x: origin.x + position.x,
    y: origin.y + position.y,
    w: resourceNodeSize.w,
    h: resourceNodeSize.h,
    color: template.color,
    fill: "solid",
    dash: "draw",
    size: "m",
    text: toolCall.name,
    meta: {
      architect: {
        id: String(id),
        kind: toolCall.kind,
        name: toolCall.name,
        bindingName: toolCall.bindingName,
      },
      aiDescription: toolCall.description,
      aiJobId: jobId,
      aiResourceId: toolCall.id,
      aiPlanPosition: toolCall.position,
    },
  });
};

const makeAnnotationShape = (
  toolCall: AiAnnotateResourceToolCall,
  origin: Position,
  index: IndexKey,
  jobId?: string,
): TLGeoShape => {
  const position = scaledAiPosition(toolCall.position);

  return makeGeoShape({
    id: createShapeId(toolCall.id),
    index,
    x: origin.x + position.x,
    y: origin.y + position.y,
    w: annotationNodeSize.w,
    h: annotationNodeSize.h,
    color: "grey",
    fill: "none",
    dash: "dashed",
    size: "s",
    text: toolCall.note,
    meta: {
      aiAnnotation: toolCall,
      aiJobId: jobId,
      aiPlanPosition: toolCall.position,
    },
  });
};

const makeGeoShape = (options: {
  readonly id: TLShapeId;
  readonly index: IndexKey;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly color: string;
  readonly fill: "none" | "solid";
  readonly dash: "draw" | "dashed";
  readonly size: "s" | "m";
  readonly text: string;
  readonly meta: TLGeoShape["meta"];
}): TLGeoShape => ({
  id: options.id,
  typeName: "shape",
  type: "geo",
  x: options.x,
  y: options.y,
  rotation: 0,
  index: options.index,
  parentId: pageParentId,
  isLocked: false,
  opacity: 1,
  props: {
    w: options.w,
    h: options.h,
    geo: "rectangle",
    color: options.color as TLGeoShape["props"]["color"],
    labelColor: "black",
    fill: options.fill,
    dash: options.dash,
    size: options.size,
    font: "draw",
    align: "middle",
    verticalAlign: "middle",
    richText: toRichText(options.text),
    url: "",
    growY: 0,
    scale: 1,
  },
  meta: options.meta,
});

const makeEdgeShape = (
  toolCall: AiConnectResourcesToolCall,
  source: TLShape,
  target: TLShape,
  edgeIndex: number,
  index: IndexKey,
): TLArrowShape => {
  const id = createShapeId(toolCall.id);
  const anchors = getArrowAnchors(source, target, edgeIndex);

  return {
    id,
    typeName: "shape",
    type: "arrow",
    x: 0,
    y: 0,
    rotation: 0,
    index,
    parentId: pageParentId,
    isLocked: false,
    opacity: 1,
    props: {
      kind: "arc",
      labelColor: "black",
      color: "grey",
      fill: "none",
      dash: "draw",
      size: "m",
      arrowheadStart: "none",
      arrowheadEnd: "arrow",
      font: "draw",
      start: anchors.start,
      end: anchors.end,
      bend: 0,
      richText: toRichText(toolCall.label),
      labelPosition: 0.5,
      scale: 1,
      elbowMidPoint: 0.5,
    },
    meta: {
      architectEdge: {
        id: String(id),
        kind: toolCall.kind,
        sourceId: String(source.id),
        targetId: String(target.id),
        label: toolCall.label,
      },
    },
  };
};

const getArrowAnchors = (
  source: TLShape,
  target: TLShape,
  edgeIndex: number,
): { readonly start: Position; readonly end: Position } => {
  const sourceBounds = getShapeBounds(source) ?? {
    minX: source.x,
    minY: source.y,
    maxX: source.x + resourceNodeSize.w,
    maxY: source.y + resourceNodeSize.h,
  };
  const targetBounds = getShapeBounds(target) ?? {
    minX: target.x,
    minY: target.y,
    maxX: target.x + resourceNodeSize.w,
    maxY: target.y + resourceNodeSize.h,
  };
  const sourceCenter = centerOf(sourceBounds);
  const targetCenter = centerOf(targetBounds);
  const lane = ((edgeIndex % 3) - 1) * 20;

  if (Math.abs(targetCenter.x - sourceCenter.x) >= Math.abs(targetCenter.y - sourceCenter.y)) {
    const leftToRight = targetCenter.x >= sourceCenter.x;
    return {
      start: {
        x: leftToRight ? sourceBounds.maxX + 18 : sourceBounds.minX - 18,
        y: sourceCenter.y + lane,
      },
      end: {
        x: leftToRight ? targetBounds.minX - 18 : targetBounds.maxX + 18,
        y: targetCenter.y + lane,
      },
    };
  }

  const topToBottom = targetCenter.y >= sourceCenter.y;
  return {
    start: {
      x: sourceCenter.x + lane,
      y: topToBottom ? sourceBounds.maxY + 18 : sourceBounds.minY - 18,
    },
    end: {
      x: targetCenter.x + lane,
      y: topToBottom ? targetBounds.minY - 18 : targetBounds.maxY + 18,
    },
  };
};

const centerOf = (bounds: Bounds): Position => ({
  x: (bounds.minX + bounds.maxX) / 2,
  y: (bounds.minY + bounds.maxY) / 2,
});

const resolveResourceShapeId = (
  store: TldrawStore,
  createdResourceShapeIds: ReadonlyMap<string, TLShapeId>,
  resourceId: string,
): TLShapeId | undefined => {
  const created = createdResourceShapeIds.get(resourceId);
  if (created !== undefined) {
    return created;
  }

  const shapeId = toResourceShapeId(resourceId);
  const direct = store.get(shapeId);
  if (direct?.typeName === "shape") {
    return direct.id;
  }

  const matching = currentShapes(store).find(
    (shape) =>
      getArchitectMetaId(shape) === resourceId ||
      getAiResourceId(shape) === resourceId ||
      shape.id === shapeId,
  );
  return matching?.id;
};

const toResourceShapeId = (resourceId: string): TLShapeId =>
  resourceId.startsWith("shape:") ? (resourceId as TLShapeId) : createShapeId(resourceId);

const getArchitectMetaId = (shape: TLShape): string | undefined => {
  const architect = shape.meta.architect;
  if (typeof architect !== "object" || architect === null || Array.isArray(architect)) {
    return undefined;
  }

  const id = architect.id;
  return typeof id === "string" ? id : undefined;
};

const getAiResourceId = (shape: TLShape): string | undefined => {
  const id = shape.meta.aiResourceId;
  return typeof id === "string" ? id : undefined;
};

const getMetaPosition = (value: unknown): Position | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const position = value as Record<string, unknown>;
  return typeof position.x === "number" && typeof position.y === "number"
    ? { x: position.x, y: position.y }
    : null;
};
