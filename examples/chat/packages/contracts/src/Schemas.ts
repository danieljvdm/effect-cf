import { Schema as S } from "effect";

export const UserPlan = S.Literals(["free", "pro"] as const);

export const User = S.Struct({
  id: S.String,
  name: S.String,
  plan: UserPlan,
});

export type User = S.Schema.Type<typeof User>;

export const ChatMessage = S.Struct({
  id: S.String,
  roomId: S.String,
  userId: S.String,
  text: S.String,
  createdAt: S.String,
});

export type ChatMessage = S.Schema.Type<typeof ChatMessage>;

export const AppendMessageRequest = S.Struct({
  roomId: S.String,
  userId: S.String,
  text: S.String,
});

export type AppendMessageRequest = S.Schema.Type<typeof AppendMessageRequest>;

export const ChatSnapshot = S.Struct({
  roomId: S.String,
  messages: S.Array(ChatMessage),
  messageCount: S.Number,
  lastMessageAt: S.NullOr(S.String),
});

export type ChatSnapshot = S.Schema.Type<typeof ChatSnapshot>;

export const RecordMessageRequest = S.Struct({
  roomId: S.String,
  messageId: S.String,
});

export type RecordMessageRequest = S.Schema.Type<typeof RecordMessageRequest>;

export const ChatArtifact = S.Struct({
  roomId: S.String,
  messageCount: S.Number,
  knownUsers: S.Array(User),
  sourceMessageId: S.NullOr(S.String),
  generatedAt: S.String,
});

export type ChatArtifact = S.Schema.Type<typeof ChatArtifact>;

export const ChatPeer = S.Struct({
  id: S.String,
  userId: S.String,
  connectedAt: S.String,
  lastSeenAt: S.String,
  restored: S.Boolean,
});

export type ChatPeer = S.Schema.Type<typeof ChatPeer>;

export const ChatReadyEvent = S.Struct({
  type: S.Literal("ready"),
  roomId: S.String,
  self: ChatPeer,
  peers: S.Array(ChatPeer),
  snapshot: ChatSnapshot,
  hibernation: S.Struct({
    restoredConnections: S.Number,
    autoResponse: S.Literal("ping:pong"),
  }),
});

export type ChatReadyEvent = S.Schema.Type<typeof ChatReadyEvent>;

export const ChatMessageEvent = S.Struct({
  type: S.Literal("message"),
  message: ChatMessage,
});

export type ChatMessageEvent = S.Schema.Type<typeof ChatMessageEvent>;

export const ChatPresenceEvent = S.Struct({
  type: S.Literal("presence"),
  roomId: S.String,
  peers: S.Array(ChatPeer),
  connectionCount: S.Number,
});

export type ChatPresenceEvent = S.Schema.Type<typeof ChatPresenceEvent>;

export const ChatHeartbeatEvent = S.Struct({
  type: S.Literal("heartbeat"),
  at: S.String,
  connectionCount: S.Number,
});

export type ChatHeartbeatEvent = S.Schema.Type<typeof ChatHeartbeatEvent>;

export const ChatErrorEvent = S.Struct({
  type: S.Literal("error"),
  message: S.String,
});

export type ChatErrorEvent = S.Schema.Type<typeof ChatErrorEvent>;

export const ChatServerEvent = S.Union([
  ChatReadyEvent,
  ChatMessageEvent,
  ChatPresenceEvent,
  ChatHeartbeatEvent,
  ChatErrorEvent,
]);

export type ChatServerEvent = S.Schema.Type<typeof ChatServerEvent>;

export const ChatClientEvent = S.Union([
  S.Struct({
    type: S.Literal("message"),
    text: S.String,
  }),
  S.Struct({
    type: S.Literal("heartbeat"),
  }),
]);

export type ChatClientEvent = S.Schema.Type<typeof ChatClientEvent>;
