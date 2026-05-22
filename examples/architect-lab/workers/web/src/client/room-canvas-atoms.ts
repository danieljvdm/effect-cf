import { Atom } from "effect/unstable/reactivity";
import type { Editor } from "tldraw";

import { saveSemanticReadModelAtom } from "./api";
import { collectArchitectureReadModel, getShapeResource } from "./lib/read-model";
import { editorAtom, selectedResourceAtom } from "./state";

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
  get.set(selectedResourceAtom, getShapeResource(editor.getOnlySelectedShape()));
  clearPendingReadModelSave();
  readModelTimer = setTimeout(() => {
    get.set(saveSemanticReadModelAtom, {
      readModel: collectArchitectureReadModel(editor),
      roomId,
    });
  }, 400);
});

export const roomCanvasUnmountedAtom = Atom.fnSync<void>()((_, get) => {
  clearPendingReadModelSave();
  get.set(selectedResourceAtom, null);
  get.set(editorAtom, null);
});
