import { Schema as S } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";

import { AiPromptRequest, AiPromptResult } from "./ai";
import {
  ArchitectureReadModel,
  ArchitectureReadModelInput,
  PublishedArchitectureReadModel,
} from "./architecture";
import { ApiHealth, CreateRoomResult, RoomHealth } from "./contracts";

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
