import { Atom } from "effect/unstable/reactivity";
import type { Editor } from "tldraw";

import { saveSemanticReadModelAtom } from "./api";
import { collectArchitectureReadModel, getShapeArchitectureSelection } from "./lib/read-model";
import { architectureReadModelAtom, editorAtom, selectedArchitectureAtom } from "./state";

export interface RoomCanvasEditorArgs {
  readonly editor: Editor;
  readonly roomId: string;
}

let readModelTimer: ReturnType<typeof setTimeout> | undefined;

const clearPendingReadModelSave = () => {
  if (readModelTimer !== undefined) {
    clearTimeout(readModelTimer);
    readModelTimer = undefined;
  }
};

export const roomCanvasMountedAtom = Atom.fnSync<RoomCanvasEditorArgs>()((args, get) => {
  clearPendingReadModelSave();
  get.set(editorAtom, args.editor);
  get.set(roomCanvasChangedAtom, args);
});

export const roomCanvasChangedAtom = Atom.fnSync<RoomCanvasEditorArgs>()((
  { editor, roomId },
  get,
) => {
  const readModel = collectArchitectureReadModel(editor);

  get.set(selectedArchitectureAtom, getShapeArchitectureSelection(editor.getOnlySelectedShape()));
  get.set(architectureReadModelAtom, readModel);
  clearPendingReadModelSave();
  readModelTimer = setTimeout(() => {
    get.set(saveSemanticReadModelAtom, {
      readModel,
      roomId,
    });
  }, 400);
});

export const roomCanvasUnmountedAtom = Atom.fnSync<void>()((_, get) => {
  clearPendingReadModelSave();
  get.set(selectedArchitectureAtom, null);
  get.set(architectureReadModelAtom, { edges: [], resources: [] });
  get.set(editorAtom, null);
});
