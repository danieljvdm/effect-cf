import { ApiWorker } from "@effect-cf/example-contracts/ApiWorker";
import type {
  ChatArtifact,
  RecordMessageRequest,
  User,
} from "@effect-cf/example-contracts/Schemas";
import { ChatRoom } from "@effect-cf/example-contracts/ChatRoom";
import { Effect } from "effect";

const knownUsersFor = (userIds: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const api = yield* ApiWorker;
    const users: Array<User> = [];

    for (const userId of userIds) {
      const user = yield* api.getUser(userId);
      if (user !== null) {
        users.push(user);
      }
    }

    return users;
  });

export const analyzeRoom = (roomId: string) =>
  Effect.gen(function* () {
    const rooms = yield* ChatRoom;
    const snapshot = yield* rooms.byName(roomId).getSnapshot(roomId);
    const userIds = new Set(snapshot.messages.map((message) => message.userId));
    const knownUsers = yield* knownUsersFor(userIds);

    return {
      roomId,
      messageCount: snapshot.messageCount,
      knownUsers,
      sourceMessageId: null,
      generatedAt: new Date().toISOString(),
    } satisfies ChatArtifact;
  });

export const recordMessage = (input: RecordMessageRequest) =>
  analyzeRoom(input.roomId).pipe(
    Effect.map((artifact) => ({
      ...artifact,
      sourceMessageId: input.messageId,
    })),
  );
