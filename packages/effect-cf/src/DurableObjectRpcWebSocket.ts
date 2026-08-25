import { Context, Effect, Layer, Predicate, Queue } from "effect";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import { DurableObjectState } from "./DurableObjectState";
import {
  type AcceptedUpgrade,
  type AcceptUpgradeOptions,
  type DurableWebSocket,
  type DurableWebSocketAttachmentError,
  fromWebSocket,
} from "./DurableObjectWebSocket";

const defaultAttachmentKey = "effectCloudflareRpcClientId";
const defaultTag = "effect-cf-rpc";
const attachmentVersion = 1;
const serviceRestartCode = 1012;
const serviceRestartReason = "Durable Object RPC activation reset";

/** Heartbeat handling for Effect's application-level RPC Ping messages. */
export type HeartbeatPolicy = "auto-response" | "passthrough";

/** Object-shaped application attachment fields that can coexist with adapter metadata. */
export type RpcWebSocketAttachment = object;

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
   * RPC operation is active, then removes it while a call or stream is pending.
   * `"passthrough"` leaves the Durable Object's existing auto-response
   * configuration unchanged and makes the application responsible for waking a
   * lost pending operation.
   * Cloudflare's pair is global to the Durable Object, so use `"passthrough"`
   * when RPC and unrelated websocket protocols share one object.
   */
  readonly heartbeat?: HeartbeatPolicy | undefined;
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
}

interface RpcConnection {
  readonly id: number;
  readonly socket: DurableWebSocket;
  readonly parser: RpcSerialization.Parser;
  readonly requestIds: Set<string | number>;
}

interface AttachmentMetadata {
  readonly clientId: number;
  readonly hasPendingRequests: boolean;
}

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
 * The layer restores idle tagged sockets after constructor recreation. A socket
 * that lost an in-flight non-notification call or stream is instead closed with
 * code 1012, which the stock Effect socket protocol reports as an
 * `RpcClientError` containing `SocketCloseError`. Requests are never replayed.
 * Streams and Effect fibers do not resume across activation loss.
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
      const durableObjectState = yield* DurableObjectState;
      const serialization = yield* RpcSerialization.RpcSerialization;
      const disconnects = yield* Queue.make<number>();
      const connectionsBySocket = new Map<WebSocket, RpcConnection>();
      const connectionsById = new Map<number, RpcConnection>();
      const clientIds = new Set<number>();
      const resetSockets = new WeakSet<WebSocket>();
      let nextClientId = 0;
      let activeRequestCount = 0;
      let writeRequest:
        | ((clientId: number, data: RpcMessage.FromClientEncoded) => Effect.Effect<void>)
        | undefined;

      const reserveClientId = (socket: DurableWebSocket) => {
        const metadata = readAttachment(socket.raw, attachmentKey);

        if (metadata !== undefined) {
          nextClientId = Math.max(nextClientId, metadata.clientId + 1);
          writeAttachment(socket.raw, attachmentKey, metadata);

          return metadata;
        }

        const id = nextClientId++;
        const created = { clientId: id, hasPendingRequests: false };

        writeAttachment(socket.raw, attachmentKey, created);

        return created;
      };

      const register = (socket: DurableWebSocket) => {
        const existing = connectionsBySocket.get(socket.raw);

        if (existing !== undefined) {
          return existing;
        }

        const metadata = reserveClientId(socket);
        const connection = {
          id: metadata.clientId,
          socket,
          parser: serialization.makeUnsafe(),
          requestIds: new Set<string | number>(),
        } satisfies RpcConnection;

        connectionsBySocket.set(socket.raw, connection);
        connectionsById.set(connection.id, connection);
        clientIds.add(connection.id);

        return connection;
      };

      const heartbeat = yield* makeHeartbeatController(
        durableObjectState,
        serialization,
        heartbeatPolicy,
      );

      const syncHeartbeat = () =>
        heartbeat.setEnabled(connectionsBySocket.size > 0 && activeRequestCount === 0);

      const persistConnection = (connection: RpcConnection) =>
        writeAttachment(connection.socket.raw, attachmentKey, {
          clientId: connection.id,
          hasPendingRequests: connection.requestIds.size > 0,
        });

      const trackRequest = (connection: RpcConnection, requestId: string | number) =>
        Effect.gen(function* () {
          if (!connection.requestIds.has(requestId)) {
            connection.requestIds.add(requestId);
            activeRequestCount++;
            persistConnection(connection);
          }

          yield* syncHeartbeat();
        });

      const completeRequest = (connection: RpcConnection, requestId: string | number) =>
        Effect.gen(function* () {
          if (connection.requestIds.delete(requestId)) {
            activeRequestCount--;
            persistConnection(connection);
          }

          yield* syncHeartbeat();
        });

      const completeAllRequests = (connection: RpcConnection) =>
        Effect.gen(function* () {
          if (connection.requestIds.size > 0) {
            activeRequestCount -= connection.requestIds.size;
            connection.requestIds.clear();
            persistConnection(connection);
          }

          yield* syncHeartbeat();
        });

      const unregister = (socket: DurableWebSocket) =>
        Effect.gen(function* () {
          const connection = connectionsBySocket.get(socket.raw);

          if (connection === undefined) {
            return;
          }

          connectionsBySocket.delete(socket.raw);
          connectionsById.delete(connection.id);
          clientIds.delete(connection.id);
          activeRequestCount -= connection.requestIds.size;
          connection.requestIds.clear();
          Queue.offerUnsafe(disconnects, connection.id);

          yield* syncHeartbeat();
        });

      const restored = yield* durableObjectState.getWebSockets(tag);

      for (const socket of restored) {
        const metadata = reserveClientId(socket);

        if (metadata.hasPendingRequests) {
          resetSockets.add(socket.raw);
          yield* socket.close(serviceRestartCode, serviceRestartReason).pipe(Effect.orDie);
        } else {
          register(socket);
        }
      }

      yield* syncHeartbeat();

      const send = (connection: RpcConnection, response: RpcMessage.FromServerEncoded) =>
        Effect.gen(function* () {
          let delivered = response;

          yield* Effect.sync(() => {
            try {
              const encoded = connection.parser.encode(response);

              if (encoded !== undefined) {
                connection.socket.raw.send(encoded);
              }
            } catch (cause) {
              delivered = RpcMessage.ResponseDefectEncoded(cause);
              const encoded = connection.parser.encode(delivered);

              if (encoded !== undefined) {
                connection.socket.raw.send(encoded);
              }
            }
          });

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
                yield* trackRequest(connection, request.id);
              }

              yield* run(connection.id, request);

              if (request._tag === "Interrupt") {
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
        error: (socket, cause) =>
          Effect.gen(function* () {
            yield* Effect.logDebug("Durable Object RPC websocket error", cause);
            yield* unregister(socket);
          }),
      });

      return Context.mergeAll(
        Context.make(RpcServer.Protocol, protocol),
        Context.make(DurableObjectRpcWebSocket, service),
      );
    }),
  );

const normalizeMessage = (message: NativeWebSocketMessage) =>
  Predicate.isString(message) ? message : new Uint8Array(message);

const readAttachment = (socket: WebSocket, key: string): AttachmentMetadata | undefined => {
  const value = socket.deserializeAttachment();

  if (
    Predicate.isObject(value) &&
    Predicate.hasProperty(value, key) &&
    Predicate.isNumber(value[key])
  ) {
    return { clientId: value[key], hasPendingRequests: false };
  }

  if (
    Predicate.isObject(value) &&
    Predicate.hasProperty(value, key) &&
    Predicate.isObject(value[key]) &&
    Predicate.hasProperty(value[key], "clientId") &&
    Predicate.isNumber(value[key].clientId)
  ) {
    return {
      clientId: value[key].clientId,
      hasPendingRequests:
        Predicate.hasProperty(value[key], "hasPendingRequests") &&
        Predicate.isBoolean(value[key].hasPendingRequests)
          ? value[key].hasPendingRequests
          : false,
    };
  }

  return undefined;
};

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
      version: attachmentVersion,
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

        enabled = nextEnabled;

        return state.setWebSocketAutoResponse(nextEnabled ? pair : undefined);
      },
    };
  });
