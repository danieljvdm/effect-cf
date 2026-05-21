import { Config, Schema as S } from "effect";
import { DurableObject, Worker, WorkerConfig } from "effect-cf";

export const RoomId = S.String;
export type RoomId = S.Schema.Type<typeof RoomId>;

export const UserId = S.String;
export type UserId = S.Schema.Type<typeof UserId>;

export const RoomMetadata = S.Struct({
  id: RoomId,
  title: S.String,
  createdAt: S.String,
  updatedAt: S.String,
});
export type RoomMetadata = S.Schema.Type<typeof RoomMetadata>;

export const RoomHealth = S.Struct({
  id: RoomId,
  title: S.String,
  connections: S.Number,
  transportEvents: S.Number,
  documentClock: S.Number,
  updatedAt: S.String,
});
export type RoomHealth = S.Schema.Type<typeof RoomHealth>;

export const CreateRoomResult = S.Struct({
  roomId: RoomId,
  roomUrl: S.String,
  metadata: RoomMetadata,
});
export type CreateRoomResult = S.Schema.Type<typeof CreateRoomResult>;

export const ApiHealth = S.Struct({
  ok: S.Boolean,
  service: S.String,
  publicOrigin: S.String,
});
export type ApiHealth = S.Schema.Type<typeof ApiHealth>;

export const TransportEventInput = S.Struct({
  roomId: RoomId,
  actor: S.String,
  kind: S.String,
  payloadJson: S.String,
});
export type TransportEventInput = S.Schema.Type<typeof TransportEventInput>;

export const TransportEventReceipt = S.Struct({
  sequence: S.Number,
  roomId: RoomId,
});
export type TransportEventReceipt = S.Schema.Type<typeof TransportEventReceipt>;

export const PresenceMember = S.Struct({
  sessionId: S.String,
  userId: UserId,
  label: S.String,
  joinedAt: S.String,
  lastSeenAt: S.String,
});
export type PresenceMember = S.Schema.Type<typeof PresenceMember>;

export const PresenceSnapshot = S.Struct({
  type: S.Literal("server.presence.snapshot"),
  roomId: RoomId,
  members: S.Array(PresenceMember),
});
export type PresenceSnapshot = S.Schema.Type<typeof PresenceSnapshot>;

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
