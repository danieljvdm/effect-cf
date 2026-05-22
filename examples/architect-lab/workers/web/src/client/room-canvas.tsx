import { useSync } from "@tldraw/sync";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Tldraw, type Editor } from "tldraw";

import type {
  ArchitectureReadModelInput,
  ArchitectureResource,
} from "@architect-lab/domain/architecture";

import { getPersistentUserId } from "./lib/identity.js";
import { inlineAssetStore } from "./lib/inline-asset-store.js";
import { collectArchitectureReadModel, getShapeResource } from "./lib/read-model.js";

const userId = getPersistentUserId();

export type RoomCanvasProps = {
  readonly label: string;
  readonly onEditorReady: (editor: Editor | null) => void;
  readonly onReadModelChange: (readModel: ArchitectureReadModelInput) => void;
  readonly onSelectionChange: (resource: ArchitectureResource | null) => void;
  readonly roomId: string;
};

export const RoomCanvas = ({
  label,
  onEditorReady,
  onReadModelChange,
  onSelectionChange,
  roomId,
}: RoomCanvasProps) => {
  const cleanupRef = useRef<(() => void) | null>(null);

  const uri = useMemo(() => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(`${protocol}//${location.host}/api/rooms/${roomId}/ws`);
    url.searchParams.set("label", label || "Guest");
    url.searchParams.set("userId", userId);
    return url.toString();
  }, [label, roomId]);

  const remote = useSync({
    assets: inlineAssetStore,
    uri,
  });

  const handleMount = useCallback(
    (mountedEditor: Editor) => {
      cleanupRef.current?.();
      onEditorReady(mountedEditor);
      let readModelTimer: ReturnType<typeof setTimeout> | undefined;

      const updateSelection = () => {
        onSelectionChange(getShapeResource(mountedEditor.getOnlySelectedShape()));
      };

      const saveSemanticReadModel = () => {
        onReadModelChange(collectArchitectureReadModel(mountedEditor));
      };

      const scheduleReadModelSave = () => {
        if (readModelTimer !== undefined) {
          clearTimeout(readModelTimer);
        }
        readModelTimer = setTimeout(saveSemanticReadModel, 400);
      };

      updateSelection();
      scheduleReadModelSave();
      const dispose = mountedEditor.store.listen(() => {
        updateSelection();
        scheduleReadModelSave();
      });

      cleanupRef.current = () => {
        if (readModelTimer !== undefined) {
          clearTimeout(readModelTimer);
        }
        dispose?.();
        onSelectionChange(null);
        onEditorReady(null);
      };
    },
    [onEditorReady, onReadModelChange, onSelectionChange],
  );

  useEffect(
    () => () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    },
    [],
  );

  if (remote.status === "loading") {
    return (
      <div className="absolute bottom-4 left-4 z-10 rounded-md border border-slate-300 bg-white/95 px-3 py-2 text-sm text-slate-600 shadow-lg">
        Connecting tldraw sync...
      </div>
    );
  }

  if (remote.status === "error") {
    return (
      <div className="absolute bottom-4 left-4 z-10 max-w-[min(420px,calc(100%-2rem))] rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900 shadow-lg">
        {remote.error?.message || "Unable to connect tldraw sync."}
      </div>
    );
  }

  return (
    <>
      <div className="absolute inset-0">
        <Tldraw onMount={handleMount} store={remote.store} />
      </div>
      <div className="absolute bottom-4 left-4 z-10 max-w-[min(420px,calc(100%-2rem))] rounded-md border border-slate-300 bg-white/95 px-3 py-2 text-sm text-slate-600 shadow-lg">
        Tldraw sync connected. Document changes and presence are room-scoped.
      </div>
    </>
  );
};
