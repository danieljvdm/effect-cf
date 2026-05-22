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

const getArchitectureMeta = (shape: TLShape): ArchitectureShapeMeta =>
  shape.meta as ArchitectureShapeMeta;

export const getShapeResource = (shape: TLShape | null | undefined): ArchitectureResource | null =>
  shape == null ? null : (getArchitectureMeta(shape).architect ?? null);

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
