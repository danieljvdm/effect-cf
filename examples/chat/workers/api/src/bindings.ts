import { AnalyticsWorker as AnalyticsWorkerContract } from "@effect-cf/example-contracts/AnalyticsWorker";
import { ChatRoom } from "@effect-cf/example-contracts/ChatRoom";
import { User } from "@effect-cf/example-contracts/Schemas";
import { Schema as S } from "effect";
import { Kv } from "effect-cf";

export const AnalyticsWorker = AnalyticsWorkerContract.binding("chat-api/AnalyticsWorker", {
  binding: "ANALYTICS_WORKER",
});

export const ChatRooms = ChatRoom.namespace("chat-api/ChatRooms", {
  binding: "CHAT_ROOM",
});

export const UserCache = Kv.make("chat-api/UserCache", {
  binding: "USER_CACHE",
  key: S.String,
  value: User,
});
