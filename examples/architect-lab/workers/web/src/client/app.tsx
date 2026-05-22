import { Field } from "@base-ui-components/react/field";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Clipboard, LoaderCircle, Network, Play, Plus, Sparkles } from "lucide-react";
import { createShapeId, toRichText } from "tldraw";

import type {
  ArchitectureReadModelInput,
  ArchitectureResource,
  ArchitectureResourceTemplate,
} from "@architect-lab/domain/architecture";
import { architectureResourceTemplates } from "@architect-lab/domain/resource-templates";
import { toBindingName } from "@architect-lab/domain/snippets";

import { CodePanel } from "./code-panel";
import { Button } from "./components/ui/button";
import { FieldLabel, FieldRoot } from "./components/ui/field";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { collectArchitectureReadModel } from "./lib/read-model";
import { createRoomAtom, saveSemanticReadModelAtom, submitAiPromptAtom } from "./api";
import { RoomCanvas } from "./room-canvas";
import { ResourcePalette } from "./resource-palette";
import {
  aiPromptAtom,
  editorAtom,
  labelAtom,
  resourceCountsAtom,
  roomIdAtom,
  saveLabelAtom,
  selectedResourceAtom,
} from "./state";

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
  const roomId = useAtomValue(roomIdAtom);
  const label = useAtomValue(labelAtom);
  const editor = useAtomValue(editorAtom);
  const selectedResource = useAtomValue(selectedResourceAtom);
  const aiPrompt = useAtomValue(aiPromptAtom);
  const resourceCounts = useAtomValue(resourceCountsAtom);
  const createRoomResult = useAtomValue(createRoomAtom);
  const saveReadModelResult = useAtomValue(saveSemanticReadModelAtom);
  const submitAiPromptResult = useAtomValue(submitAiPromptAtom);
  const createRoom = useAtomSet(createRoomAtom);
  const submitAiPromptRequest = useAtomSet(submitAiPromptAtom);
  const saveLabel = useAtomSet(saveLabelAtom);
  const setAiPrompt = useAtomSet(aiPromptAtom);
  const setSelectedResource = useAtomSet(selectedResourceAtom);
  const setResourceCounts = useAtomSet(resourceCountsAtom);

  const creating = createRoomResult.waiting;
  const readModelStatus = saveReadModelResult.waiting
    ? "saving"
    : saveReadModelResult._tag === "Success"
      ? "saved"
      : saveReadModelResult._tag === "Failure"
        ? "error"
        : "not synced";
  const aiRunning = submitAiPromptResult.waiting;
  const aiStatus = aiRunning
    ? "Queueing fake AI job"
    : submitAiPromptResult._tag === "Success" && submitAiPromptResult.value !== undefined
      ? submitAiPromptResult.value.summary
      : submitAiPromptResult._tag === "Failure"
        ? "AI prompt failed"
        : "Fake provider ready";

  const copyUrl = () => navigator.clipboard?.writeText(location.href);

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
    setResourceCounts({
      ...resourceCounts,
      [template.kind]: nextCount,
    });
    setSelectedResource(resource);
  };

  const submitAiPrompt = () => {
    const currentPrompt = aiPrompt.trim();
    if (roomId === "" || currentPrompt === "") {
      return;
    }

    submitAiPromptRequest({
      roomId,
      prompt: {
        actor: label || "Guest",
        prompt: currentPrompt,
        readModel: editor === null ? emptyReadModel : collectArchitectureReadModel(editor),
      },
    });
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
            <Button disabled={creating} onClick={() => createRoom(void 0)}>
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
            <FieldLabel htmlFor="architect-ai-prompt">Prompt</FieldLabel>
            <Textarea
              id="architect-ai-prompt"
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
          <RoomCanvas label={label} roomId={roomId} />
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
              <Button className="w-fit" disabled={creating} onClick={() => createRoom(void 0)}>
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
