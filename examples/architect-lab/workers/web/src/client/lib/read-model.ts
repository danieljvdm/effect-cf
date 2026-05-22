import type {
  ArchitectureEdge,
  ArchitectureReadModelInput,
  ArchitectureResource,
} from "@architect-lab/domain/architecture";
import type { Editor, TLShape } from "tldraw";

type ArchitectureShapeMeta = {
  architect?: ArchitectureResource;
  architectEdge?: ArchitectureEdge;
};

export type ArchitectureSelection =
  | {
      readonly type: "resource";
      readonly resource: ArchitectureResource;
    }
  | {
      readonly type: "edge";
      readonly edge: ArchitectureEdge;
    };

const getArchitectureMeta = (shape: TLShape): ArchitectureShapeMeta =>
  shape.meta as ArchitectureShapeMeta;

export const getShapeArchitectureSelection = (
  shape: TLShape | null | undefined,
): ArchitectureSelection | null => {
  if (shape == null) {
    return null;
  }

  const meta = getArchitectureMeta(shape);
  if (meta.architect !== undefined) {
    return { type: "resource", resource: meta.architect };
  }
  if (meta.architectEdge !== undefined) {
    return { type: "edge", edge: meta.architectEdge };
  }

  return null;
};

export const collectArchitectureReadModel = (editor: Editor): ArchitectureReadModelInput => {
  const resources: Array<ArchitectureResource> = [];
  const edges: Array<ArchitectureEdge> = [];

  for (const shape of editor.getCurrentPageShapes()) {
    const meta = getArchitectureMeta(shape);

    if (meta.architect !== undefined) {
      resources.push({
        ...meta.architect,
        id: String(shape.id),
      });
    }

    if (meta.architectEdge !== undefined) {
      edges.push({
        ...meta.architectEdge,
        id: String(shape.id),
      });
    }
  }

  return { resources, edges };
};
