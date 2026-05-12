import { Schema as S } from "effect";
import { DurableObject } from "effect-cf";

import { AppendMessageRequest, ChatMessage, ChatSnapshot } from "./Schemas";

export class ChatRoom extends DurableObject.Tag<ChatRoom>()("ChatRoom", {
  appendMessage: DurableObject.method({
    args: [AppendMessageRequest] as const,
    success: ChatMessage,
  }),
  getSnapshot: DurableObject.method({
    args: [S.String] as const,
    success: ChatSnapshot,
  }),
  getRecentMessages: DurableObject.method({
    args: [S.String, S.Number] as const,
    success: S.Array(ChatMessage),
  }),
}) {}

export type ChatRoomApi = DurableObject.Api<typeof ChatRoom>;
