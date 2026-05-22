import { Schema as S } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";

import { AiPromptRequest, AiPromptResult } from "./ai";
import {
  ArchitectureReadModel,
  ArchitectureReadModelInput,
  PublishedArchitectureReadModel,
} from "./architecture";
import { ApiHealth, CreateRoomResult, RoomHealth } from "./contracts";
import { ExportJobStatus, ExportManifest, ExportStartRequest } from "./export";
import {
  ArchitectureReviewRequest,
  ArchitectureReviewResult,
  ReviewFindingDecisionRequest,
  ReviewFindingDecisionResult,
  TraceStartRequest,
  TraceState,
} from "./trace";
import {
  VoiceSuggestionDecisionRequest,
  VoiceSuggestionDecisionResult,
  VoiceSuggestionRequest,
  VoiceSuggestionResult,
  VoiceTranscriptEvent,
  VoiceTranscriptRequest,
} from "./voice";

const RoomParams = {
  roomId: S.String,
};

const PublishedParams = {
  shareSlug: S.String,
};

export const PublishedArchitectureResult = S.Struct({
  shareSlug: S.String,
  roomId: S.String,
  publishedAt: S.String,
  model: ArchitectureReadModel,
  shareUrl: S.String,
});
export type PublishedArchitectureResult = S.Schema.Type<typeof PublishedArchitectureResult>;

export const ApiNotFound = S.Struct({
  error: S.String,
}).pipe(HttpApiSchema.status(404));
export type ApiNotFound = S.Schema.Type<typeof ApiNotFound>;

export const ArchitectHttpApi = HttpApi.make("ArchitectHttpApi").add(
  HttpApiGroup.make("api").add(
    HttpApiEndpoint.get("health", "/api/health", {
      success: ApiHealth,
    }),
    HttpApiEndpoint.post("createRoom", "/api/rooms", {
      success: CreateRoomResult.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.get("getReadModel", "/api/rooms/:roomId/read-model", {
      params: RoomParams,
      success: ArchitectureReadModel,
    }),
    HttpApiEndpoint.put("saveReadModel", "/api/rooms/:roomId/read-model", {
      params: RoomParams,
      payload: ArchitectureReadModelInput,
      success: ArchitectureReadModel,
    }),
    HttpApiEndpoint.post("publishReadModel", "/api/rooms/:roomId/publish", {
      params: RoomParams,
      success: PublishedArchitectureResult.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.post("submitAiPrompt", "/api/rooms/:roomId/ai/prompts", {
      params: RoomParams,
      payload: AiPromptRequest,
      success: AiPromptResult.pipe(HttpApiSchema.status(202)),
    }),
    HttpApiEndpoint.post("startTrace", "/api/rooms/:roomId/traces/start", {
      params: RoomParams,
      payload: TraceStartRequest,
      success: TraceState.pipe(HttpApiSchema.status(202)),
    }),
    HttpApiEndpoint.post("reviewArchitecture", "/api/rooms/:roomId/reviews", {
      params: RoomParams,
      payload: ArchitectureReviewRequest,
      success: ArchitectureReviewResult.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.post("acceptReviewFinding", "/api/rooms/:roomId/reviews/accept", {
      params: RoomParams,
      payload: ReviewFindingDecisionRequest,
      success: AiPromptResult.pipe(HttpApiSchema.status(202)),
    }),
    HttpApiEndpoint.post("rejectReviewFinding", "/api/rooms/:roomId/reviews/reject", {
      params: RoomParams,
      payload: ReviewFindingDecisionRequest,
      success: ReviewFindingDecisionResult,
    }),
    HttpApiEndpoint.post("startExport", "/api/rooms/:roomId/exports", {
      params: RoomParams,
      payload: ExportStartRequest,
      success: ExportJobStatus.pipe(HttpApiSchema.status(202)),
    }),
    HttpApiEndpoint.get("getExportStatus", "/api/rooms/:roomId/exports/:exportId", {
      params: {
        roomId: S.String,
        exportId: S.String,
      },
      success: ExportJobStatus,
      error: ApiNotFound,
    }),
    HttpApiEndpoint.get("getExportManifest", "/api/rooms/:roomId/exports/:exportId/manifest", {
      params: {
        roomId: S.String,
        exportId: S.String,
      },
      success: ExportManifest,
      error: ApiNotFound,
    }),
    HttpApiEndpoint.post("recordVoiceTranscript", "/api/rooms/:roomId/voice/transcripts", {
      params: RoomParams,
      payload: VoiceTranscriptRequest,
      success: VoiceTranscriptEvent.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.post("suggestFromVoice", "/api/rooms/:roomId/voice/suggestions", {
      params: RoomParams,
      payload: VoiceSuggestionRequest,
      success: VoiceSuggestionResult.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.post("acceptVoiceSuggestion", "/api/rooms/:roomId/voice/suggestions/accept", {
      params: RoomParams,
      payload: VoiceSuggestionDecisionRequest,
      success: AiPromptResult.pipe(HttpApiSchema.status(202)),
    }),
    HttpApiEndpoint.post("rejectVoiceSuggestion", "/api/rooms/:roomId/voice/suggestions/reject", {
      params: RoomParams,
      payload: VoiceSuggestionDecisionRequest,
      success: VoiceSuggestionDecisionResult,
    }),
    HttpApiEndpoint.get("getPublishedReadModel", "/api/published/:shareSlug", {
      params: PublishedParams,
      success: PublishedArchitectureReadModel,
      error: ApiNotFound,
    }),
    HttpApiEndpoint.get("roomHealth", "/api/rooms/:roomId/health", {
      params: RoomParams,
      success: RoomHealth,
    }),
  ),
);
