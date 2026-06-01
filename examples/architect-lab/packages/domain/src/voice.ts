import { Schema as S } from "effect";

import { AiToolCall } from "./ai";
import { ArchitectureReadModelInput } from "./architecture";

export const VoiceTranscriptRequest = S.Struct({
  actor: S.optional(S.String),
  transcript: S.String,
});
export type VoiceTranscriptRequest = S.Schema.Type<typeof VoiceTranscriptRequest>;

export const VoiceTranscriptEvent = S.Struct({
  actor: S.String,
  id: S.String,
  roomId: S.String,
  transcript: S.String,
  recordedAt: S.String,
});
export type VoiceTranscriptEvent = S.Schema.Type<typeof VoiceTranscriptEvent>;

export const VoiceSuggestionStatus = S.Literals(["open", "accepted", "rejected"] as const);
export type VoiceSuggestionStatus = S.Schema.Type<typeof VoiceSuggestionStatus>;

export const VoiceSuggestionRequest = S.Struct({
  actor: S.optional(S.String),
  transcript: S.String,
  readModel: ArchitectureReadModelInput,
});
export type VoiceSuggestionRequest = S.Schema.Type<typeof VoiceSuggestionRequest>;

export const VoiceSuggestion = S.Struct({
  actor: S.String,
  createdAt: S.String,
  id: S.String,
  roomId: S.String,
  status: VoiceSuggestionStatus,
  summary: S.String,
  toolCalls: S.Array(AiToolCall),
  transcript: S.String,
});
export type VoiceSuggestion = S.Schema.Type<typeof VoiceSuggestion>;

export const VoiceSuggestionResult = S.Struct({
  roomId: S.String,
  suggestion: VoiceSuggestion,
});
export type VoiceSuggestionResult = S.Schema.Type<typeof VoiceSuggestionResult>;

export const VoiceSuggestionDecisionRequest = S.Struct({
  actor: S.optional(S.String),
  readModel: ArchitectureReadModelInput,
  suggestion: VoiceSuggestion,
});
export type VoiceSuggestionDecisionRequest = S.Schema.Type<typeof VoiceSuggestionDecisionRequest>;

export const VoiceSuggestionDecisionResult = S.Struct({
  roomId: S.String,
  suggestion: VoiceSuggestion,
});
export type VoiceSuggestionDecisionResult = S.Schema.Type<typeof VoiceSuggestionDecisionResult>;

export const makeVoiceTranscriptEvent = (
  roomId: string,
  request: VoiceTranscriptRequest,
  now = new Date(),
): VoiceTranscriptEvent => ({
  actor: request.actor?.trim() || "Guest",
  id: `voice_transcript_${crypto.randomUUID()}`,
  recordedAt: now.toISOString(),
  roomId,
  transcript: request.transcript.trim(),
});
