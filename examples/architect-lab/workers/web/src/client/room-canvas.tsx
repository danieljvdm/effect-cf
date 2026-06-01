import { useSync } from "@tldraw/sync";
import { useAtomSet } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Tldraw, type Editor } from "tldraw";

import { getPersistentUserId } from "./lib/identity";
import { inlineAssetStore } from "./lib/inline-asset-store";
import {
  roomCanvasChangedAtom,
  roomCanvasMountedAtom,
  roomCanvasUnmountedAtom,
} from "./room-canvas-atoms";

const userId = getPersistentUserId();
const tldrawLicenseKey =
  "tldraw-2026-06-05/WyJzRWhuSjVyVSIsWyIqIl0sMTYsIjIwMjYtMDYtMDUiXQ.Y4FYCveLpUwqUtCpQCTmoRkPDCI5yjRu61Ah4Om1+uxPhbGf+ED9jphMm3AEIXFgZleTz7rjvRVitUj2iVfLlA";

export type RoomCanvasProps = {
  readonly label: string;
  readonly roomId: string;
};

export const RoomCanvas = ({ label, roomId }: RoomCanvasProps) => {
  const cleanupRef = useRef<(() => void) | null>(null);
  const roomCanvasMounted = useAtomSet(roomCanvasMountedAtom);
  const roomCanvasChanged = useAtomSet(roomCanvasChangedAtom);
  const roomCanvasUnmounted = useAtomSet(roomCanvasUnmountedAtom);

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
      roomCanvasMounted({ editor: mountedEditor, roomId });
      const dispose = mountedEditor.store.listen(() => {
        roomCanvasChanged({ editor: mountedEditor, roomId });
      });

      cleanupRef.current = () => {
        dispose?.();
        roomCanvasUnmounted(void 0);
      };
    },
    [roomCanvasChanged, roomCanvasMounted, roomCanvasUnmounted, roomId],
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
        <Tldraw licenseKey={tldrawLicenseKey} onMount={handleMount} store={remote.store} />
      </div>
      <div className="absolute bottom-4 left-4 z-10 max-w-[min(420px,calc(100%-2rem))] rounded-md border border-slate-300 bg-white/95 px-3 py-2 text-sm text-slate-600 shadow-lg">
        Tldraw sync connected. Document changes and presence are room-scoped.
      </div>
    </>
  );
};
