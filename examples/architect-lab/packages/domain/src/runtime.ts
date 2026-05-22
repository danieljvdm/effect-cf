import { Config, Schema as S } from "effect";
import { DurableObject, Kv, Queue, Worker, WorkerConfig } from "effect-cf";

import { AiJob } from "./ai.js";
import { ArchitectureReadModel, PublishedArchitectureReadModel } from "./architecture.js";

import {
  ApiHealth,
  CreateRoomResult,
  RoomHealth,
  RoomId,
  RoomMetadata,
  TransportEventInput,
  TransportEventReceipt,
} from "./contracts.js";

export const ArchitectConfig = Config.all({
  publicOrigin: WorkerConfig.string("ARCHITECT_PUBLIC_ORIGIN").pipe(
    Config.withDefault("http://localhost:8787"),
  ),
  defaultRoomTitle: WorkerConfig.string("ARCHITECT_DEFAULT_ROOM_TITLE").pipe(
    Config.withDefault("Untitled architecture"),
  ),
});

export class RoomDurableObject extends DurableObject.Tag<RoomDurableObject>()(
  "ArchitectRoomDurableObject",
  {
    getMetadata: DurableObject.method({
      args: [RoomId] as const,
      success: RoomMetadata,
    }),
    getHealth: DurableObject.method({
      args: [RoomId] as const,
      success: RoomHealth,
    }),
    recordTransportEvent: DurableObject.method({
      args: [TransportEventInput] as const,
      success: TransportEventReceipt,
    }),
  },
) {}

export class ApiWorker extends Worker.Tag<ApiWorker>()("ArchitectApiWorker", {
  health: Worker.method({
    success: ApiHealth,
  }),
  createRoom: Worker.method({
    success: CreateRoomResult,
  }),
  roomHealth: Worker.method({
    args: [RoomId] as const,
    success: RoomHealth,
  }),
}) {}

export class LatestArchitectureReadModels extends Kv.Tag<LatestArchitectureReadModels>()(
  "ArchitectLatestArchitectureReadModels",
  {
    key: S.String,
    value: ArchitectureReadModel,
  },
) {}

export class PublishedArchitectureReadModels extends Kv.Tag<PublishedArchitectureReadModels>()(
  "ArchitectPublishedArchitectureReadModels",
  {
    key: S.String,
    value: PublishedArchitectureReadModel,
  },
) {}

export class AiJobQueue extends Queue.Tag<AiJobQueue>()("ArchitectAiJobQueue", {
  message: AiJob,
}) {}
