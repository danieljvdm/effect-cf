import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { AtomHttpApi } from "effect/unstable/reactivity";

import type { AiPromptRequest } from "@architect-lab/domain/ai";
import type { ArchitectureReadModelInput } from "@architect-lab/domain/architecture";
import type { ExportStartRequest } from "@architect-lab/domain/export";
import { ArchitectHttpApi } from "@architect-lab/domain/http-api";
import type {
  ArchitectureReviewRequest,
  ReviewFindingDecisionRequest,
  TraceStartRequest,
} from "@architect-lab/domain/trace";
import type {
  VoiceSuggestionDecisionRequest,
  VoiceSuggestionRequest,
  VoiceTranscriptRequest,
} from "@architect-lab/domain/voice";

import { exportStatusAtom, roomIdAtom } from "./state";

const ArchitectClient = AtomHttpApi.Service()("ArchitectClient", {
  api: ArchitectHttpApi,
  httpClient: FetchHttpClient.layer,
});

const createRoomRequestAtom = ArchitectClient.mutation("api", "createRoom");
const saveReadModelRequestAtom = ArchitectClient.mutation("api", "saveReadModel");
const submitAiPromptRequestAtom = ArchitectClient.mutation("api", "submitAiPrompt");
const startTraceRequestAtom = ArchitectClient.mutation("api", "startTrace");
const reviewArchitectureRequestAtom = ArchitectClient.mutation("api", "reviewArchitecture");
const acceptReviewFindingRequestAtom = ArchitectClient.mutation("api", "acceptReviewFinding");
const rejectReviewFindingRequestAtom = ArchitectClient.mutation("api", "rejectReviewFinding");
const startExportRequestAtom = ArchitectClient.mutation("api", "startExport");
const recordVoiceTranscriptRequestAtom = ArchitectClient.mutation("api", "recordVoiceTranscript");
const suggestFromVoiceRequestAtom = ArchitectClient.mutation("api", "suggestFromVoice");
const acceptVoiceSuggestionRequestAtom = ArchitectClient.mutation("api", "acceptVoiceSuggestion");
const rejectVoiceSuggestionRequestAtom = ArchitectClient.mutation("api", "rejectVoiceSuggestion");

export const createRoomAtom = ArchitectClient.runtime.fn<void>()(
  Effect.fn("ArchitectWebApi.createRoomAtom")(function* (_, get) {
    const room = yield* get.setResult(createRoomRequestAtom, {});

    yield* Effect.sync(() => {
      history.pushState(null, "", `/room/${room.roomId}`);
      get.set(roomIdAtom, room.roomId);
    });

    return room;
  }),
);

export interface SaveSemanticReadModelArgs {
  readonly readModel: ArchitectureReadModelInput;
  readonly roomId: string;
}

export const saveSemanticReadModelAtom = ArchitectClient.runtime.fn<SaveSemanticReadModelArgs>()(
  Effect.fn("ArchitectWebApi.saveSemanticReadModelAtom")(function* ({ readModel, roomId }, get) {
    if (roomId === "") {
      return undefined;
    }

    return yield* get.setResult(saveReadModelRequestAtom, {
      params: { roomId },
      payload: readModel,
    });
  }),
);

export interface SubmitAiPromptArgs {
  readonly prompt: AiPromptRequest;
  readonly roomId: string;
}

export const submitAiPromptAtom = ArchitectClient.runtime.fn<SubmitAiPromptArgs>()(
  Effect.fn("ArchitectWebApi.submitAiPromptAtom")(function* ({ prompt, roomId }, get) {
    if (roomId === "" || prompt.prompt.trim() === "") {
      return undefined;
    }

    return yield* get.setResult(submitAiPromptRequestAtom, {
      params: { roomId },
      payload: prompt,
    });
  }),
);

export interface StartTraceArgs {
  readonly roomId: string;
  readonly trace: TraceStartRequest;
}

export const startTraceAtom = ArchitectClient.runtime.fn<StartTraceArgs>()(
  Effect.fn("ArchitectWebApi.startTraceAtom")(function* ({ roomId, trace }, get) {
    if (roomId === "") {
      return undefined;
    }

    return yield* get.setResult(startTraceRequestAtom, {
      params: { roomId },
      payload: trace,
    });
  }),
);

export interface ReviewArchitectureArgs {
  readonly roomId: string;
  readonly review: ArchitectureReviewRequest;
}

export const reviewArchitectureAtom = ArchitectClient.runtime.fn<ReviewArchitectureArgs>()(
  Effect.fn("ArchitectWebApi.reviewArchitectureAtom")(function* ({ roomId, review }, get) {
    if (roomId === "") {
      return undefined;
    }

    return yield* get.setResult(reviewArchitectureRequestAtom, {
      params: { roomId },
      payload: review,
    });
  }),
);

export interface ReviewFindingDecisionArgs {
  readonly roomId: string;
  readonly decision: ReviewFindingDecisionRequest;
}

export const acceptReviewFindingAtom = ArchitectClient.runtime.fn<ReviewFindingDecisionArgs>()(
  Effect.fn("ArchitectWebApi.acceptReviewFindingAtom")(function* ({ roomId, decision }, get) {
    if (roomId === "") {
      return undefined;
    }

    return yield* get.setResult(acceptReviewFindingRequestAtom, {
      params: { roomId },
      payload: decision,
    });
  }),
);

export const rejectReviewFindingAtom = ArchitectClient.runtime.fn<ReviewFindingDecisionArgs>()(
  Effect.fn("ArchitectWebApi.rejectReviewFindingAtom")(function* ({ roomId, decision }, get) {
    if (roomId === "") {
      return undefined;
    }

    return yield* get.setResult(rejectReviewFindingRequestAtom, {
      params: { roomId },
      payload: decision,
    });
  }),
);

export interface StartExportArgs {
  readonly exportRequest: ExportStartRequest;
  readonly roomId: string;
}

export const startExportAtom = ArchitectClient.runtime.fn<StartExportArgs>()(
  Effect.fn("ArchitectWebApi.startExportAtom")(function* ({ exportRequest, roomId }, get) {
    if (roomId === "") {
      return undefined;
    }

    const status = yield* get.setResult(startExportRequestAtom, {
      params: { roomId },
      payload: exportRequest,
    });

    yield* Effect.sync(() => {
      get.set(exportStatusAtom, status);
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(`architect:export:${roomId}`, status.exportId);
      }
    });

    return status;
  }),
);

export interface RecordVoiceTranscriptArgs {
  readonly roomId: string;
  readonly transcript: VoiceTranscriptRequest;
}

export const recordVoiceTranscriptAtom = ArchitectClient.runtime.fn<RecordVoiceTranscriptArgs>()(
  Effect.fn("ArchitectWebApi.recordVoiceTranscriptAtom")(function* ({ roomId, transcript }, get) {
    if (roomId === "" || transcript.transcript.trim() === "") {
      return undefined;
    }

    return yield* get.setResult(recordVoiceTranscriptRequestAtom, {
      params: { roomId },
      payload: transcript,
    });
  }),
);

export interface SuggestFromVoiceArgs {
  readonly roomId: string;
  readonly suggestion: VoiceSuggestionRequest;
}

export const suggestFromVoiceAtom = ArchitectClient.runtime.fn<SuggestFromVoiceArgs>()(
  Effect.fn("ArchitectWebApi.suggestFromVoiceAtom")(function* ({ roomId, suggestion }, get) {
    if (roomId === "" || suggestion.transcript.trim() === "") {
      return undefined;
    }

    return yield* get.setResult(suggestFromVoiceRequestAtom, {
      params: { roomId },
      payload: suggestion,
    });
  }),
);

export interface VoiceSuggestionDecisionArgs {
  readonly decision: VoiceSuggestionDecisionRequest;
  readonly roomId: string;
}

export const acceptVoiceSuggestionAtom = ArchitectClient.runtime.fn<VoiceSuggestionDecisionArgs>()(
  Effect.fn("ArchitectWebApi.acceptVoiceSuggestionAtom")(function* ({ decision, roomId }, get) {
    if (roomId === "") {
      return undefined;
    }

    return yield* get.setResult(acceptVoiceSuggestionRequestAtom, {
      params: { roomId },
      payload: decision,
    });
  }),
);

export const rejectVoiceSuggestionAtom = ArchitectClient.runtime.fn<VoiceSuggestionDecisionArgs>()(
  Effect.fn("ArchitectWebApi.rejectVoiceSuggestionAtom")(function* ({ decision, roomId }, get) {
    if (roomId === "") {
      return undefined;
    }

    return yield* get.setResult(rejectVoiceSuggestionRequestAtom, {
      params: { roomId },
      payload: decision,
    });
  }),
);
