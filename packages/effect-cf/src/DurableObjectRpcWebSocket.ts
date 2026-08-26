import { Context, Effect, Layer, Option, Predicate, Queue, Schema } from "effect";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import { DurableObjectState } from "./DurableObjectState";
import {
  type AcceptedUpgrade,
  type AcceptUpgradeOptions,
  type DurableWebSocket,
  DurableWebSocketAttachmentError,
  fromWebSocket,
} from "./DurableObjectWebSocket";

const defaultAttachmentKey = "effectCloudflareRpcClientId";
const defaultTag = "effect-cf-rpc";
const legacyAttachmentVersion = 1;
const resumableAttachmentVersion = 2;
const serviceRestartCode = 1012;
const serviceRestartReason = "Durable Object RPC activation reset";

/** Heartbeat handling for Effect's application-level RPC Ping messages. */
export type HeartbeatPolicy = "auto-response" | "passthrough";

/** Object-shaped application attachment fields that can coexist with adapter metadata. */
export type RpcWebSocketAttachment = object;

/** A resumable RPC stream declaration understood by the websocket transport. */
export interface ResumableStreamDeclaration<ResumeDescriptor = unknown, Checkpoint = unknown> {
  /** Stable declaration identifier. Change it when the persisted representation changes. */
  readonly id: string;
  /** RPC tag matched against encoded client requests. */
  readonly rpcTag: string;
  /** Validates a resume descriptor restored from a websocket attachment. */
  readonly resumeDescriptorSchema: Schema.Decoder<ResumeDescriptor>;
  /** Validates an acknowledged checkpoint restored from a websocket attachment. */
  readonly checkpointSchema: Schema.Decoder<Checkpoint>;
  /**
   * Extracts compact persisted state from an initial encoded request. Do not
   * recycle a subscription key for an unrelated logical subscription while a
   * delayed checkpoint for the previous subscription can still arrive.
   */
  readonly identify: (request: RpcMessage.RequestEncoded) => Option.Option<{
    readonly subscriptionKey: string;
    readonly resumeDescriptor: ResumeDescriptor;
    readonly acknowledgedCheckpoint: Checkpoint;
  }>;
  /** Rebuilds the encoded request fields used to restart a handler. */
  readonly rebuild: (options: {
    readonly subscriptionKey: string;
    readonly resumeDescriptor: ResumeDescriptor;
    readonly acknowledgedCheckpoint: Checkpoint;
  }) => {
    readonly payload: unknown;
    readonly headers?: ReadonlyArray<readonly [string, string]> | undefined;
    readonly traceId?: string | undefined;
    readonly spanId?: string | undefined;
    readonly sampled?: boolean | undefined;
  };
  /** Extracts the durable checkpoint represented by one encoded stream value. */
  readonly checkpointFromValue: (
    value: RpcMessage.ResponseChunkEncoded["values"][number],
  ) => Option.Option<Checkpoint>;
  /**
   * Produces the checkpoint wire token. A logical event must keep the same
   * token when replayed, and unrelated events must never reuse it during the
   * lifetime of a subscription key.
   */
  readonly checkpointToken: (checkpoint: Checkpoint) => string;
}

type AnyResumableStreamDeclaration = ResumableStreamDeclaration<any, any>;

/** Declares an explicitly resumable RPC stream. */
export const resumableStream = <ResumeDescriptor, Checkpoint>(
  declaration: ResumableStreamDeclaration<ResumeDescriptor, Checkpoint>,
): ResumableStreamDeclaration<ResumeDescriptor, Checkpoint> => declaration;

/**
 * Configuration for {@link layer}.
 */
export interface LayerOptions {
  /** Tag used to select hibernated sockets. */
  readonly tag?: string | undefined;
  /** Socket attachment namespace used to persist adapter metadata across hibernation. */
  readonly attachmentKey?: string | undefined;
  /**
   * Heartbeat behavior. `"auto-response"` (the default) installs Cloudflare's
   * hibernation-safe text Ping/Pong response while an RPC socket exists and no
   * non-resumable RPC operation is active, then removes it while one is pending.
   * `"passthrough"` leaves the Durable Object's existing auto-response
   * configuration unchanged and makes the application responsible for waking a
   * lost pending operation.
   * Cloudflare's pair is global to the Durable Object, so use `"passthrough"`
   * when RPC and unrelated websocket protocols share one object.
   */
  readonly heartbeat?: HeartbeatPolicy | undefined;
  /** Explicit stream declarations that may be reconstructed after activation loss. */
  readonly resumableStreams?: ReadonlyArray<AnyResumableStreamDeclaration> | undefined;
}

/** Native websocket event payload accepted by Cloudflare Durable Objects. */
export type NativeWebSocketMessage = string | ArrayBuffer;

/**
 * Service API used to wire websocket lifecycle events to Effect RPC server protocol.
 */
export interface DurableObjectRpcWebSocketService {
  /** Accepts a new, not-yet-accepted socket with the RPC tag and any application tags. */
  readonly accept: (socket: DurableWebSocket, tags?: ReadonlyArray<string>) => Effect.Effect<void>;
  /**
   * Creates and accepts a websocket upgrade without double-accepting the server
   * socket. Application attachment fields are shallow-merged with the adapter's
   * metadata namespace.
   */
  readonly acceptUpgrade: <Attachment extends RpcWebSocketAttachment = RpcWebSocketAttachment>(
    options?: AcceptUpgradeOptions<Attachment>,
  ) => Effect.Effect<AcceptedUpgrade<Attachment>, DurableWebSocketAttachmentError>;
  readonly message: (
    socket: DurableWebSocket,
    message: NativeWebSocketMessage,
  ) => Effect.Effect<void>;
  readonly close: (socket: DurableWebSocket) => Effect.Effect<void>;
  readonly error: (socket: DurableWebSocket, cause: unknown) => Effect.Effect<void>;
  /**
   * Persists forward checkpoint progress for a resumable stream. Returns `true`
   * only when the checkpoint advances the current pending chunk batch. A failed
   * websocket attachment write resets the connection and fails with
   * `DurableWebSocketAttachmentError`.
   */
  readonly checkpoint: <ResumeDescriptor, Checkpoint>(
    declaration: ResumableStreamDeclaration<ResumeDescriptor, Checkpoint>,
    options: {
      readonly clientId: number;
      readonly subscriptionKey: string;
      readonly checkpoint: Checkpoint;
    },
  ) => Effect.Effect<boolean, DurableWebSocketAttachmentError>;
}

interface RpcConnection {
  readonly id: number;
  readonly socket: DurableWebSocket;
  readonly parser: RpcSerialization.Parser;
  readonly requestIds: Set<string | number>;
  readonly nonResumableRequestIds: Set<string | number>;
  readonly subscriptionsByRequestId: Map<string | number, ActiveSubscription>;
  readonly subscriptionsByDefinition: Map<string, Map<string, ActiveSubscription>>;
  readonly suppressedAckRequestIds: Set<string | number>;
  readonly currentPendingRequestIds: Set<string | number>;
  metadataVersion: 1 | 2;
}

interface LegacyAttachmentMetadata {
  readonly version: 1;
  readonly clientId: number;
  readonly hasPendingRequests: boolean;
}

interface PersistedPendingBatch {
  readonly checkpointTokens: ReadonlyArray<string>;
}

interface PersistedSubscription {
  readonly definitionId: string;
  readonly subscriptionKey: string;
  readonly requestId: string | number;
  readonly rpcTag: string;
  readonly resumeDescriptor: unknown;
  readonly acknowledgedCheckpoint: unknown;
  readonly pending?: PersistedPendingBatch | undefined;
}

interface ResumableAttachmentMetadata {
  readonly version: 2;
  readonly clientId: number;
  readonly hasPendingRequests: boolean;
  readonly hasNonResumableRequests: boolean;
  readonly subscriptions: ReadonlyArray<PersistedSubscription>;
}

type AttachmentMetadata = LegacyAttachmentMetadata | ResumableAttachmentMetadata;

interface ActiveSubscription extends PersistedSubscription {
  readonly declaration: AnyResumableStreamDeclaration;
  acknowledgedCheckpoint: unknown;
  pending?: PersistedPendingBatch | undefined;
}

const PersistedPendingBatchSchema = Schema.Struct({
  checkpointTokens: Schema.Array(Schema.String),
});

const PersistedSubscriptionSchema = Schema.Struct({
  definitionId: Schema.String,
  subscriptionKey: Schema.String,
  requestId: Schema.Union([Schema.String, Schema.Finite]),
  rpcTag: Schema.String,
  resumeDescriptor: Schema.Unknown,
  acknowledgedCheckpoint: Schema.Unknown,
  pending: Schema.optionalKey(PersistedPendingBatchSchema),
});

const ResumableAttachmentMetadataSchema = Schema.Struct({
  version: Schema.Literal(resumableAttachmentVersion),
  clientId: Schema.Finite,
  hasPendingRequests: Schema.Boolean,
  hasNonResumableRequests: Schema.Boolean,
  subscriptions: Schema.Array(PersistedSubscriptionSchema),
});

const decodeResumableAttachment = Schema.decodeUnknownOption(ResumableAttachmentMetadataSchema);

/**
 * Context tag for the Durable Object RPC websocket service.
 */
export class DurableObjectRpcWebSocket extends Context.Service<
  DurableObjectRpcWebSocket,
  DurableObjectRpcWebSocketService
>()("effect-cf/DurableObjectRpcWebSocket") {}

/**
 * Builds a hibernation-aware transport that bridges Durable Object websocket
 * events to `RpcServer.Protocol`.
 *
 * The layer restores idle tagged sockets and explicitly declared resumable
 * streams after constructor recreation. A socket that lost any other in-flight
 * request is closed with code 1012, which the stock Effect socket protocol
 * reports as an `RpcClientError` containing `SocketCloseError`.
 */
export const layer = (
  options: LayerOptions = {},
): Layer.Layer<
  RpcServer.Protocol | DurableObjectRpcWebSocket,
  never,
  DurableObjectState | RpcSerialization.RpcSerialization
> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const tag = options.tag ?? defaultTag;
      const attachmentKey = options.attachmentKey ?? defaultAttachmentKey;
      const heartbeatPolicy = options.heartbeat ?? "auto-response";
      const declarations = options.resumableStreams ?? [];
      const durableObjectState = yield* DurableObjectState;
      const serialization = yield* RpcSerialization.RpcSerialization;
      const disconnects = yield* Queue.make<number>();
      const connectionsBySocket = new Map<WebSocket, RpcConnection>();
      const connectionsById = new Map<number, RpcConnection>();
      const clientIds = new Set<number>();
      const resetSockets = new WeakSet<WebSocket>();
      const declarationsById = new Map<string, AnyResumableStreamDeclaration>();
      const declarationsByTag = new Map<string, AnyResumableStreamDeclaration>();
      const replayRequests: Array<{
        readonly clientId: number;
        readonly request: RpcMessage.RequestEncoded;
      }> = [];
      let nextClientId = 0;
      let activeNonResumableRequestCount = 0;
      let writeRequest:
        | ((clientId: number, data: RpcMessage.FromClientEncoded) => Effect.Effect<void>)
        | undefined;

      for (const declaration of declarations) {
        if (declaration.id.length === 0 || declaration.rpcTag.length === 0) {
          return yield* Effect.die(
            new Error("Resumable RPC stream declaration ids and tags must be non-empty"),
          );
        }

        if (declarationsById.has(declaration.id)) {
          return yield* Effect.die(
            new Error(`Duplicate resumable RPC stream declaration id: ${declaration.id}`),
          );
        }

        if (declarationsByTag.has(declaration.rpcTag)) {
          return yield* Effect.die(
            new Error(`Duplicate resumable RPC stream tag: ${declaration.rpcTag}`),
          );
        }

        declarationsById.set(declaration.id, declaration);
        declarationsByTag.set(declaration.rpcTag, declaration);
      }

      const reserveClientId = (socket: DurableWebSocket): AttachmentMetadata => {
        const attachment = readAttachment(socket.raw, attachmentKey);

        if (attachment._tag === "Invalid") {
          throw new Error("Invalid Durable Object RPC websocket attachment metadata");
        }

        if (attachment._tag === "Valid") {
          const metadata = attachment.metadata;

          nextClientId = Math.max(nextClientId, metadata.clientId + 1);
          writeAttachment(socket.raw, attachmentKey, metadata);

          return metadata;
        }

        const id = nextClientId++;
        const created: LegacyAttachmentMetadata = {
          version: legacyAttachmentVersion,
          clientId: id,
          hasPendingRequests: false,
        };

        writeAttachment(socket.raw, attachmentKey, created);

        return created;
      };

      const addSubscription = (
        connection: RpcConnection,
        subscription: ActiveSubscription,
      ): boolean => {
        if (connection.subscriptionsByRequestId.has(subscription.requestId)) {
          return false;
        }

        let byKey = connection.subscriptionsByDefinition.get(subscription.definitionId);

        if (byKey?.has(subscription.subscriptionKey) === true) {
          return false;
        }

        if (byKey === undefined) {
          byKey = new Map();
          connection.subscriptionsByDefinition.set(subscription.definitionId, byKey);
        }

        byKey.set(subscription.subscriptionKey, subscription);
        connection.subscriptionsByRequestId.set(subscription.requestId, subscription);
        connection.requestIds.add(subscription.requestId);
        connection.metadataVersion = resumableAttachmentVersion;

        return true;
      };

      const removeSubscription = (connection: RpcConnection, requestId: string | number) => {
        const subscription = connection.subscriptionsByRequestId.get(requestId);

        if (subscription === undefined) {
          return undefined;
        }

        connection.subscriptionsByRequestId.delete(requestId);
        const byKey = connection.subscriptionsByDefinition.get(subscription.definitionId);

        byKey?.delete(subscription.subscriptionKey);
        if (byKey?.size === 0) {
          connection.subscriptionsByDefinition.delete(subscription.definitionId);
        }

        return subscription;
      };

      const register = (
        socket: DurableWebSocket,
        restoredMetadata?: AttachmentMetadata,
        restoredSubscriptions: ReadonlyArray<ActiveSubscription> = [],
      ) => {
        const existing = connectionsBySocket.get(socket.raw);

        if (existing !== undefined) {
          return existing;
        }

        const metadata = restoredMetadata ?? reserveClientId(socket);
        const connection = {
          id: metadata.clientId,
          socket,
          parser: serialization.makeUnsafe(),
          requestIds: new Set<string | number>(),
          nonResumableRequestIds: new Set<string | number>(),
          subscriptionsByRequestId: new Map<string | number, ActiveSubscription>(),
          subscriptionsByDefinition: new Map<string, Map<string, ActiveSubscription>>(),
          suppressedAckRequestIds: new Set<string | number>(),
          currentPendingRequestIds: new Set<string | number>(),
          metadataVersion: metadata.version,
        } satisfies RpcConnection;

        if (connectionsById.has(connection.id)) {
          throw new Error(`Duplicate Durable Object RPC websocket client id: ${connection.id}`);
        }

        for (const subscription of restoredSubscriptions) {
          if (!addSubscription(connection, subscription)) {
            throw new Error("Duplicate restored resumable RPC stream subscription identity");
          }
        }

        connectionsBySocket.set(socket.raw, connection);
        connectionsById.set(connection.id, connection);
        clientIds.add(connection.id);
        nextClientId = Math.max(nextClientId, connection.id + 1);

        return connection;
      };

      const heartbeat = yield* makeHeartbeatController(
        durableObjectState,
        serialization,
        heartbeatPolicy,
      );

      const syncHeartbeat = () =>
        heartbeat.setEnabled(connectionsBySocket.size > 0 && activeNonResumableRequestCount === 0);

      const persistConnection = Effect.fn("DurableObjectRpcWebSocket.persistConnection")(function* (
        connection: RpcConnection,
      ): Effect.fn.Return<void, DurableWebSocketAttachmentError> {
        return yield* Effect.try({
          try: () => {
            if (connection.metadataVersion === legacyAttachmentVersion) {
              writeAttachment(connection.socket.raw, attachmentKey, {
                version: legacyAttachmentVersion,
                clientId: connection.id,
                hasPendingRequests: connection.requestIds.size > 0,
              });

              return;
            }

            const subscriptions = Array.from(connection.subscriptionsByRequestId.values()).map(
              ({ declaration: _, ...subscription }): PersistedSubscription => subscription,
            );

            writeAttachment(connection.socket.raw, attachmentKey, {
              version: resumableAttachmentVersion,
              clientId: connection.id,
              hasPendingRequests: connection.requestIds.size > 0,
              hasNonResumableRequests: connection.nonResumableRequestIds.size > 0,
              subscriptions,
            });
          },
          catch: (cause) => new DurableWebSocketAttachmentError({ operation: "serialize", cause }),
        });
      });

      const unregister = Effect.fn("DurableObjectRpcWebSocket.unregister")(function* (
        socket: DurableWebSocket,
      ) {
        const connection = connectionsBySocket.get(socket.raw);

        if (connection === undefined) {
          return;
        }

        connectionsBySocket.delete(socket.raw);
        connectionsById.delete(connection.id);
        clientIds.delete(connection.id);
        activeNonResumableRequestCount -= connection.nonResumableRequestIds.size;
        connection.requestIds.clear();
        connection.nonResumableRequestIds.clear();
        connection.subscriptionsByRequestId.clear();
        connection.subscriptionsByDefinition.clear();
        connection.suppressedAckRequestIds.clear();
        connection.currentPendingRequestIds.clear();
        Queue.offerUnsafe(disconnects, connection.id);

        yield* syncHeartbeat();
      });

      const resetSocket = Effect.fn("DurableObjectRpcWebSocket.resetSocket")(function* (
        socket: DurableWebSocket,
        cause?: unknown,
      ) {
        resetSockets.add(socket.raw);
        yield* unregister(socket).pipe(
          Effect.catchCause((unregisterCause) =>
            Effect.logDebug("Failed to unregister Durable Object RPC websocket", unregisterCause),
          ),
        );

        if (cause !== undefined) {
          yield* Effect.logDebug("Resetting Durable Object RPC websocket", cause);
        }

        yield* socket
          .close(serviceRestartCode, serviceRestartReason)
          .pipe(
            Effect.catch((closeError) =>
              Effect.logDebug("Failed to close Durable Object RPC websocket", closeError),
            ),
          );
      });

      const persistOrReset = Effect.fn("DurableObjectRpcWebSocket.persistOrReset")(function* (
        connection: RpcConnection,
      ) {
        return yield* persistConnection(connection).pipe(
          Effect.as(true),
          Effect.catch((cause) => resetSocket(connection.socket, cause).pipe(Effect.as(false))),
        );
      });

      const trackRequest = Effect.fn("DurableObjectRpcWebSocket.trackRequest")(function* (
        connection: RpcConnection,
        request: RpcMessage.RequestEncoded,
      ) {
        if (connection.requestIds.has(request.id)) {
          return true;
        }

        const declaration = declarationsByTag.get(request.tag);
        const identified =
          declaration === undefined
            ? Option.none()
            : yield* Effect.sync(() => declaration.identify(request));

        if (declaration !== undefined && Option.isSome(identified)) {
          if (
            !addSubscription(connection, {
              declaration,
              definitionId: declaration.id,
              subscriptionKey: identified.value.subscriptionKey,
              requestId: request.id,
              rpcTag: declaration.rpcTag,
              resumeDescriptor: identified.value.resumeDescriptor,
              acknowledgedCheckpoint: identified.value.acknowledgedCheckpoint,
            })
          ) {
            yield* resetSocket(
              connection.socket,
              new Error(`Duplicate resumable RPC stream subscription: ${declaration.id}`),
            );

            return false;
          }
        } else {
          connection.requestIds.add(request.id);
          connection.nonResumableRequestIds.add(request.id);
          activeNonResumableRequestCount++;
        }

        if (!(yield* persistOrReset(connection))) {
          return false;
        }

        yield* syncHeartbeat();

        return true;
      });

      const completeRequest = Effect.fn("DurableObjectRpcWebSocket.completeRequest")(function* (
        connection: RpcConnection,
        requestId: string | number,
        preserveAckFilter = false,
      ) {
        if (connection.requestIds.delete(requestId)) {
          if (connection.nonResumableRequestIds.delete(requestId)) {
            activeNonResumableRequestCount--;
          }

          const subscription = removeSubscription(connection, requestId);

          connection.currentPendingRequestIds.delete(requestId);

          if (preserveAckFilter && subscription !== undefined) {
            connection.suppressedAckRequestIds.add(requestId);
          }

          if (!(yield* persistOrReset(connection))) {
            return;
          }
        }

        if (!preserveAckFilter) {
          connection.suppressedAckRequestIds.delete(requestId);
        }

        yield* syncHeartbeat();
      });

      const completeAllRequests = Effect.fn("DurableObjectRpcWebSocket.completeAllRequests")(
        function* (connection: RpcConnection) {
          const hadRequests = connection.requestIds.size > 0;

          if (connection.requestIds.size > 0) {
            activeNonResumableRequestCount -= connection.nonResumableRequestIds.size;
          }

          connection.requestIds.clear();
          connection.nonResumableRequestIds.clear();
          connection.subscriptionsByRequestId.clear();
          connection.subscriptionsByDefinition.clear();
          connection.suppressedAckRequestIds.clear();
          connection.currentPendingRequestIds.clear();

          if (hadRequests && !(yield* persistOrReset(connection))) {
            return;
          }

          yield* syncHeartbeat();
        },
      );

      const restored = yield* durableObjectState.getWebSockets(tag);
      const restoredAttachments = restored.map((socket) => ({
        socket,
        attachment: readAttachment(socket.raw, attachmentKey),
      }));

      for (const { attachment, socket } of restoredAttachments) {
        if (attachment._tag === "Invalid") {
          yield* resetSocket(socket);
          continue;
        }

        if (attachment._tag === "Missing") {
          yield* resetSocket(socket);
          continue;
        }

        const metadata = attachment.metadata;

        if (metadata.version === legacyAttachmentVersion) {
          if (metadata.hasPendingRequests) {
            yield* resetSocket(socket);
          } else if (connectionsById.has(metadata.clientId)) {
            yield* resetSocket(socket);
          } else {
            const connection = register(socket, metadata);

            yield* persistOrReset(connection);
          }

          continue;
        }

        const prepared = yield* Effect.sync(() => {
          try {
            if (
              metadata.hasNonResumableRequests ||
              metadata.hasPendingRequests !==
                (metadata.hasNonResumableRequests || metadata.subscriptions.length > 0)
            ) {
              throw new Error("Dirty resumable RPC websocket attachment metadata");
            }

            const requestIds = new Set<string | number>();
            const subscriptionKeys = new Map<string, Set<string>>();
            const subscriptions: Array<ActiveSubscription> = [];
            const requests: Array<RpcMessage.RequestEncoded> = [];

            for (const persisted of metadata.subscriptions) {
              const declaration = declarationsById.get(persisted.definitionId);

              if (declaration === undefined || declaration.rpcTag !== persisted.rpcTag) {
                throw new Error("Missing resumable RPC stream declaration");
              }

              let keys = subscriptionKeys.get(persisted.definitionId);

              if (keys === undefined) {
                keys = new Set();
                subscriptionKeys.set(persisted.definitionId, keys);
              }

              if (requestIds.has(persisted.requestId) || keys.has(persisted.subscriptionKey)) {
                throw new Error("Duplicate persisted resumable RPC stream subscription");
              }

              requestIds.add(persisted.requestId);
              keys.add(persisted.subscriptionKey);

              if (persisted.pending !== undefined) {
                const { checkpointTokens } = persisted.pending;

                if (
                  checkpointTokens.length === 0 ||
                  checkpointTokens.some((token) => token.length === 0) ||
                  new Set(checkpointTokens).size !== checkpointTokens.length
                ) {
                  throw new Error("Invalid persisted resumable RPC stream pending batch");
                }
              }

              const resumeDescriptor = Schema.decodeUnknownOption(
                declaration.resumeDescriptorSchema,
              )(persisted.resumeDescriptor);
              const acknowledgedCheckpoint = Schema.decodeUnknownOption(
                declaration.checkpointSchema,
              )(persisted.acknowledgedCheckpoint);

              if (Option.isNone(resumeDescriptor) || Option.isNone(acknowledgedCheckpoint)) {
                throw new Error("Invalid persisted resumable RPC stream state");
              }

              const rebuilt = declaration.rebuild({
                subscriptionKey: persisted.subscriptionKey,
                resumeDescriptor: resumeDescriptor.value,
                acknowledgedCheckpoint: acknowledgedCheckpoint.value,
              });
              const request = {
                _tag: "Request" as const,
                id: persisted.requestId,
                tag: declaration.rpcTag,
                payload: rebuilt.payload,
                headers:
                  rebuilt.headers?.map(([name, value]): [string, string] => [name, value]) ?? [],
              };

              if (rebuilt.traceId !== undefined) {
                Object.assign(request, { traceId: rebuilt.traceId });
              }

              if (rebuilt.spanId !== undefined) {
                Object.assign(request, { spanId: rebuilt.spanId });
              }

              if (rebuilt.sampled !== undefined) {
                Object.assign(request, { sampled: rebuilt.sampled });
              }

              subscriptions.push({
                ...persisted,
                resumeDescriptor: resumeDescriptor.value,
                acknowledgedCheckpoint: acknowledgedCheckpoint.value,
                declaration,
              });
              requests.push(request);
            }

            return { _tag: "Success" as const, requests, subscriptions };
          } catch (cause) {
            return { _tag: "Failure" as const, cause };
          }
        });

        if (prepared._tag === "Failure") {
          yield* Effect.logDebug("Invalid resumable RPC websocket attachment", prepared.cause);
          yield* resetSocket(socket);
          continue;
        }

        if (connectionsById.has(metadata.clientId)) {
          yield* resetSocket(socket);
          continue;
        }

        const connection = register(socket, metadata, prepared.subscriptions);

        for (const request of prepared.requests) {
          replayRequests.push({ clientId: connection.id, request });
        }
      }

      yield* syncHeartbeat();

      const send = (connection: RpcConnection, response: RpcMessage.FromServerEncoded) =>
        Effect.gen(function* () {
          let delivered = response;

          if (response._tag === "Chunk") {
            const subscription = connection.subscriptionsByRequestId.get(response.requestId);

            if (subscription !== undefined) {
              const checkpointTokens = yield* Effect.sync(() => {
                const tokens: Array<string> = [];

                for (const value of response.values) {
                  const checkpoint = subscription.declaration.checkpointFromValue(value);

                  if (Option.isNone(checkpoint)) {
                    throw new Error(
                      `Resumable RPC stream ${subscription.definitionId} did not identify a checkpoint`,
                    );
                  }

                  const token = subscription.declaration.checkpointToken(checkpoint.value);

                  if (token.length === 0 || tokens.includes(token)) {
                    throw new Error(
                      `Resumable RPC stream ${subscription.definitionId} produced invalid checkpoint tokens`,
                    );
                  }

                  tokens.push(token);
                }

                if (tokens.length === 0) {
                  throw new Error("Resumable RPC stream chunks must contain checkpointed values");
                }

                return tokens;
              });

              subscription.pending = {
                checkpointTokens,
              };
              connection.currentPendingRequestIds.add(subscription.requestId);

              if (!(yield* persistOrReset(connection))) {
                return;
              }
            }
          }

          const enqueued = yield* Effect.sync(() => {
            try {
              const encoded = connection.parser.encode(response);

              if (encoded === undefined) {
                return false;
              }

              connection.socket.raw.send(encoded);

              return true;
            } catch (cause) {
              delivered = RpcMessage.ResponseDefectEncoded(cause);
              const encoded = connection.parser.encode(delivered);

              if (encoded === undefined) {
                return false;
              }

              connection.socket.raw.send(encoded);

              return true;
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logDebug("Durable Object RPC websocket send failed", cause).pipe(
                Effect.as(false),
              ),
            ),
          );

          if (!enqueued) {
            resetSockets.add(connection.socket.raw);
            yield* connection.socket
              .close(serviceRestartCode, serviceRestartReason)
              .pipe(Effect.ignore);
            yield* unregister(connection.socket);

            return;
          }

          if (delivered._tag === "Exit") {
            yield* completeRequest(connection, delivered.requestId);
          } else if (delivered._tag === "Defect" || delivered._tag === "ClientProtocolError") {
            yield* completeAllRequests(connection);
          }
        });

      const protocol = yield* RpcServer.Protocol.make((writeRequest_) => {
        writeRequest = writeRequest_;

        return Effect.succeed({
          disconnects,
          send: (clientId, response) => {
            const connection = connectionsById.get(clientId);

            return connection === undefined ? Effect.void : send(connection, response);
          },
          end: (clientId) =>
            Effect.sync(() => {
              const connection = connectionsById.get(clientId);

              connection?.socket.raw.close();
            }),
          clientIds: Effect.sync(() => clientIds),
          initialMessage: Effect.succeedNone,
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: true,
        });
      });

      const replay = writeRequest;

      if (replay === undefined) {
        return yield* Effect.die(
          new Error("RPC server protocol did not install its request writer"),
        );
      }

      for (const restoredRequest of replayRequests) {
        yield* replay(restoredRequest.clientId, restoredRequest.request);
      }

      const checkpoint = Effect.fn("DurableObjectRpcWebSocket.checkpoint")(function* <
        ResumeDescriptor,
        Checkpoint,
      >(
        declaration: ResumableStreamDeclaration<ResumeDescriptor, Checkpoint>,
        checkpointOptions: {
          readonly clientId: number;
          readonly subscriptionKey: string;
          readonly checkpoint: Checkpoint;
        },
      ): Effect.fn.Return<boolean, DurableWebSocketAttachmentError> {
        const connection = connectionsById.get(checkpointOptions.clientId);
        const configured = declarationsById.get(declaration.id);
        const subscription = connection?.subscriptionsByDefinition
          .get(declaration.id)
          ?.get(checkpointOptions.subscriptionKey);

        if (
          connection === undefined ||
          configured === undefined ||
          configured.rpcTag !== declaration.rpcTag ||
          subscription === undefined ||
          subscription.pending === undefined
        ) {
          return false;
        }

        const token = configured.checkpointToken(checkpointOptions.checkpoint);
        const checkpointIndex = subscription.pending.checkpointTokens.indexOf(token);

        if (token.length === 0 || checkpointIndex < 0) {
          return false;
        }

        const pending = subscription.pending;
        const isFinal = checkpointIndex === pending.checkpointTokens.length - 1;
        const shouldAck =
          isFinal && connection.currentPendingRequestIds.has(subscription.requestId);

        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            subscription.acknowledgedCheckpoint = checkpointOptions.checkpoint;

            if (isFinal) {
              connection.currentPendingRequestIds.delete(subscription.requestId);
              delete subscription.pending;
            } else {
              subscription.pending = {
                checkpointTokens: pending.checkpointTokens.slice(checkpointIndex + 1),
              };
            }

            yield* persistConnection(connection).pipe(
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  yield* resetSocket(connection.socket, cause);

                  return yield* cause;
                }),
              ),
            );

            if (shouldAck) {
              const run = writeRequest;

              if (run === undefined) {
                return yield* Effect.die(
                  new Error("RPC server is not ready to accept a checkpoint Ack"),
                );
              }

              yield* run(connection.id, {
                _tag: "Ack",
                requestId: subscription.requestId,
              });
            }

            return true;
          }),
        );
      });

      const service = DurableObjectRpcWebSocket.of({
        accept: (socket, tags = []) =>
          Effect.gen(function* () {
            register(socket);
            yield* durableObjectState.acceptWebSocket(socket, Array.from(new Set([tag, ...tags])));
            yield* syncHeartbeat();
          }),
        acceptUpgrade: <Attachment extends RpcWebSocketAttachment>(
          upgradeOptions: AcceptUpgradeOptions<Attachment> = {},
        ) =>
          Effect.gen(function* () {
            const pair = new WebSocketPair();
            const client = pair[0];
            const server = fromWebSocket<Attachment>(pair[1]);

            if (upgradeOptions.attachment !== undefined) {
              yield* server.serializeAttachment(upgradeOptions.attachment);
            }

            yield* service.accept(server, upgradeOptions.tags);

            return {
              client,
              server,
              response: new Response(null, {
                status: 101,
                webSocket: client,
              }),
            };
          }),
        message: (socket, message) =>
          Effect.gen(function* () {
            if (resetSockets.has(socket.raw)) {
              return;
            }

            const connection = register(socket);
            const decoded = yield* Effect.try({
              try: () => connection.parser.decode(normalizeMessage(message)),
              catch: (cause) => cause,
            });

            const run = writeRequest;

            if (run === undefined) {
              yield* send(connection, RpcMessage.ResponseDefectEncoded("RPC server is not ready"));

              return;
            }

            for (const current of decoded) {
              // SAFETY: this parser was created by the configured RPC serialization service.
              const request = current as RpcMessage.FromClientEncoded;

              if (request._tag === "Request" && request.isNotification !== true) {
                if (!(yield* trackRequest(connection, request))) {
                  return;
                }
              }

              if (
                request._tag === "Ack" &&
                (connection.subscriptionsByRequestId.has(request.requestId) ||
                  connection.suppressedAckRequestIds.has(request.requestId))
              ) {
                continue;
              }

              if (
                request._tag === "Interrupt" &&
                connection.subscriptionsByRequestId.has(request.requestId)
              ) {
                yield* completeRequest(connection, request.requestId, true);
              }

              yield* run(connection.id, request);

              if (
                request._tag === "Interrupt" &&
                !connection.suppressedAckRequestIds.has(request.requestId)
              ) {
                yield* completeRequest(connection, request.requestId);
              }
            }
          }).pipe(
            Effect.catch((cause) => {
              const connection = register(socket);

              return Predicate.isTagged(cause, "MaxBufferSizeExceeded")
                ? Effect.ignore(connection.socket.close(1009, String(cause)))
                : send(connection, RpcMessage.ResponseDefectEncoded(cause));
            }),
          ),
        close: unregister,
        error: resetSocket,
        checkpoint,
      });

      return Context.mergeAll(
        Context.make(RpcServer.Protocol, protocol),
        Context.make(DurableObjectRpcWebSocket, service),
      );
    }),
  );

const normalizeMessage = (message: NativeWebSocketMessage) =>
  Predicate.isString(message) ? message : new Uint8Array(message);

type AttachmentRead =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Invalid" }
  | { readonly _tag: "Valid"; readonly metadata: AttachmentMetadata };

const readAttachment = (socket: WebSocket, key: string): AttachmentRead => {
  const value = socket.deserializeAttachment();

  if (value === null || value === undefined) {
    return { _tag: "Missing" };
  }

  if (!Predicate.isObject(value)) {
    return { _tag: "Invalid" };
  }

  if (!Predicate.hasProperty(value, key)) {
    return { _tag: "Missing" };
  }

  const metadata = value[key];

  if (Predicate.isNumber(metadata) && isClientId(metadata)) {
    return {
      _tag: "Valid",
      metadata: {
        version: legacyAttachmentVersion,
        clientId: metadata,
        hasPendingRequests: false,
      },
    };
  }

  if (!Predicate.isObject(metadata)) {
    return { _tag: "Invalid" };
  }

  if (
    Predicate.hasProperty(metadata, "version") &&
    metadata.version === resumableAttachmentVersion
  ) {
    const decoded = decodeResumableAttachment(metadata);

    return Option.isSome(decoded) && isClientId(decoded.value.clientId)
      ? { _tag: "Valid", metadata: decoded.value }
      : { _tag: "Invalid" };
  }

  const hasPendingRequests = Predicate.hasProperty(metadata, "hasPendingRequests")
    ? metadata.hasPendingRequests
    : false;

  if (
    (!Predicate.hasProperty(metadata, "version") || metadata.version === legacyAttachmentVersion) &&
    Predicate.hasProperty(metadata, "clientId") &&
    Predicate.isNumber(metadata.clientId) &&
    isClientId(metadata.clientId) &&
    Predicate.isBoolean(hasPendingRequests)
  ) {
    return {
      _tag: "Valid",
      metadata: {
        version: legacyAttachmentVersion,
        clientId: metadata.clientId,
        hasPendingRequests,
      },
    };
  }

  return { _tag: "Invalid" };
};

const isClientId = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const writeAttachment = (socket: WebSocket, key: string, metadata: AttachmentMetadata) => {
  const current = socket.deserializeAttachment();

  if (current !== null && current !== undefined && !Predicate.isObject(current)) {
    throw new Error(
      "DurableObjectRpcWebSocket requires object-shaped websocket attachments so adapter metadata can preserve application fields",
    );
  }

  const attachment = Predicate.isObject(current) ? current : {};
  const currentMetadata =
    Predicate.hasProperty(attachment, key) && Predicate.isObject(attachment[key])
      ? attachment[key]
      : {};

  socket.serializeAttachment({
    ...attachment,
    [key]: {
      ...currentMetadata,
      ...metadata,
    },
  });
};

interface HeartbeatController {
  readonly setEnabled: (enabled: boolean) => Effect.Effect<void>;
}

const makeHeartbeatController = (
  state: DurableObjectState["Service"],
  serialization: RpcSerialization.RpcSerialization["Service"],
  policy: HeartbeatPolicy,
): Effect.Effect<HeartbeatController> =>
  Effect.gen(function* () {
    if (policy === "passthrough") {
      return { setEnabled: () => Effect.void };
    }

    const parser = serialization.makeUnsafe();
    const request = parser.encode(RpcMessage.constPing);
    const response = parser.encode(RpcMessage.constPong);

    if (!Predicate.isString(request) || !Predicate.isString(response)) {
      return yield* Effect.die(
        new Error(
          'DurableObjectRpcWebSocket heartbeat auto-response requires a text RPC serialization; use heartbeat: "passthrough" to manage heartbeats externally',
        ),
      );
    }

    const configured = yield* state.getWebSocketAutoResponse;

    if (
      configured !== null &&
      (configured.request !== request || configured.response !== response)
    ) {
      return yield* Effect.die(
        new Error(
          'DurableObjectRpcWebSocket cannot replace the application WebSocket auto-response; use heartbeat: "passthrough" to preserve it',
        ),
      );
    }

    const pair = new WebSocketRequestResponsePair(request, response);
    let enabled = configured !== null;

    return {
      setEnabled: (nextEnabled: boolean) => {
        if (enabled === nextEnabled) {
          return Effect.void;
        }

        return state.setWebSocketAutoResponse(nextEnabled ? pair : undefined).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              enabled = nextEnabled;
            }),
          ),
        );
      },
    };
  });
