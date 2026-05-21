import { Schema as S } from "effect";

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
