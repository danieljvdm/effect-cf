import type { ChatPeer } from "@effect-cf/example-contracts/Schemas";
import { Context, Effect, Layer } from "effect";
import { DurableObjectState } from "effect-cf";

const heartbeatTtlMillis = 45_000;

interface ConnectionAttachment {
  readonly id: string;
  readonly connectedAt: number;
  readonly lastHeartbeat: number;
  readonly roomId: string;
  readonly userId: string;
  readonly restored: boolean;
}

export interface Connection {
  readonly socket: WebSocket;
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
  readonly add: (socket: WebSocket, metadata: ConnectionMetadata) => Effect.Effect<Connection>;
  readonly heartbeat: (socket: WebSocket) => Effect.Effect<Connection>;
  readonly get: (socket: WebSocket) => Effect.Effect<Connection | undefined>;
  readonly remove: (socket: WebSocket) => Effect.Effect<Connection | undefined>;
  readonly list: (roomId: string) => Effect.Effect<ReadonlyArray<ChatPeer>>;
  readonly restoredCount: Effect.Effect<number>;
  readonly cleanup: Effect.Effect<void>;
  readonly count: Effect.Effect<number>;
}

const readAttachment = (socket: WebSocket): ConnectionAttachment | undefined => {
  const attachment = socket.deserializeAttachment();

  if (
    typeof attachment !== "object" ||
    attachment === null ||
    !("lastHeartbeat" in attachment) ||
    !("roomId" in attachment) ||
    !("userId" in attachment) ||
    typeof attachment.lastHeartbeat !== "number" ||
    typeof attachment.roomId !== "string" ||
    typeof attachment.userId !== "string"
  ) {
    return undefined;
  }

  return {
    id:
      "id" in attachment && typeof attachment.id === "string" ? attachment.id : crypto.randomUUID(),
    connectedAt:
      "connectedAt" in attachment && typeof attachment.connectedAt === "number"
        ? attachment.connectedAt
        : attachment.lastHeartbeat,
    lastHeartbeat: attachment.lastHeartbeat,
    roomId: attachment.roomId,
    userId: attachment.userId,
    restored:
      "restored" in attachment && typeof attachment.restored === "boolean"
        ? attachment.restored
        : true,
  };
};

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
      const connections = new Map<WebSocket, Connection>();

      const remember = (
        socket: WebSocket,
        metadata: ConnectionMetadata,
        options?: {
          readonly id?: string;
          readonly connectedAt?: number;
          readonly lastHeartbeat?: number;
          readonly restored?: boolean;
        },
      ) => {
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
        socket.serializeAttachment({
          id: connection.id,
          connectedAt: connection.connectedAt,
          lastHeartbeat: connection.lastHeartbeat,
          roomId: connection.roomId,
          userId: connection.userId,
          restored: connection.restored,
        } satisfies ConnectionAttachment);

        return connection;
      };

      for (const socket of state.raw.getWebSockets()) {
        const attachment = readAttachment(socket);
        if (attachment !== undefined) {
          remember(
            socket,
            { roomId: attachment.roomId, userId: attachment.userId },
            { ...attachment, restored: true },
          );
        }
      }

      const getConnection = (socket: WebSocket) => {
        const current = connections.get(socket);
        if (current !== undefined) {
          return current;
        }

        const attachment = readAttachment(socket);
        if (attachment === undefined) {
          return undefined;
        }

        return remember(
          socket,
          { roomId: attachment.roomId, userId: attachment.userId },
          attachment,
        );
      };

      const pruneStale = () => {
        const now = Date.now();
        for (const socket of state.raw.getWebSockets()) {
          const connection = getConnection(socket);
          if (connection !== undefined && now - connection.lastHeartbeat > heartbeatTtlMillis) {
            connections.delete(socket);
            socket.close(1000, "heartbeat timeout");
          }
        }
      };

      return {
        add: (socket, metadata) => Effect.sync(() => remember(socket, metadata)),
        heartbeat: (socket) =>
          Effect.sync(() => {
            const current = getConnection(socket);
            const metadata = current ?? { roomId: "general", userId: "anonymous" };
            return remember(socket, metadata, {
              id: current?.id,
              connectedAt: current?.connectedAt,
              restored: current?.restored,
            });
          }),
        get: (socket) => Effect.sync(() => getConnection(socket)),
        remove: (socket) =>
          Effect.sync(() => {
            const connection = getConnection(socket);
            connections.delete(socket);
            return connection;
          }),
        list: (roomId) =>
          Effect.sync(() => {
            pruneStale();
            return Array.from(connections.values())
              .filter((connection) => connection.roomId === roomId)
              .map(toPeer);
          }),
        restoredCount: Effect.sync(
          () => Array.from(connections.values()).filter((connection) => connection.restored).length,
        ),
        cleanup: Effect.sync(() => {
          pruneStale();
        }),
        count: Effect.sync(() => connections.size),
      } satisfies ConnectionManagerService;
    }),
  );

  static readonly layer = this.layerNoDeps;
}
