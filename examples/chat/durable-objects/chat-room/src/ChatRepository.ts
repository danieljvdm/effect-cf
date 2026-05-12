import type {
  AppendMessageRequest,
  ChatMessage,
  ChatSnapshot,
} from "@effect-cf/example-contracts/Schemas";
import { Context, Effect, Layer } from "effect";
import { DurableObjectState, DurableObjectStorage } from "effect-cf";

interface MessageRow {
  readonly [key: string]: globalThis.SqlStorageValue;
  readonly id: string;
  readonly room_id: string;
  readonly user_id: string;
  readonly text: string;
  readonly created_at: string;
}

interface CountRow {
  readonly [key: string]: globalThis.SqlStorageValue;
  readonly count: number;
}

interface LastMessageRow {
  readonly [key: string]: globalThis.SqlStorageValue;
  readonly last_message_at: string | null;
}

type ChatRepositoryError = DurableObjectStorage.StorageOperationError;

export interface ChatRepositoryService {
  readonly appendMessage: (
    input: AppendMessageRequest,
  ) => Effect.Effect<ChatMessage, ChatRepositoryError>;
  readonly getRecentMessages: (
    roomId: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ChatMessage>, ChatRepositoryError>;
  readonly getSnapshot: (roomId: string) => Effect.Effect<ChatSnapshot, ChatRepositoryError>;
}

const fromRow = (row: MessageRow): ChatMessage => ({
  id: row.id,
  roomId: row.room_id,
  userId: row.user_id,
  text: row.text,
  createdAt: row.created_at,
});

export class ChatRepository extends Context.Service<ChatRepository, ChatRepositoryService>()(
  "chat-room/ChatRepository",
) {
  static readonly layerNoDeps = Layer.effect(
    this,
    Effect.gen(function* () {
      const state = yield* DurableObjectState.DurableObjectState;

      const ensureSchema = Effect.gen(function* () {
        yield* state.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            room_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            text TEXT NOT NULL,
            created_at TEXT NOT NULL
          )
        `);
        yield* state.storage.sql.exec(`
          CREATE INDEX IF NOT EXISTS messages_room_created_at_idx
          ON messages (room_id, created_at)
        `);
      });

      const getRecentMessages = (roomId: string, limit: number) =>
        Effect.gen(function* () {
          yield* ensureSchema;
          const cursor = yield* state.storage.sql.exec<MessageRow>(
            `
              SELECT id, room_id, user_id, text, created_at
              FROM messages
              WHERE room_id = ?
              ORDER BY created_at DESC
              LIMIT ?
            `,
            roomId,
            Math.max(1, Math.min(limit, 100)),
          );
          const rows = yield* cursor.toArray();
          return rows.toReversed().map(fromRow);
        });

      return {
        appendMessage: (input) =>
          Effect.gen(function* () {
            yield* ensureSchema;
            const message = {
              id: crypto.randomUUID(),
              roomId: input.roomId,
              userId: input.userId,
              text: input.text,
              createdAt: new Date().toISOString(),
            } satisfies ChatMessage;

            yield* state.storage.sql.exec(
              `
                INSERT INTO messages (id, room_id, user_id, text, created_at)
                VALUES (?, ?, ?, ?, ?)
              `,
              message.id,
              message.roomId,
              message.userId,
              message.text,
              message.createdAt,
            );
            yield* state.storage.kv.put("lastMessage", message);

            return message;
          }),
        getRecentMessages,
        getSnapshot: (roomId) =>
          Effect.gen(function* () {
            yield* ensureSchema;
            const messages = yield* getRecentMessages(roomId, 100);
            const countCursor = yield* state.storage.sql.exec<CountRow>(
              "SELECT COUNT(*) AS count FROM messages WHERE room_id = ?",
              roomId,
            );
            const lastMessageCursor = yield* state.storage.sql.exec<LastMessageRow>(
              "SELECT MAX(created_at) AS last_message_at FROM messages WHERE room_id = ?",
              roomId,
            );
            const { count } = yield* countCursor.one();
            const { last_message_at } = yield* lastMessageCursor.one();

            return {
              roomId,
              messages,
              messageCount: count,
              lastMessageAt: last_message_at,
            };
          }),
      } satisfies ChatRepositoryService;
    }),
  );

  static readonly layer = this.layerNoDeps;
}
