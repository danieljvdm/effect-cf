import { Atom } from "effect/unstable/reactivity";
import type { Editor } from "tldraw";

import type { RoomActivityEvent } from "@architect-lab/domain/contracts";
import type { ArchitectureReadModelInput } from "@architect-lab/domain/architecture";
import type { ExportJobStatus } from "@architect-lab/domain/export";
import type { ArchitectureReviewFinding, TraceState } from "@architect-lab/domain/trace";
import type { VoiceSuggestion, VoiceTranscriptEvent } from "@architect-lab/domain/voice";

import { getInitialRoomId, randomLabel } from "./lib/identity";
import type { ArchitectureSelection } from "./lib/read-model";

const getStoredLabel = () =>
  typeof localStorage === "undefined"
    ? randomLabel()
    : (localStorage.getItem("architect:label") ?? randomLabel());

export const roomIdAtom = Atom.make<string>(getInitialRoomId()).pipe(Atom.keepAlive);
export const labelAtom = Atom.make<string>(getStoredLabel()).pipe(Atom.keepAlive);
export const editorAtom = Atom.make<Editor | null>(null);
export const selectedArchitectureAtom = Atom.make<ArchitectureSelection | null>(null);
export const architectureReadModelAtom = Atom.make<ArchitectureReadModelInput>({
  edges: [],
  resources: [],
});
export const resourceCountsAtom = Atom.make<Record<string, number>>({});
export const aiPromptAtom = Atom.make("Draw an AI architecture canvas").pipe(Atom.keepAlive);
export const aiActivityEventsAtom = Atom.make<ReadonlyArray<RoomActivityEvent>>([]).pipe(
  Atom.keepAlive,
);
export const traceStateAtom = Atom.make<TraceState | null>(null).pipe(Atom.keepAlive);
export const reviewFindingsAtom = Atom.make<ReadonlyArray<ArchitectureReviewFinding>>([]).pipe(
  Atom.keepAlive,
);
export const exportStatusAtom = Atom.make<ExportJobStatus | null>(null).pipe(Atom.keepAlive);
export const voiceTranscriptEventsAtom = Atom.make<ReadonlyArray<VoiceTranscriptEvent>>([]).pipe(
  Atom.keepAlive,
);
export const voiceSuggestionAtom = Atom.make<VoiceSuggestion | null>(null).pipe(Atom.keepAlive);
export const voiceListeningAtom = Atom.make(false);

export const saveLabelAtom = Atom.fnSync<string>()((value, get) => {
  get.set(labelAtom, value);
  if (typeof localStorage !== "undefined") {
    localStorage.setItem("architect:label", value);
  }
}).pipe(Atom.keepAlive);
