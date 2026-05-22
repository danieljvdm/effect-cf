import { Field } from "@base-ui-components/react/field";
import { Clipboard, LoaderCircle, Network, Play, Plus, Sparkles } from "lucide-react";
import { useCallback, useState } from "react";
import { createShapeId, toRichText, type Editor } from "tldraw";

import type {
  ArchitectureReadModelInput,
  ArchitectureResource,
  ArchitectureResourceTemplate,
} from "@architect-lab/domain/architecture";
import { architectureResourceTemplates } from "@architect-lab/domain/resource-templates";
import { toBindingName } from "@architect-lab/domain/snippets";

import { CodePanel } from "./code-panel.js";
import { Button } from "./components/ui/button.js";
import { FieldLabel, FieldRoot } from "./components/ui/field.js";
import { Input } from "./components/ui/input.js";
import { Textarea } from "./components/ui/textarea.js";
import { collectArchitectureReadModel } from "./lib/read-model.js";
import { getInitialRoomId, randomLabel } from "./lib/identity.js";
import { RoomCanvas } from "./room-canvas.js";
import { ResourcePalette } from "./resource-palette.js";

const resourceNodeSize = { h: 104, w: 220 } as const;
const emptyReadModel: ArchitectureReadModelInput = { edges: [], resources: [] };
type TldrawResourceColor =
  | "blue"
  | "green"
  | "grey"
  | "light-blue"
  | "light-violet"
  | "orange"
  | "red"
  | "violet"
  | "yellow";

const toTldrawResourceColor = (color: string): TldrawResourceColor => {
  switch (color) {
    case "blue":
    case "green":
    case "grey":
    case "light-blue":
    case "light-violet":
    case "orange":
    case "red":
    case "violet":
    case "yellow":
      return color;
    default:
      return "grey";
  }
};

export const App = () => {
  const [roomId, setRoomId] = useState(getInitialRoomId);
  const [label, setLabel] = useState(
    () => localStorage.getItem("architect:label") ?? randomLabel(),
  );
  const [creating, setCreating] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [selectedResource, setSelectedResource] = useState<ArchitectureResource | null>(null);
  const [resourceCounts, setResourceCounts] = useState<Record<string, number>>({});
  const [readModelStatus, setReadModelStatus] = useState("not synced");
  const [aiPrompt, setAiPrompt] = useState("Draw an AI architecture canvas");
  const [aiStatus, setAiStatus] = useState("Fake provider ready");
  const [aiRunning, setAiRunning] = useState(false);

  const createRoom = async () => {
    setCreating(true);
    try {
      const response = await fetch("/api/rooms", { method: "POST" });
      const body = (await response.json()) as { roomId: string };
      history.pushState(null, "", `/room/${body.roomId}`);
      setRoomId(body.roomId);
    } finally {
      setCreating(false);
    }
  };

  const saveLabel = (value: string) => {
    setLabel(value);
    localStorage.setItem("architect:label", value);
  };

  const copyUrl = () => navigator.clipboard?.writeText(location.href);

  const saveReadModel = useCallback(
    async (readModel: ArchitectureReadModelInput) => {
      if (roomId === "") {
        return;
      }

      setReadModelStatus("saving");
      try {
        const response = await fetch(`/api/rooms/${roomId}/read-model`, {
          body: JSON.stringify(readModel),
          headers: { "content-type": "application/json" },
          method: "PUT",
        });

        if (!response.ok) {
          throw new Error("Unable to save read model");
        }

        setReadModelStatus("saved");
      } catch {
        setReadModelStatus("error");
      }
    },
    [roomId],
  );

  const addResource = (template: ArchitectureResourceTemplate) => {
    if (editor === null) {
      return;
    }

    const nextCount = (resourceCounts[template.kind] ?? 0) + 1;
    const name = nextCount === 1 ? template.label : `${template.label} ${nextCount}`;
    const bindingName = toBindingName(name, template.bindingPrefix);
    const id = createShapeId();
    const bounds = editor.getViewportPageBounds();
    const resource: ArchitectureResource = {
      bindingName,
      id: String(id),
      kind: template.kind,
      name,
    };

    editor.createShape({
      id,
      meta: {
        architect: resource,
      },
      props: {
        align: "middle",
        color: toTldrawResourceColor(template.color),
        dash: "draw",
        fill: "solid",
        font: "draw",
        geo: "rectangle",
        h: resourceNodeSize.h,
        richText: toRichText(name),
        size: "m",
        verticalAlign: "middle",
        w: resourceNodeSize.w,
      },
      type: "geo",
      x: bounds.x + bounds.w / 2 - resourceNodeSize.w / 2 + nextCount * 12,
      y: bounds.y + bounds.h / 2 - resourceNodeSize.h / 2 + nextCount * 12,
    });
    editor.select(id);
    setResourceCounts((counts) => ({
      ...counts,
      [template.kind]: nextCount,
    }));
    setSelectedResource(resource);
  };

  const submitAiPrompt = async () => {
    if (roomId === "" || aiPrompt.trim() === "") {
      return;
    }

    setAiRunning(true);
    setAiStatus("Queueing fake AI job");
    try {
      const response = await fetch(`/api/rooms/${roomId}/ai/prompts`, {
        body: JSON.stringify({
          actor: label || "Guest",
          prompt: aiPrompt,
          readModel: editor === null ? emptyReadModel : collectArchitectureReadModel(editor),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("AI prompt failed");
      }

      const result = (await response.json()) as { summary?: string };
      setAiStatus(result.summary ?? "Fake AI job queued");
    } catch {
      setAiStatus("AI prompt failed");
    } finally {
      setAiRunning(false);
    }
  };

  return (
    <div className="grid h-screen grid-cols-[320px_minmax(0,1fr)_360px] bg-[#f4f6f8] text-slate-950 max-[900px]:h-auto max-[900px]:min-h-screen max-[900px]:grid-cols-1 max-[900px]:grid-rows-[auto_minmax(620px,1fr)_auto]">
      <aside
        aria-label="Architect Lab room controls"
        className="z-10 grid min-w-0 grid-rows-[auto_auto_1fr_auto] gap-5 border-r border-slate-300 bg-white/95 p-5 max-[900px]:border-b max-[900px]:border-r-0"
      >
        <header className="grid gap-2">
          <div className="flex items-center gap-2">
            <Network aria-hidden="true" className="size-5 text-teal-700" />
            <h1 className="text-xl font-bold leading-tight tracking-normal text-slate-950">
              Architect Lab
            </h1>
          </div>
          <p className="text-sm leading-6 text-slate-600">
            Multiplayer tldraw rooms backed by an Effect Durable Object.
          </p>
        </header>

        <section className="grid gap-2.5" aria-label="Room actions">
          <FieldRoot>
            <FieldLabel>Display name</FieldLabel>
            <Input
              aria-label="Display name"
              value={label}
              onChange={(event) => saveLabel(event.currentTarget.value)}
            />
          </FieldRoot>
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={creating} onClick={createRoom}>
              {creating ? (
                <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <Plus aria-hidden="true" className="size-4" />
              )}
              {creating ? "Creating" : "Create room"}
            </Button>
            <Button disabled={roomId === ""} onClick={copyUrl} variant="outline">
              <Clipboard aria-hidden="true" className="size-4" />
              Copy URL
            </Button>
          </div>
        </section>

        <Field.Root
          aria-label="AI architect"
          className="grid content-start gap-2.5 rounded-md border border-slate-300 bg-white p-3"
        >
          <div className="flex items-center gap-2">
            <Sparkles aria-hidden="true" className="size-4 text-teal-700" />
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-600">
              AI architect
            </h2>
          </div>
          <FieldRoot>
            <FieldLabel>Prompt</FieldLabel>
            <Textarea
              value={aiPrompt}
              onChange={(event) => setAiPrompt(event.currentTarget.value)}
            />
          </FieldRoot>
          <Button
            disabled={roomId === "" || aiRunning || aiPrompt.trim() === ""}
            onClick={submitAiPrompt}
          >
            {aiRunning ? (
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            ) : (
              <Play aria-hidden="true" className="size-4" />
            )}
            {aiRunning ? "Queueing" : "Run fake architect"}
          </Button>
          <p className="min-h-9 text-sm leading-5 text-slate-600">{aiStatus}</p>
        </Field.Root>

        <section className="grid content-start gap-2" aria-label="Room status">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-600">Room</h2>
          <StatusRow label="Id" value={roomId || "none"} />
          <StatusRow label="User" value={label || "Guest"} />
          <StatusRow label="Read model" value={readModelStatus} />
          <p className="pt-1 text-sm leading-6 text-slate-600">
            Open this URL in another tab to verify shared shapes, cursors, selection, and reload
            persistence.
          </p>
        </section>

        <p className="text-sm leading-6 text-slate-600">
          Assets are stored inline for this phase; R2-backed uploads are deferred.
        </p>
      </aside>

      <section className="relative min-h-0 min-w-0 bg-[linear-gradient(#e0e6eb_1px,transparent_1px),linear-gradient(90deg,#e0e6eb_1px,transparent_1px)] bg-[length:28px_28px]">
        {roomId !== "" ? (
          <RoomCanvas
            label={label}
            onEditorReady={setEditor}
            onReadModelChange={saveReadModel}
            onSelectionChange={setSelectedResource}
            roomId={roomId}
          />
        ) : (
          <div className="grid h-full place-items-center p-7">
            <div className="grid w-[min(480px,100%)] gap-3 rounded-md border border-slate-300 bg-white/90 p-6 shadow-xl">
              <h2 className="text-2xl font-bold leading-tight tracking-normal text-slate-950">
                Create a room to start drawing
              </h2>
              <p className="text-sm leading-6 text-slate-600">
                The canvas will connect to a room Durable Object and persist tldraw records in
                Durable Object SQLite.
              </p>
              <Button className="w-fit" disabled={creating} onClick={createRoom}>
                {creating ? (
                  <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                ) : (
                  <Plus aria-hidden="true" className="size-4" />
                )}
                {creating ? "Creating" : "Create room"}
              </Button>
            </div>
          </div>
        )}
      </section>

      <aside
        aria-label="Architecture resources and code"
        className="z-10 grid min-w-0 grid-rows-[minmax(0,1fr)_minmax(180px,0.75fr)] gap-5 overflow-hidden border-l border-slate-300 bg-white/95 p-5 max-[900px]:grid-rows-[auto_minmax(260px,1fr)] max-[900px]:border-l-0 max-[900px]:border-t max-[900px]:overflow-visible"
      >
        <ResourcePalette
          disabled={roomId === "" || editor === null}
          onAddResource={addResource}
          templates={architectureResourceTemplates}
        />
        <CodePanel resource={selectedResource} />
      </aside>
    </div>
  );
};

const StatusRow = ({ label, value }: { readonly label: string; readonly value: string }) => (
  <div className="flex justify-between gap-3 border-b border-slate-200 py-2 text-sm text-slate-600">
    <span>{label}</span>
    <strong className="min-w-0 overflow-hidden text-ellipsis break-words text-right font-bold text-slate-950">
      {value}
    </strong>
  </div>
);
