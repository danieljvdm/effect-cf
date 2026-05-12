import { ApiWorker as ApiWorkerContract } from "@effect-cf/example-contracts/ApiWorker";
import { ChatRoom } from "@effect-cf/example-contracts/ChatRoom";

export const ApiWorker = ApiWorkerContract.binding("chat-analytics/ApiWorker", {
  binding: "API_WORKER",
});

export const ChatRooms = ChatRoom.namespace("chat-analytics/ChatRooms", {
  binding: "CHAT_ROOM",
});
