import type { ChatPeer } from "@effect-cf/example-contracts/Schemas";
import { Context, Effect, Layer, Option, Schema as S } from "effect";
import { DurableObjectState, DurableObjectWebSocket } from "effect-cf";

const heartbeatTtlMillis = 45_000;

const ConnectionAttachment = S.Struct({
  id: S.String,
  connectedAt: S.Number,
  lastHeartbeat: S.Number,
  roomId: S.String,
  userId: S.String,
  restored: S.Boolean,
});

type ConnectionAttachment = S.Schema.Type<typeof ConnectionAttachment>;

const Attachments = DurableObjectWebSocket.attachment(ConnectionAttachment);

type ConnectionSocket = DurableObjectWebSocket.DurableWebSocket<ConnectionAttachment>;

export interface Connection {
  readonly socket: ConnectionSocket;
  readonly id: string;
  readonly connectedAt: number;
  readonly lastHeartbeat: number;
  readonly roomId: string;
  readonly userId: string;
  readonly restored: boolean;
}

export interface ConnectionMetadata {
  readonly roomId: string;
  readonly userId: string;
}

export interface ConnectionManagerService {
  readonly add: (
    socket: ConnectionSocket,
    metadata: ConnectionMetadata,
  ) => Effect.Effect<Connection, unknown>;
  readonly heartbeat: (socket: ConnectionSocket) => Effect.Effect<Connection, unknown>;
  readonly get: (socket: ConnectionSocket) => Effect.Effect<Connection | undefined, unknown>;
  readonly remove: (socket: ConnectionSocket) => Effect.Effect<Connection | undefined, unknown>;
  readonly list: (roomId: string) => Effect.Effect<ReadonlyArray<ChatPeer>, unknown>;
  readonly restoredCount: Effect.Effect<number>;
  readonly cleanup: Effect.Effect<void, unknown>;
  readonly count: Effect.Effect<number>;
}

const toPeer = (connection: Connection): ChatPeer => ({
  id: connection.id,
  userId: connection.userId,
  connectedAt: new Date(connection.connectedAt).toISOString(),
  lastSeenAt: new Date(connection.lastHeartbeat).toISOString(),
  restored: connection.restored,
});

export class ConnectionManager extends Context.Service<
  ConnectionManager,
  ConnectionManagerService
>()("chat-room/ConnectionManager") {
  static readonly layerNoDeps = Layer.effect(
    this,
    Effect.gen(function* () {
      const state = yield* DurableObjectState.DurableObjectState;
      const connections = new Map<ConnectionSocket, Connection>();

      const remember = (
        socket: ConnectionSocket,
        metadata: ConnectionMetadata,
        options?: {
          readonly id?: string;
          readonly connectedAt?: number;
          readonly lastHeartbeat?: number;
          readonly restored?: boolean;
        },
      ) =>
        Effect.gen(function* () {
          const now = Date.now();
          const connection = {
            socket,
            id: options?.id ?? crypto.randomUUID(),
            connectedAt: options?.connectedAt ?? now,
            lastHeartbeat: options?.lastHeartbeat ?? now,
            roomId: metadata.roomId,
            userId: metadata.userId,
            restored: options?.restored ?? false,
          } satisfies Connection;

          connections.set(socket, connection);
          yield* Attachments.serialize(socket, {
            id: connection.id,
            connectedAt: connection.connectedAt,
            lastHeartbeat: connection.lastHeartbeat,
            roomId: connection.roomId,
            userId: connection.userId,
            restored: connection.restored,
          } satisfies ConnectionAttachment);

          return connection;
        });

      for (const { socket, attachment } of yield* Attachments.rehydrate({
        onInvalid: "ignore-and-close",
      })) {
        yield* remember(
          socket,
          { roomId: attachment.roomId, userId: attachment.userId },
          { ...attachment, restored: true },
        );
      }

      const getConnection = (
        socket: ConnectionSocket,
      ): Effect.Effect<Connection | undefined, unknown> =>
        Effect.gen(function* () {
          const current = connections.get(socket);
          if (current !== undefined) {
            return current;
          }

          const attachment = yield* Attachments.deserialize(socket).pipe(
            Effect.catch(() => Effect.succeed(Option.none())),
          );
          if (Option.isNone(attachment)) {
            return undefined;
          }

          return yield* remember(
            socket,
            { roomId: attachment.value.roomId, userId: attachment.value.userId },
            attachment.value,
          );
        });

      const pruneStale = Effect.gen(function* () {
        const now = Date.now();
        for (const socket of yield* state.getWebSockets()) {
          const connection = yield* getConnection(socket);
          if (connection !== undefined && now - connection.lastHeartbeat > heartbeatTtlMillis) {
            connections.delete(socket);
            yield* socket.close(1000, "heartbeat timeout").pipe(Effect.ignore);
          }
        }
      });

      return {
        add: (socket, metadata) => remember(socket, metadata),
        heartbeat: (socket) =>
          Effect.gen(function* () {
            const current = yield* getConnection(socket);
            const metadata = current ?? { roomId: "general", userId: "anonymous" };
            return yield* remember(socket, metadata, {
              id: current?.id,
              connectedAt: current?.connectedAt,
              restored: current?.restored,
            });
          }),
        get: (socket) => getConnection(socket),
        remove: (socket) =>
          Effect.gen(function* () {
            const connection = yield* getConnection(socket);
            connections.delete(socket);
            return connection;
          }),
        list: (roomId) =>
          Effect.gen(function* () {
            yield* pruneStale;
            return Array.from(connections.values())
              .filter((connection) => connection.roomId === roomId)
              .map(toPeer);
          }),
        restoredCount: Effect.sync(
          () => Array.from(connections.values()).filter((connection) => connection.restored).length,
        ),
        cleanup: pruneStale,
        count: Effect.sync(() => connections.size),
      } satisfies ConnectionManagerService;
    }),
  );

  static readonly layer = this.layerNoDeps;
}
