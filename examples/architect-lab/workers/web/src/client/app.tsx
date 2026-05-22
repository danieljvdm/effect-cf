import { Field } from "@base-ui-components/react/field";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  Archive,
  BrainCircuit,
  CheckCircle2,
  Clipboard,
  ExternalLink,
  LoaderCircle,
  Mic,
  MicOff,
  Network,
  Play,
  Plus,
  Route,
  SearchCheck,
  Sparkles,
  Wrench,
  XCircle,
} from "lucide-react";
import { useEffect } from "react";
import { createShapeId, toRichText, type TLShape } from "tldraw";

import type { AiPromptTraceEvent } from "@architect-lab/domain/ai";
import type {
  ArchitectureReadModelInput,
  ArchitectureResource,
  ArchitectureResourceTemplate,
} from "@architect-lab/domain/architecture";
import type { RoomActivityEvent } from "@architect-lab/domain/contracts";
import type { ExportJobStatus } from "@architect-lab/domain/export";
import { architectureResourceTemplates } from "@architect-lab/domain/resource-templates";
import { toBindingName } from "@architect-lab/domain/snippets";
import type { ArchitectureReviewFinding, TraceState } from "@architect-lab/domain/trace";
import type { VoiceSuggestion, VoiceTranscriptEvent } from "@architect-lab/domain/voice";

import { CodePanel } from "./code-panel";
import { Button } from "./components/ui/button";
import { FieldLabel, FieldRoot } from "./components/ui/field";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { collectArchitectureReadModel } from "./lib/read-model";
import { getPersistentUserId } from "./lib/identity";
import {
  acceptReviewFindingAtom,
  acceptVoiceSuggestionAtom,
  createRoomAtom,
  recordVoiceTranscriptAtom,
  rejectReviewFindingAtom,
  rejectVoiceSuggestionAtom,
  reviewArchitectureAtom,
  saveSemanticReadModelAtom,
  startExportAtom,
  startTraceAtom,
  suggestFromVoiceAtom,
  submitAiPromptAtom,
} from "./api";
import { RoomCanvas } from "./room-canvas";
import { ResourcePalette } from "./resource-palette";
import {
  aiActivityEventsAtom,
  aiPromptAtom,
  architectureReadModelAtom,
  editorAtom,
  exportStatusAtom,
  labelAtom,
  resourceCountsAtom,
  reviewFindingsAtom,
  roomIdAtom,
  saveLabelAtom,
  selectedArchitectureAtom,
  traceStateAtom,
  voiceListeningAtom,
  voiceSuggestionAtom,
  voiceTranscriptEventsAtom,
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
  const selectedArchitecture = useAtomValue(selectedArchitectureAtom);
  const architectureReadModel = useAtomValue(architectureReadModelAtom);
  const aiPrompt = useAtomValue(aiPromptAtom);
  const aiActivityEvents = useAtomValue(aiActivityEventsAtom);
  const traceState = useAtomValue(traceStateAtom);
  const reviewFindings = useAtomValue(reviewFindingsAtom);
  const exportStatus = useAtomValue(exportStatusAtom);
  const voiceListening = useAtomValue(voiceListeningAtom);
  const voiceSuggestion = useAtomValue(voiceSuggestionAtom);
  const voiceTranscriptEvents = useAtomValue(voiceTranscriptEventsAtom);
  const resourceCounts = useAtomValue(resourceCountsAtom);
  const createRoomResult = useAtomValue(createRoomAtom);
  const saveReadModelResult = useAtomValue(saveSemanticReadModelAtom);
  const submitAiPromptResult = useAtomValue(submitAiPromptAtom);
  const startTraceResult = useAtomValue(startTraceAtom);
  const startExportResult = useAtomValue(startExportAtom);
  const reviewArchitectureResult = useAtomValue(reviewArchitectureAtom);
  const acceptReviewFindingResult = useAtomValue(acceptReviewFindingAtom);
  const rejectReviewFindingResult = useAtomValue(rejectReviewFindingAtom);
  const recordVoiceTranscriptResult = useAtomValue(recordVoiceTranscriptAtom);
  const suggestFromVoiceResult = useAtomValue(suggestFromVoiceAtom);
  const acceptVoiceSuggestionResult = useAtomValue(acceptVoiceSuggestionAtom);
  const rejectVoiceSuggestionResult = useAtomValue(rejectVoiceSuggestionAtom);
  const createRoom = useAtomSet(createRoomAtom);
  const submitAiPromptRequest = useAtomSet(submitAiPromptAtom);
  const startTraceRequest = useAtomSet(startTraceAtom);
  const startExportRequest = useAtomSet(startExportAtom);
  const reviewArchitectureRequest = useAtomSet(reviewArchitectureAtom);
  const acceptReviewFindingRequest = useAtomSet(acceptReviewFindingAtom);
  const rejectReviewFindingRequest = useAtomSet(rejectReviewFindingAtom);
  const recordVoiceTranscriptRequest = useAtomSet(recordVoiceTranscriptAtom);
  const suggestFromVoiceRequest = useAtomSet(suggestFromVoiceAtom);
  const acceptVoiceSuggestionRequest = useAtomSet(acceptVoiceSuggestionAtom);
  const rejectVoiceSuggestionRequest = useAtomSet(rejectVoiceSuggestionAtom);
  const saveLabel = useAtomSet(saveLabelAtom);
  const setAiPrompt = useAtomSet(aiPromptAtom);
  const setAiActivityEvents = useAtomSet(aiActivityEventsAtom);
  const setTraceState = useAtomSet(traceStateAtom);
  const setReviewFindings = useAtomSet(reviewFindingsAtom);
  const setExportStatus = useAtomSet(exportStatusAtom);
  const setVoiceListening = useAtomSet(voiceListeningAtom);
  const setVoiceSuggestion = useAtomSet(voiceSuggestionAtom);
  const setVoiceTranscriptEvents = useAtomSet(voiceTranscriptEventsAtom);
  const setSelectedArchitecture = useAtomSet(selectedArchitectureAtom);
  const setResourceCounts = useAtomSet(resourceCountsAtom);

  useEffect(() => {
    if (roomId === "") {
      setAiActivityEvents([]);
      setTraceState(null);
      setReviewFindings([]);
      setExportStatus(null);
      setVoiceSuggestion(null);
      setVoiceTranscriptEvents([]);
      return;
    }

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(`${protocol}//${location.host}/api/rooms/${roomId}/activity/ws`);
    url.searchParams.set("label", label || "Guest");
    url.searchParams.set("userId", getPersistentUserId());
    const socket = new WebSocket(url);
    const events = new Map<number, RoomActivityEvent>();
    const findings = new Map<string, ArchitectureReviewFinding>();
    const transcripts = new Map<string, VoiceTranscriptEvent>();

    setAiActivityEvents([]);
    socket.addEventListener("message", (event) => {
      const message = parseRoomActivityMessage(event.data);
      if (message === null || !isVisibleRoomEvent(message.event.kind)) {
        return;
      }

      const payload = parsePayload(message.event.payloadJson);
      const nextTraceState = readTraceState(payload);
      if (nextTraceState !== null) {
        setTraceState(nextTraceState);
      }
      const nextReviewFindings = readReviewFindings(payload);
      if (nextReviewFindings !== null) {
        findings.clear();
        for (const finding of nextReviewFindings) {
          findings.set(finding.id, finding);
        }
        setReviewFindings(nextReviewFindings);
      }
      const nextReviewFinding = readReviewFinding(payload);
      if (nextReviewFinding !== null) {
        findings.set(nextReviewFinding.id, nextReviewFinding);
        setReviewFindings(Array.from(findings.values()));
      }
      const nextExportStatus = readExportStatus(payload);
      if (nextExportStatus !== null) {
        setExportStatus(nextExportStatus);
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(`architect:export:${roomId}`, nextExportStatus.exportId);
        }
      }
      const nextVoiceTranscript = readVoiceTranscript(payload);
      if (nextVoiceTranscript !== null) {
        transcripts.set(nextVoiceTranscript.id, nextVoiceTranscript);
        setVoiceTranscriptEvents(Array.from(transcripts.values()).slice(-8));
      }
      const nextVoiceSuggestion = readVoiceSuggestion(payload);
      if (nextVoiceSuggestion !== null) {
        setVoiceSuggestion(nextVoiceSuggestion);
      }
      events.set(message.event.sequence, message.event);
      setAiActivityEvents(
        Array.from(events.values())
          .sort((left, right) => left.sequence - right.sequence)
          .slice(-32),
      );
    });

    return () => {
      socket.close(1000, "room changed");
    };
  }, [
    label,
    roomId,
    setAiActivityEvents,
    setExportStatus,
    setReviewFindings,
    setTraceState,
    setVoiceSuggestion,
    setVoiceTranscriptEvents,
  ]);

  useEffect(() => {
    const activeEdgeId = traceState?.activeStep?.edgeId;
    if (editor === null || activeEdgeId === undefined || activeEdgeId === "none") {
      return;
    }

    const activeShape = editor
      .getCurrentPageShapes()
      .find((shape) => getShapeArchitectEdgeId(shape) === activeEdgeId);
    if (activeShape !== undefined) {
      editor.select(activeShape.id);
    }
  }, [editor, traceState]);

  useEffect(() => {
    if (roomId === "" || typeof localStorage === "undefined") {
      return;
    }

    const exportId = localStorage.getItem(`architect:export:${roomId}`);
    if (exportId === null) {
      setExportStatus(null);
      return;
    }

    let cancelled = false;
    void fetchExportStatus(roomId, exportId)
      .then((status) => {
        if (!cancelled) {
          setExportStatus(status);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [roomId, setExportStatus]);

  useEffect(() => {
    if (
      roomId === "" ||
      exportStatus === null ||
      (exportStatus.status !== "queued" && exportStatus.status !== "running")
    ) {
      return;
    }

    let cancelled = false;
    const timer = window.setInterval(() => {
      void fetchExportStatus(roomId, exportStatus.exportId)
        .then((status) => {
          if (!cancelled) {
            setExportStatus(status);
          }
        })
        .catch(() => undefined);
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [exportStatus, roomId, setExportStatus]);

  useEffect(() => {
    if (suggestFromVoiceResult._tag === "Success" && suggestFromVoiceResult.value !== undefined) {
      setVoiceSuggestion(suggestFromVoiceResult.value.suggestion);
    }
  }, [setVoiceSuggestion, suggestFromVoiceResult]);

  const creating = createRoomResult.waiting;
  const readModelStatus = saveReadModelResult.waiting
    ? "saving"
    : saveReadModelResult._tag === "Success"
      ? "saved"
      : saveReadModelResult._tag === "Failure"
        ? "error"
        : "not synced";
  const aiRunning = submitAiPromptResult.waiting;
  const responseTraceEvents =
    submitAiPromptResult._tag === "Success" && submitAiPromptResult.value !== undefined
      ? submitAiPromptResult.value.traceEvents
      : [];
  const aiActivityItems = toAiActivityItems(aiActivityEvents, responseTraceEvents);
  const lastAiActivityItem = aiActivityItems.at(-1);
  const aiStatus = aiRunning
    ? (lastAiActivityItem?.message ?? "Streaming architecture plan")
    : submitAiPromptResult._tag === "Success" && submitAiPromptResult.value !== undefined
      ? submitAiPromptResult.value.summary
      : submitAiPromptResult._tag === "Failure"
        ? "AI prompt failed"
        : (lastAiActivityItem?.message ?? "Fake provider ready");
  const traceRunning = startTraceResult.waiting || traceState?.status === "running";
  const exportRunning =
    startExportResult.waiting ||
    exportStatus?.status === "queued" ||
    exportStatus?.status === "running";
  const reviewRunning = reviewArchitectureResult.waiting;
  const reviewMutating = acceptReviewFindingResult.waiting || rejectReviewFindingResult.waiting;
  const voiceSupported = getSpeechRecognitionConstructor() !== null;
  const voiceSuggesting = suggestFromVoiceResult.waiting;
  const voiceMutating =
    recordVoiceTranscriptResult.waiting ||
    acceptVoiceSuggestionResult.waiting ||
    rejectVoiceSuggestionResult.waiting;

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
    setSelectedArchitecture({ type: "resource", resource });
  };

  const submitAiPrompt = () => {
    const currentPrompt = aiPrompt.trim();
    if (roomId === "" || currentPrompt === "") {
      return;
    }
    const voiceContext = voiceTranscriptEvents
      .slice(-4)
      .map((event) => `${event.actor}: ${event.transcript}`)
      .join("\n");
    const prompt =
      voiceContext === ""
        ? currentPrompt
        : `${currentPrompt}\n\nRecent transcript:\n${voiceContext}`;

    submitAiPromptRequest({
      roomId,
      prompt: {
        actor: label || "Guest",
        prompt,
        readModel: editor === null ? emptyReadModel : collectArchitectureReadModel(editor),
      },
    });
  };

  const currentReadModel = (): ArchitectureReadModelInput =>
    editor === null ? architectureReadModel : collectArchitectureReadModel(editor);

  const simulateTrace = () => {
    if (roomId === "") {
      return;
    }

    startTraceRequest({
      roomId,
      trace: {
        actor: label || "Guest",
        name: "Simulate request",
        readModel: currentReadModel(),
      },
    });
  };

  const reviewArchitecture = () => {
    if (roomId === "") {
      return;
    }

    reviewArchitectureRequest({
      roomId,
      review: {
        actor: label || "Guest",
        readModel: currentReadModel(),
      },
    });
  };

  const startExport = () => {
    if (roomId === "") {
      return;
    }

    startExportRequest({
      roomId,
      exportRequest: {
        actor: label || "Guest",
        readModel: currentReadModel(),
      },
    });
  };

  const acceptReviewFinding = (finding: ArchitectureReviewFinding) => {
    if (roomId === "") {
      return;
    }

    acceptReviewFindingRequest({
      roomId,
      decision: {
        actor: label || "Guest",
        finding,
        readModel: currentReadModel(),
      },
    });
  };

  const rejectReviewFinding = (finding: ArchitectureReviewFinding) => {
    if (roomId === "") {
      return;
    }

    rejectReviewFindingRequest({
      roomId,
      decision: {
        actor: label || "Guest",
        finding,
        readModel: currentReadModel(),
      },
    });
  };

  const startVoiceInput = () => {
    const Recognition = getSpeechRecognitionConstructor();
    if (Recognition === null || roomId === "") {
      return;
    }

    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (transcript === "") {
        return;
      }

      setAiPrompt(transcript);
      recordVoiceTranscriptRequest({
        roomId,
        transcript: {
          actor: label || "Guest",
          transcript,
        },
      });
    };
    recognition.onend = () => setVoiceListening(false);
    recognition.onerror = () => setVoiceListening(false);
    setVoiceListening(true);
    recognition.start();
  };

  const suggestFromVoice = () => {
    if (roomId === "") {
      return;
    }

    const transcript = voiceTranscriptEvents.at(-1)?.transcript ?? aiPrompt.trim();
    if (transcript.trim() === "") {
      return;
    }

    suggestFromVoiceRequest({
      roomId,
      suggestion: {
        actor: label || "Guest",
        readModel: currentReadModel(),
        transcript,
      },
    });
  };

  const acceptVoiceSuggestion = (suggestion: VoiceSuggestion) => {
    if (roomId === "") {
      return;
    }

    setVoiceSuggestion({ ...suggestion, status: "accepted" });
    acceptVoiceSuggestionRequest({
      roomId,
      decision: {
        actor: label || "Guest",
        readModel: currentReadModel(),
        suggestion,
      },
    });
  };

  const rejectVoiceSuggestion = (suggestion: VoiceSuggestion) => {
    if (roomId === "") {
      return;
    }

    const rejected = { ...suggestion, status: "rejected" as const };
    setVoiceSuggestion(rejected);
    rejectVoiceSuggestionRequest({
      roomId,
      decision: {
        actor: label || "Guest",
        readModel: currentReadModel(),
        suggestion,
      },
    });
  };

  return (
    <div className="grid h-screen grid-cols-[320px_minmax(0,1fr)_360px] bg-[#f4f6f8] text-slate-950 max-[900px]:h-auto max-[900px]:min-h-screen max-[900px]:grid-cols-1 max-[900px]:grid-rows-[auto_minmax(620px,1fr)_auto]">
      <aside
        aria-label="Architect Lab room controls"
        className="z-10 grid min-w-0 grid-rows-[auto_auto_auto_1fr_auto] gap-5 overflow-auto border-r border-slate-300 bg-white/95 p-5 max-[900px]:border-b max-[900px]:border-r-0"
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

        <Field.Root aria-label="AI architect" className="grid content-start gap-2.5">
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
            {aiRunning ? "Streaming" : "Run fake architect"}
          </Button>
          <VoicePanel
            disabled={roomId === ""}
            listening={voiceListening}
            mutating={voiceMutating}
            onAcceptSuggestion={acceptVoiceSuggestion}
            onRejectSuggestion={rejectVoiceSuggestion}
            onStartVoice={startVoiceInput}
            onSuggest={suggestFromVoice}
            suggestion={voiceSuggestion}
            suggesting={voiceSuggesting}
            supported={voiceSupported}
            transcripts={voiceTranscriptEvents}
          />
          <AiActivityPanel events={aiActivityItems} running={aiRunning} status={aiStatus} />
        </Field.Root>

        <TraceReviewPanel
          disabled={roomId === "" || architectureReadModel.resources.length === 0}
          onAcceptFinding={acceptReviewFinding}
          onRejectFinding={rejectReviewFinding}
          onReview={reviewArchitecture}
          onTrace={simulateTrace}
          reviewFindings={reviewFindings}
          reviewMutating={reviewMutating}
          reviewRunning={reviewRunning}
          traceRunning={traceRunning}
          traceState={traceState}
        />

        <ExportPanel
          disabled={roomId === "" || architectureReadModel.resources.length === 0}
          exportRunning={exportRunning}
          exportStatus={exportStatus}
          onExport={startExport}
        />

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
          Export packages are generated by Workflows and stored as R2 manifests plus files.
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
        <CodePanel readModel={architectureReadModel} selection={selectedArchitecture} />
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

const VoicePanel = ({
  disabled,
  listening,
  mutating,
  onAcceptSuggestion,
  onRejectSuggestion,
  onStartVoice,
  onSuggest,
  suggestion,
  suggesting,
  supported,
  transcripts,
}: {
  readonly disabled: boolean;
  readonly listening: boolean;
  readonly mutating: boolean;
  readonly onAcceptSuggestion: (suggestion: VoiceSuggestion) => void;
  readonly onRejectSuggestion: (suggestion: VoiceSuggestion) => void;
  readonly onStartVoice: () => void;
  readonly onSuggest: () => void;
  readonly suggestion: VoiceSuggestion | null;
  readonly suggesting: boolean;
  readonly supported: boolean;
  readonly transcripts: ReadonlyArray<VoiceTranscriptEvent>;
}) => (
  <div className="grid gap-2 rounded-md border border-slate-200 bg-slate-50 p-3">
    <div className="grid grid-cols-2 gap-2">
      <Button
        disabled={disabled || listening || !supported}
        onClick={onStartVoice}
        size="sm"
        variant="outline"
      >
        {supported ? (
          <Mic aria-hidden="true" className="size-3.5" />
        ) : (
          <MicOff aria-hidden="true" className="size-3.5" />
        )}
        {listening ? "Listening" : "Dictate"}
      </Button>
      <Button disabled={disabled || suggesting} onClick={onSuggest} size="sm" variant="outline">
        {suggesting ? (
          <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
        ) : (
          <Sparkles aria-hidden="true" className="size-3.5" />
        )}
        Suggest
      </Button>
    </div>
    {transcripts.length > 0 ? (
      <ol className="grid max-h-20 gap-1 overflow-auto" aria-label="Voice transcript">
        {transcripts.slice(-3).map((event) => (
          <li className="truncate text-xs leading-5 text-slate-600" key={event.id}>
            {event.actor}: {event.transcript}
          </li>
        ))}
      </ol>
    ) : null}
    {suggestion !== null ? (
      <div className="grid gap-2 rounded border border-slate-200 bg-white p-2">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 text-xs font-bold leading-5 text-slate-950">{suggestion.summary}</p>
          <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold uppercase text-slate-600">
            {suggestion.status}
          </span>
        </div>
        <p className="text-xs leading-5 text-slate-600">
          {suggestion.toolCalls.length} proposed edit
          {suggestion.toolCalls.length === 1 ? "" : "s"}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button
            disabled={suggestion.status !== "open" || mutating}
            onClick={() => onAcceptSuggestion(suggestion)}
            size="sm"
            variant="outline"
          >
            <CheckCircle2 aria-hidden="true" className="size-3.5" />
            Accept
          </Button>
          <Button
            disabled={suggestion.status !== "open" || mutating}
            onClick={() => onRejectSuggestion(suggestion)}
            size="sm"
            variant="outline"
          >
            <XCircle aria-hidden="true" className="size-3.5" />
            Reject
          </Button>
        </div>
      </div>
    ) : null}
  </div>
);

const ExportPanel = ({
  disabled,
  exportRunning,
  exportStatus,
  onExport,
}: {
  readonly disabled: boolean;
  readonly exportRunning: boolean;
  readonly exportStatus: ExportJobStatus | null;
  readonly onExport: () => void;
}) => (
  <section className="grid content-start gap-3" aria-label="Export package">
    <div className="flex items-center gap-2">
      <Archive aria-hidden="true" className="size-4 text-teal-700" />
      <h2 className="text-xs font-bold uppercase tracking-wider text-slate-600">Export</h2>
    </div>
    <Button disabled={disabled || exportRunning} onClick={onExport} variant="outline">
      {exportRunning ? (
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
      ) : (
        <Archive aria-hidden="true" className="size-4" />
      )}
      {exportRunning ? "Exporting" : "Export starter"}
    </Button>
    {exportStatus === null ? (
      <p className="text-xs leading-5 text-slate-600">No package export has run in this room.</p>
    ) : (
      <div className="grid gap-2 rounded-md border border-slate-200 bg-slate-50 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-sm font-bold text-slate-950">
            {exportStatus.message}
          </p>
          <span className="shrink-0 rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-bold uppercase text-slate-600">
            {exportStatus.status}
          </span>
        </div>
        <StatusRow label="Files" value={String(exportStatus.artifactCount)} />
        {exportStatus.manifestUrl !== undefined && exportStatus.status === "completed" ? (
          <a
            className="inline-flex min-w-0 items-center gap-2 text-sm font-bold text-teal-700 underline-offset-4 hover:underline"
            href={exportStatus.manifestUrl}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink aria-hidden="true" className="size-4 shrink-0" />
            <span className="truncate">Open manifest</span>
          </a>
        ) : null}
      </div>
    )}
  </section>
);

const TraceReviewPanel = ({
  disabled,
  onAcceptFinding,
  onRejectFinding,
  onReview,
  onTrace,
  reviewFindings,
  reviewMutating,
  reviewRunning,
  traceRunning,
  traceState,
}: {
  readonly disabled: boolean;
  readonly onAcceptFinding: (finding: ArchitectureReviewFinding) => void;
  readonly onRejectFinding: (finding: ArchitectureReviewFinding) => void;
  readonly onReview: () => void;
  readonly onTrace: () => void;
  readonly reviewFindings: ReadonlyArray<ArchitectureReviewFinding>;
  readonly reviewMutating: boolean;
  readonly reviewRunning: boolean;
  readonly traceRunning: boolean;
  readonly traceState: TraceState | null;
}) => (
  <section className="grid content-start gap-3" aria-label="Trace and review">
    <div className="flex items-center gap-2">
      <Route aria-hidden="true" className="size-4 text-teal-700" />
      <h2 className="text-xs font-bold uppercase tracking-wider text-slate-600">Trace & review</h2>
    </div>
    <div className="grid grid-cols-2 gap-2">
      <Button disabled={disabled || traceRunning} onClick={onTrace} variant="outline">
        {traceRunning ? (
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
        ) : (
          <Route aria-hidden="true" className="size-4" />
        )}
        {traceRunning ? "Tracing" : "Trace"}
      </Button>
      <Button disabled={disabled || reviewRunning} onClick={onReview} variant="outline">
        {reviewRunning ? (
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
        ) : (
          <SearchCheck aria-hidden="true" className="size-4" />
        )}
        {reviewRunning ? "Reviewing" : "Review"}
      </Button>
    </div>

    <div className="grid gap-2 rounded-md border border-slate-200 bg-slate-50 p-3">
      <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Active trace</p>
      {traceState?.activeStep === undefined ? (
        <p className="text-xs leading-5 text-slate-600">No trace has run in this room yet.</p>
      ) : (
        <div className="grid gap-1">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-sm font-bold text-slate-950">
              {traceState.activeStep.title}
            </p>
            <span className="shrink-0 rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-bold uppercase text-slate-600">
              {traceState.status}
            </span>
          </div>
          <p className="text-xs leading-5 text-slate-600">{traceState.activeStep.description}</p>
          <code className="block overflow-hidden text-ellipsis rounded bg-white px-2 py-1 text-[11px] leading-5 text-slate-700">
            {traceState.activeStep.dataShape}
          </code>
        </div>
      )}
    </div>

    {reviewFindings.length > 0 ? (
      <ol className="grid max-h-56 gap-2 overflow-auto" aria-label="Architecture review findings">
        {reviewFindings.map((finding) => (
          <li
            className="grid gap-2 rounded-md border border-slate-200 bg-white p-2"
            key={finding.id}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 text-xs font-bold leading-5 text-slate-950">{finding.issue}</p>
              <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold uppercase text-slate-600">
                {finding.severity}
              </span>
            </div>
            <p className="text-xs leading-5 text-slate-600">{finding.recommendation}</p>
            <div className="grid grid-cols-2 gap-2">
              <Button
                disabled={finding.status !== "open" || reviewMutating}
                onClick={() => onAcceptFinding(finding)}
                size="sm"
                variant="outline"
              >
                <CheckCircle2 aria-hidden="true" className="size-3.5" />
                Accept
              </Button>
              <Button
                disabled={finding.status !== "open" || reviewMutating}
                onClick={() => onRejectFinding(finding)}
                size="sm"
                variant="outline"
              >
                <XCircle aria-hidden="true" className="size-3.5" />
                Reject
              </Button>
            </div>
          </li>
        ))}
      </ol>
    ) : null}
  </section>
);

type AiActivityItem = {
  readonly kind: AiPromptTraceEvent["kind"] | "export" | "review" | "status" | "trace" | "voice";
  readonly message: string;
  readonly detail?: string | undefined;
  readonly sequence?: number | undefined;
};

const runningAiEvents: ReadonlyArray<AiActivityItem> = [
  {
    kind: "reasoning",
    message: "Reading canvas state and choosing Cloudflare primitives",
  },
  {
    kind: "tool-call",
    message: "Applying accepted tool calls through the room authority",
    detail: "streaming",
  },
];

const AiActivityPanel = ({
  events,
  running,
  status,
}: {
  readonly events: ReadonlyArray<AiActivityItem>;
  readonly running: boolean;
  readonly status: string;
}) => {
  const visibleEvents = running && events.length === 0 ? runningAiEvents : events.slice(-8);

  return (
    <div className="grid gap-2 rounded-md border border-slate-900 bg-slate-950 p-3 text-slate-100 shadow-[0_10px_24px_rgba(15,23,42,0.24)]">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <p className="min-w-0 text-sm font-bold leading-5 text-white">{status}</p>
        {running ? (
          <span className="mt-0.5 inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-teal-300 shadow-[0_0_0_4px_rgba(94,234,212,0.14)]" />
        ) : (
          <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-teal-300" />
        )}
      </div>

      {visibleEvents.length > 0 ? (
        <ol className="grid gap-1.5" aria-label="AI activity">
          {visibleEvents.map((event, index) => (
            <li
              className="grid grid-cols-[18px_minmax(0,1fr)] gap-2 rounded border border-white/10 bg-white/[0.04] px-2 py-1.5"
              key={`${event.kind}-${event.message}-${index}`}
            >
              <AiActivityIcon
                event={event}
                running={running && index === visibleEvents.length - 1}
              />
              <div className="min-w-0">
                <p className="truncate text-xs font-bold leading-4 text-slate-100">
                  {event.message}
                </p>
                {event.detail !== undefined ? (
                  <p className="truncate text-[11px] leading-4 text-slate-400">{event.detail}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs leading-5 text-slate-400">No AI run in this room yet.</p>
      )}
    </div>
  );
};

const AiActivityIcon = ({
  event,
  running,
}: {
  readonly event: AiActivityItem;
  readonly running: boolean;
}) => {
  const className = running
    ? "mt-0.5 size-4 animate-pulse text-teal-300"
    : "mt-0.5 size-4 text-slate-400";

  switch (event.kind) {
    case "status":
      return <Sparkles aria-hidden="true" className={className} />;
    case "trace":
      return <Route aria-hidden="true" className={className} />;
    case "export":
      return <Archive aria-hidden="true" className={className} />;
    case "review":
      return <SearchCheck aria-hidden="true" className={className} />;
    case "voice":
      return <Mic aria-hidden="true" className={className} />;
    case "reasoning":
      return <BrainCircuit aria-hidden="true" className={className} />;
    case "tool-call":
      return <Wrench aria-hidden="true" className={className} />;
    case "completion":
      return <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 text-teal-300" />;
  }
};

const parseRoomActivityMessage = (
  value: unknown,
): { readonly event: RoomActivityEvent; readonly type: string } | null => {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const message = JSON.parse(value) as {
      readonly event?: RoomActivityEvent;
      readonly type?: string;
    };
    return message.type === "room.activity.event" && message.event !== undefined
      ? { type: message.type, event: message.event }
      : null;
  } catch {
    return null;
  }
};

const isVisibleRoomEvent = (kind: string): boolean =>
  kind.startsWith("ai.") ||
  kind.startsWith("trace.") ||
  kind.startsWith("review.") ||
  kind.startsWith("export.") ||
  kind.startsWith("voice.");

const toAiActivityItems = (
  roomEvents: ReadonlyArray<RoomActivityEvent>,
  fallbackTraceEvents: ReadonlyArray<AiPromptTraceEvent>,
): ReadonlyArray<AiActivityItem> => {
  const items = roomEvents.flatMap((event): ReadonlyArray<AiActivityItem> => {
    const payload = parsePayload(event.payloadJson);
    const detail = typeof payload.detail === "string" ? payload.detail : undefined;

    if (
      event.kind === "ai.reasoning" ||
      event.kind === "ai.tool-call" ||
      event.kind === "ai.completion"
    ) {
      return [
        {
          kind: event.kind.slice("ai.".length) as AiPromptTraceEvent["kind"],
          message: typeof payload.message === "string" ? payload.message : event.kind,
          detail: withActor(event.actor, detail),
          sequence: event.sequence,
        },
      ];
    }

    if (event.kind === "ai.prompt.submitted") {
      return [
        {
          kind: "status",
          message: "Prompt submitted",
          detail: withActor(
            event.actor,
            typeof payload.prompt === "string" ? payload.prompt : undefined,
          ),
          sequence: event.sequence,
        },
      ];
    }

    if (event.kind === "ai.tool-calls.applied") {
      const count = typeof payload.toolCalls === "number" ? payload.toolCalls : 0;
      return [
        {
          kind: "tool-call",
          message: `Applied ${count} accepted tool call${count === 1 ? "" : "s"}`,
          detail: withActor(
            event.actor,
            Array.isArray(payload.toolCallTypes) ? payload.toolCallTypes.join(", ") : undefined,
          ),
          sequence: event.sequence,
        },
      ];
    }

    if (event.kind === "ai.job.queued") {
      return [
        {
          kind: "status",
          message: "Queued async AI job",
          detail: withActor(
            event.actor,
            typeof payload.summary === "string" ? payload.summary : undefined,
          ),
          sequence: event.sequence,
        },
      ];
    }

    if (event.kind === "ai.tool-calls.generated") {
      return [
        {
          kind: "status",
          message: "Generated tool-call batch",
          detail: withActor(
            event.actor,
            typeof payload.summary === "string" ? payload.summary : undefined,
          ),
          sequence: event.sequence,
        },
      ];
    }

    if (event.kind === "trace.started" || event.kind === "trace.step") {
      const state = readTraceState(payload);
      return [
        {
          kind: "trace",
          message: state?.activeStep?.title ?? "Trace started",
          detail: withActor(event.actor, state?.activeStep?.dataShape),
          sequence: event.sequence,
        },
      ];
    }

    if (event.kind === "trace.completed") {
      const state = readTraceState(payload);
      return [
        {
          kind: "trace",
          message: "Trace completed",
          detail: withActor(event.actor, state?.traceName),
          sequence: event.sequence,
        },
      ];
    }

    if (event.kind === "review.findings.generated") {
      const count = typeof payload.count === "number" ? payload.count : 0;
      return [
        {
          kind: "review",
          message: `Review found ${count} item${count === 1 ? "" : "s"}`,
          detail: event.actor,
          sequence: event.sequence,
        },
      ];
    }

    if (event.kind === "review.finding.accepted" || event.kind === "review.finding.rejected") {
      const finding = readReviewFinding(payload);
      return [
        {
          kind: "review",
          message:
            event.kind === "review.finding.accepted"
              ? "Accepted review finding"
              : "Rejected review finding",
          detail: withActor(event.actor, finding?.issue),
          sequence: event.sequence,
        },
      ];
    }

    if (event.kind.startsWith("export.")) {
      const status = readExportStatus(payload);
      return [
        {
          kind: "export",
          message: status?.message ?? "Export status changed",
          detail: withActor(event.actor, status?.status),
          sequence: event.sequence,
        },
      ];
    }

    if (event.kind === "voice.transcript.recorded") {
      const transcript = readVoiceTranscript(payload);
      return [
        {
          kind: "voice",
          message: "Voice transcript recorded",
          detail: withActor(event.actor, transcript?.transcript),
          sequence: event.sequence,
        },
      ];
    }

    if (event.kind.startsWith("voice.suggestion.")) {
      const suggestion = readVoiceSuggestion(payload);
      return [
        {
          kind: "voice",
          message:
            event.kind === "voice.suggestion.created"
              ? "Voice suggestion ready"
              : event.kind === "voice.suggestion.accepted"
                ? "Accepted voice suggestion"
                : "Rejected voice suggestion",
          detail: withActor(event.actor, suggestion?.status),
          sequence: event.sequence,
        },
      ];
    }

    return [];
  });

  return items.length > 0 ? items : fallbackTraceEvents;
};

const parsePayload = (payloadJson: string): Record<string, unknown> => {
  try {
    const payload = JSON.parse(payloadJson);
    return typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? payload
      : {};
  } catch {
    return {};
  }
};

const readTraceState = (payload: Record<string, unknown>): TraceState | null => {
  const state = payload.state;
  return isRecord(state) &&
    typeof state.roomId === "string" &&
    typeof state.traceId === "string" &&
    typeof state.traceName === "string"
    ? (state as TraceState)
    : null;
};

const readReviewFindings = (
  payload: Record<string, unknown>,
): ReadonlyArray<ArchitectureReviewFinding> | null =>
  Array.isArray(payload.findings) ? (payload.findings as Array<ArchitectureReviewFinding>) : null;

const readReviewFinding = (payload: Record<string, unknown>): ArchitectureReviewFinding | null => {
  const finding = payload.finding;
  return isRecord(finding) && typeof finding.id === "string"
    ? (finding as ArchitectureReviewFinding)
    : null;
};

const readExportStatus = (payload: Record<string, unknown>): ExportJobStatus | null => {
  const status = payload.status;
  return isRecord(status) &&
    typeof status.exportId === "string" &&
    typeof status.roomId === "string" &&
    typeof status.status === "string"
    ? (status as ExportJobStatus)
    : null;
};

const readVoiceTranscript = (payload: Record<string, unknown>): VoiceTranscriptEvent | null => {
  const transcript = payload.transcript;
  return isRecord(transcript) &&
    typeof transcript.id === "string" &&
    typeof transcript.transcript === "string"
    ? (transcript as VoiceTranscriptEvent)
    : null;
};

const readVoiceSuggestion = (payload: Record<string, unknown>): VoiceSuggestion | null => {
  const suggestion = payload.suggestion;
  return isRecord(suggestion) && typeof suggestion.id === "string"
    ? (suggestion as VoiceSuggestion)
    : null;
};

const fetchExportStatus = async (
  roomId: string,
  exportId: string,
): Promise<ExportJobStatus | null> => {
  const response = await fetch(`/api/rooms/${roomId}/exports/${exportId}`);
  if (!response.ok) {
    return null;
  }

  return (await response.json()) as ExportJobStatus;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getShapeArchitectEdgeId = (shape: TLShape): string | undefined => {
  const architectEdge = shape.meta.architectEdge;
  return isRecord(architectEdge) && typeof architectEdge.id === "string"
    ? architectEdge.id
    : undefined;
};

const withActor = (actor: string, detail: string | undefined): string =>
  detail === undefined || detail === "" ? actor : `${actor} - ${detail}`;

interface BrowserSpeechRecognitionEvent {
  readonly results: ArrayLike<ArrayLike<{ readonly transcript: string }>>;
}

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  start(): void;
}

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

const getSpeechRecognitionConstructor = (): BrowserSpeechRecognitionConstructor | null => {
  const windowWithSpeech = window as typeof window & {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  };

  return windowWithSpeech.SpeechRecognition ?? windowWithSpeech.webkitSpeechRecognition ?? null;
};
