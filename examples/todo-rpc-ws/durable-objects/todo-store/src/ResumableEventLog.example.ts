import { Context, Effect, Layer, Option, PubSub, Schema, Semaphore, Stream } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import {
  type DurableObjectStorage,
  DurableObject,
  DurableObjectRpcWebSocket,
  DurableObjectState,
  Worker,
} from "effect-cf";

const DurableEvent = Schema.Struct({
  cursor: Schema.Int,
  topic: Schema.String,
  value: Schema.String,
});

type DurableEvent = typeof DurableEvent.Type;

class EventLogError extends Schema.TaggedError<EventLogError>()("EventLogError", {
  message: Schema.String,
}) {}

class SubscribeEvents extends Rpc.make("SubscribeEvents", {
  payload: {
    subscriptionKey: Schema.String,
    topic: Schema.String,
    after: Schema.Int,
  },
  success: DurableEvent,
  error: EventLogError,
  stream: true,
}) {}

class AppendEvent extends Rpc.make("AppendEvent", {
  payload: { topic: Schema.String, value: Schema.String },
  success: DurableEvent,
  error: EventLogError,
}) {}

class CheckpointSubscription extends Rpc.make("CheckpointSubscription", {
  payload: { subscriptionKey: Schema.String, cursor: Schema.Int },
  success: Schema.Struct({ advanced: Schema.Boolean }),
  error: EventLogError,
}) {}

class EventRpcs extends RpcGroup.make(SubscribeEvents, AppendEvent, CheckpointSubscription) {}

const SubscribePayload = Schema.Struct({
  subscriptionKey: Schema.String,
  topic: Schema.String,
  after: Schema.Int,
});
const SubscribeResumeDescriptor = Schema.Struct({
  topic: Schema.String,
});
const decodeSubscribePayload = Schema.decodeUnknownOption(SubscribePayload);
const decodeDurableEvent = Schema.decodeUnknownOption(DurableEvent);

const SubscribeEventsResume = DurableObjectRpcWebSocket.resumableStream({
  id: "todo-events/v1",
  rpcTag: "SubscribeEvents",
  resumeDescriptorSchema: SubscribeResumeDescriptor,
  checkpointSchema: Schema.Int,
  identify: (request) =>
    Option.map(decodeSubscribePayload(request.payload), (payload) => ({
      subscriptionKey: payload.subscriptionKey,
      resumeDescriptor: { topic: payload.topic },
      acknowledgedCheckpoint: payload.after,
    })),
  rebuild: ({ subscriptionKey, resumeDescriptor, acknowledgedCheckpoint }) => ({
    payload: {
      subscriptionKey,
      topic: resumeDescriptor.topic,
      after: acknowledgedCheckpoint,
    },
  }),
  checkpointFromValue: (value) => Option.map(decodeDurableEvent(value), (event) => event.cursor),
  // Distinct events never share a cursor. A replay of the same event does.
  checkpointToken: String,
});

interface EventRow {
  readonly [key: string]: DurableObjectStorage.SqlStorageValue;
  readonly cursor: number;
  readonly topic: string;
  readonly value: string;
}

const fromRow = (row: EventRow): DurableEvent => ({
  cursor: row.cursor,
  topic: row.topic,
  value: row.value,
});

class EventLog extends Context.Service<
  EventLog,
  {
    readonly append: (
      topic: string,
      value: string,
    ) => Effect.Effect<DurableEvent, DurableObjectStorage.StorageOperationError>;
    readonly after: (
      topic: string,
      cursor: number,
    ) => Stream.Stream<DurableEvent, DurableObjectStorage.StorageOperationError>;
  }
>()("todo-rpc-ws/EventLog") {
  static readonly layer = Layer.effect(
    EventLog,
    Effect.gen(function* () {
      const state = yield* DurableObjectState.DurableObjectState;
      const sql = state.storage.sql;
      const live = yield* PubSub.unbounded<DurableEvent>();
      const lock = yield* Semaphore.make(1);

      yield* Effect.addFinalizer(() => PubSub.shutdown(live));

      const ensureSchema = sql.exec(
        "CREATE TABLE IF NOT EXISTS events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, value TEXT NOT NULL)",
      );

      const append = Effect.fn("EventLog.append")(function* (topic: string, value: string) {
        return yield* lock.withPermit(
          Effect.gen(function* () {
            yield* ensureSchema;
            const result = yield* sql.exec<EventRow>(
              "INSERT INTO events (topic, value) VALUES (?, ?) RETURNING cursor, topic, value",
              topic,
              value,
            );
            const event = fromRow(yield* result.one());

            yield* PubSub.publish(live, event);

            return event;
          }),
        );
      });

      const after = (topic: string, cursor: number) =>
        Stream.unwrap(
          lock.withPermit(
            Effect.gen(function* () {
              const subscription = yield* PubSub.subscribe(live);

              yield* ensureSchema;
              const result = yield* sql.exec<EventRow>(
                "SELECT cursor, topic, value FROM events WHERE topic = ? AND cursor > ? ORDER BY cursor ASC",
                topic,
                cursor,
              );
              const backlog = (yield* result.toArray()).map(fromRow);

              return Stream.fromIterable(backlog).pipe(
                Stream.concat(Stream.fromSubscription(subscription)),
                Stream.filter((event) => event.topic === topic && event.cursor > cursor),
                Stream.rechunk(1),
              );
            }),
          ),
        );

      return EventLog.of({ append, after });
    }),
  );
}

const toEventLogError = () => EventLogError.make({ message: "event log operation failed" });

const EventHandlers = EventRpcs.toLayer({
  SubscribeEvents: ({ topic, after }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const log = yield* EventLog;

        return log.after(topic, after);
      }),
    ).pipe(Stream.mapError(toEventLogError)),
  AppendEvent: ({ topic, value }) =>
    Effect.gen(function* () {
      const log = yield* EventLog;

      return yield* log.append(topic, value).pipe(Effect.mapError(toEventLogError));
    }),
  CheckpointSubscription: ({ subscriptionKey, cursor }, { client }) =>
    Effect.gen(function* () {
      const transport = yield* DurableObjectRpcWebSocket.DurableObjectRpcWebSocket;
      const advanced = yield* transport
        .checkpoint(SubscribeEventsResume, {
          clientId: client.id,
          subscriptionKey,
          checkpoint: cursor,
        })
        .pipe(Effect.mapError(toEventLogError));

      return { advanced };
    }),
});

const TransportLive = DurableObjectRpcWebSocket.layer({
  tag: "todo-event-rpc",
  resumableStreams: [SubscribeEventsResume],
});

const EventHandlersLive = EventHandlers.pipe(
  Layer.provideMerge(TransportLive),
  Layer.provideMerge(EventLog.layer),
);

const EventRpcLive = RpcServer.layer(EventRpcs).pipe(
  Layer.provideMerge(EventHandlersLive),
  Layer.provide(RpcSerialization.layerJson),
);

const ResumableEventLogObjectLive = DurableObject.make(EventRpcLive, {
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;

    if (!Worker.isWebSocketUpgrade(request)) {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const transport = yield* DurableObjectRpcWebSocket.DurableObjectRpcWebSocket;
    const upgrade = yield* transport.acceptUpgrade({
      tags: ["application:todo-events"],
      attachment: { application: "todo-rpc-ws" },
    });

    return upgrade.response;
  }),
  webSocketMessage: (socket, message) =>
    Effect.gen(function* () {
      const transport = yield* DurableObjectRpcWebSocket.DurableObjectRpcWebSocket;

      yield* transport.message(socket, message);
    }),
  webSocketClose: (socket) =>
    Effect.gen(function* () {
      const transport = yield* DurableObjectRpcWebSocket.DurableObjectRpcWebSocket;

      yield* transport.close(socket);
    }),
  webSocketError: (socket, cause) =>
    Effect.gen(function* () {
      const transport = yield* DurableObjectRpcWebSocket.DurableObjectRpcWebSocket;

      yield* transport.error(socket, cause);
    }),
});

/** Illustrative export. Add this class to Wrangler before deploying it. */
export class ResumableEventLogDurableObject extends ResumableEventLogObjectLive {}
