import {
  DurableObjectSqliteSyncWrapper,
  SQLiteSyncStorage,
  TLSocketRoom,
  type RoomStoreMethods,
  type SessionStateSnapshot,
  type TLSyncLog,
} from "@tldraw/sync-core";
import {
  createTLSchema,
  defaultBindingSchemas,
  defaultShapeSchemas,
  type TLRecord,
} from "@tldraw/tlschema";
import { Context, Effect, Layer, Option, Schema as S } from "effect";
import { DurableObjectState, DurableObjectWebSocket, Worker } from "effect-cf";

export interface TldrawSessionMeta {
  readonly roomId: string;
  readonly userId: string;
  readonly label: string;
}

export interface TldrawSocketMetadata extends TldrawSessionMeta {
  readonly sessionId?: string | undefined;
}

export const TldrawSocketAttachmentSchema = S.Struct({
  roomId: S.String,
  sessionId: S.String,
  userId: S.String,
  label: S.String,
  joinedAt: S.String,
  lastSeenAt: S.String,
  tldrawSession: S.optional(S.Unknown),
});

export type TldrawSocketAttachment = S.Schema.Type<typeof TldrawSocketAttachmentSchema>;

const SocketAttachment = DurableObjectWebSocket.attachment(TldrawSocketAttachmentSchema);
const encodeAttachment = S.encodeSync(TldrawSocketAttachmentSchema);

export const defaultTldrawSchema = createTLSchema({
  shapes: { ...defaultShapeSchemas },
  bindings: { ...defaultBindingSchemas },
});

export interface TldrawRoomOptions {
  readonly tablePrefix?: string | undefined;
  readonly clientTimeout?: number | undefined;
  readonly log?: TLSyncLog | undefined;
}

export interface TldrawRoomService {
  readonly acceptWebSocket: (
    request: Request,
    metadata: TldrawSocketMetadata,
  ) => Effect.Effect<Response, unknown, DurableObjectState.DurableObjectState>;
  readonly handleMessage: (
    socket: DurableObjectWebSocket.DurableWebSocket,
    message: string | ArrayBuffer,
  ) => Effect.Effect<void, unknown>;
  readonly handleClose: (
    socket: DurableObjectWebSocket.DurableWebSocket,
  ) => Effect.Effect<Option.Option<TldrawSocketAttachment>, unknown>;
  readonly handleError: (
    socket: DurableObjectWebSocket.DurableWebSocket,
  ) => Effect.Effect<Option.Option<TldrawSocketAttachment>, unknown>;
  readonly updateStore: (
    updater: (store: RoomStoreMethods<TLRecord>) => Promise<void> | void,
  ) => Effect.Effect<void, unknown>;
  readonly getDocumentClock: Effect.Effect<number>;
  readonly getActiveSessionCount: Effect.Effect<number>;
}

export class TldrawRoom extends Context.Service<TldrawRoom, TldrawRoomService>()(
  "@architect-lab/tldraw-effect-cf/TldrawRoom",
) {
  static layer = (options: TldrawRoomOptions = {}) =>
    Layer.effect(
      TldrawRoom,
      Effect.gen(function* () {
        const state = yield* DurableObjectState.DurableObjectState;
        const sessionIdToSocket = new Map<string, DurableObjectWebSocket.DurableWebSocket>();
        const sessionIdToAttachment = new Map<string, TldrawSocketAttachment>();

        const sql = new DurableObjectSqliteSyncWrapper(state.raw.storage, {
          tablePrefix: options.tablePrefix ?? "tldraw_",
        });
        const storage = new SQLiteSyncStorage<TLRecord>({ sql });
        const room = new TLSocketRoom<TLRecord, TldrawSessionMeta>({
          storage,
          schema: defaultTldrawSchema,
          clientTimeout: options.clientTimeout ?? Infinity,
          log: options.log,
          onSessionSnapshot: (sessionId, snapshot) => {
            const socket = sessionIdToSocket.get(sessionId);
            const attachment = sessionIdToAttachment.get(sessionId);

            if (socket === undefined || attachment === undefined) {
              return;
            }

            const next = { ...attachment, tldrawSession: snapshot };
            sessionIdToAttachment.set(sessionId, next);
            socket.raw.serializeAttachment(encodeAttachment(next));
          },
          onSessionRemoved: (_room, { sessionId }) => {
            sessionIdToSocket.delete(sessionId);
            sessionIdToAttachment.delete(sessionId);
          },
        });

        const resumeExistingSockets = Effect.fn("resumeExistingTldrawSockets")(function* () {
          const sockets = yield* SocketAttachment.rehydrate({
            tag: "tldraw",
            onInvalid: "ignore-and-close",
          });

          for (const { socket, attachment } of sockets) {
            sessionIdToSocket.set(attachment.sessionId, socket);
            sessionIdToAttachment.set(attachment.sessionId, attachment);

            const snapshot = toSessionStateSnapshot(attachment.tldrawSession);
            if (snapshot === undefined) {
              yield* socket.close(1012, "missing tldraw session snapshot").pipe(Effect.ignore);
              continue;
            }

            room.handleSocketResume({
              sessionId: attachment.sessionId,
              socket: socket.raw,
              snapshot,
              meta: toSessionMeta(attachment),
            });
          }
        });

        yield* resumeExistingSockets();

        const touchAttachment = Effect.fn("touchTldrawSocketAttachment")(function* (
          socket: DurableObjectWebSocket.DurableWebSocket,
          attachment: TldrawSocketAttachment,
        ) {
          const next = { ...attachment, lastSeenAt: new Date().toISOString() };
          sessionIdToAttachment.set(next.sessionId, next);
          yield* SocketAttachment.serialize(socket, next);
          return next;
        });

        const closeSession = Effect.fn("closeTldrawSession")(function* (
          socket: DurableObjectWebSocket.DurableWebSocket,
          kind: "close" | "error",
        ) {
          const decoded = yield* SocketAttachment.deserialize(socket).pipe(Effect.option);
          if (Option.isNone(decoded) || Option.isNone(decoded.value)) {
            return Option.none<TldrawSocketAttachment>();
          }

          const attachment = decoded.value.value;
          if (kind === "error") {
            room.handleSocketError(attachment.sessionId);
          } else {
            room.handleSocketClose(attachment.sessionId);
          }
          sessionIdToSocket.delete(attachment.sessionId);
          sessionIdToAttachment.delete(attachment.sessionId);
          return Option.some(attachment);
        });

        return TldrawRoom.of({
          acceptWebSocket: (request, metadata) =>
            Effect.gen(function* () {
              if (!Worker.isWebSocketUpgrade(request)) {
                return new Response("Expected WebSocket upgrade", { status: 426 });
              }

              const now = new Date().toISOString();
              const attachment: TldrawSocketAttachment = {
                roomId: metadata.roomId,
                sessionId: metadata.sessionId ?? `session_${crypto.randomUUID()}`,
                userId: metadata.userId,
                label: metadata.label,
                joinedAt: now,
                lastSeenAt: now,
              };

              const upgrade = yield* DurableObjectWebSocket.acceptUpgrade<TldrawSocketAttachment>({
                tags: ["tldraw", `room:${metadata.roomId}`],
                attachment,
              });

              sessionIdToSocket.set(attachment.sessionId, upgrade.server);
              sessionIdToAttachment.set(attachment.sessionId, attachment);
              room.handleSocketConnect({
                sessionId: attachment.sessionId,
                socket: upgrade.server.raw,
                meta: toSessionMeta(attachment),
              });

              return upgrade.response;
            }),
          handleMessage: (socket, message) =>
            Effect.gen(function* () {
              const decoded = yield* SocketAttachment.deserialize(socket);
              if (Option.isNone(decoded)) {
                yield* socket.close(1008, "missing tldraw socket attachment").pipe(Effect.ignore);
                return;
              }

              const attachment = yield* touchAttachment(socket, decoded.value);
              room.handleSocketMessage(attachment.sessionId, message);
            }),
          handleClose: (socket) => closeSession(socket, "close"),
          handleError: (socket) => closeSession(socket, "error"),
          updateStore: (updater) =>
            Effect.tryPromise({
              try: async () => {
                await Promise.resolve();
                await room.updateStore(updater);
                await Promise.resolve();
              },
              catch: (error) => error,
            }),
          getDocumentClock: Effect.sync(() => room.getCurrentDocumentClock()),
          getActiveSessionCount: Effect.sync(() => room.getNumActiveSessions()),
        });
      }),
    );
}

const toSessionMeta = (attachment: TldrawSocketAttachment): TldrawSessionMeta => ({
  roomId: attachment.roomId,
  userId: attachment.userId,
  label: attachment.label,
});

const toSessionStateSnapshot = (value: unknown): SessionStateSnapshot | undefined =>
  typeof value === "object" && value !== null ? (value as SessionStateSnapshot) : undefined;
