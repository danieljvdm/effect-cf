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

export interface ChatPeer {
  readonly id: string;
  readonly userId: string;
  readonly connectedAt: string;
  readonly lastSeenAt: string;
  readonly restored: boolean;
}

export interface ChatReadyEvent {
  readonly type: "ready";
  readonly roomId: string;
  readonly self: ChatPeer;
  readonly peers: ReadonlyArray<ChatPeer>;
  readonly snapshot: ChatSnapshot;
  readonly hibernation: {
    readonly restoredConnections: number;
    readonly autoResponse: "ping:pong";
  };
}

export interface ChatMessageEvent {
  readonly type: "message";
  readonly message: ChatMessage;
}

export interface ChatPresenceEvent {
  readonly type: "presence";
  readonly roomId: string;
  readonly peers: ReadonlyArray<ChatPeer>;
  readonly connectionCount: number;
}

export interface ChatHeartbeatEvent {
  readonly type: "heartbeat";
  readonly at: string;
  readonly connectionCount: number;
}

export interface ChatErrorEvent {
  readonly type: "error";
  readonly message: string;
}

export type ChatServerEvent =
  | ChatReadyEvent
  | ChatMessageEvent
  | ChatPresenceEvent
  | ChatHeartbeatEvent
  | ChatErrorEvent;

export type ChatClientEvent =
  | {
      readonly type: "message";
      readonly text: string;
    }
  | {
      readonly type: "heartbeat";
    };
