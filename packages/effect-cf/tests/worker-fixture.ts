import {
  Context,
  Effect,
  Layer,
  Option,
  Predicate,
  PubSub,
  Schema as S,
  Semaphore,
  Stream,
} from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import * as ComputerWorkspace from "../src/ComputerWorkspace";
import {
  DurableObject,
  DurableObjectDefinition,
  DurableObjectRpcWebSocket,
  DurableObjectState,
  Worker,
  WorkerDefinition,
  Workflow,
} from "../src/index";
import { withComputerWorkspace } from "../src/ComputerWorkspaceHost";

export { TestTracingDurableObject, TestTracingWorker } from "./rpc-tracing-fixture";

export const TestWorkerDefinition = WorkerDefinition.make("TestWorker", {
  parseNumber: WorkerDefinition.method({
    args: [S.NumberFromString] as const,
    success: S.NumberFromString,
  }),
});

export const TestCounterDefinition = DurableObjectDefinition.make("TestCounter", {
  increment: DurableObjectDefinition.method({
    args: [S.NumberFromString] as const,
    success: S.NumberFromString,
  }),
  get: DurableObjectDefinition.method({
    success: S.Number,
  }),
});

const ComputerWorkspaceResult = S.Struct({
  text: S.String,
  bytes: S.Array(S.Number),
  directoryNames: S.Array(S.String),
  foundPaths: S.Array(S.String),
  grepLines: S.Array(S.Number),
  linkTarget: S.String,
  commit: S.String,
  branch: S.String,
  branches: S.Array(S.String),
  tags: S.Array(S.String),
  logMessage: S.String,
  shownMessage: S.String,
  files: S.Array(S.String),
  treePaths: S.Array(S.String),
  statusPaths: S.Array(S.String),
  diffContainsUpdate: S.Boolean,
  configValue: S.String,
});

export const TestComputerWorkspaceDefinition = DurableObjectDefinition.make(
  "TestComputerWorkspace",
  {
    exercise: DurableObjectDefinition.method({ success: ComputerWorkspaceResult }),
  },
);

const CounterValue = S.Struct({ count: S.Number });

const TestWorkerLive = TestWorkerDefinition.make(Layer.empty, {
  fetch: Effect.sync(() => new Response("Test WorkerEntrypoint", { status: 404 })),
  rpc: {
    parseNumber: (value) => Effect.succeed(value + 1),
  },
});

export class TestWorkerEntrypoint extends TestWorkerLive {}

const TestCounterLive = TestCounterDefinition.make(Layer.empty, {
  rpc: {
    increment: (amount) =>
      Effect.gen(function* () {
        const state = yield* DurableObjectState.DurableObjectState;
        const counters = state.storage.kv.schema({
          key: S.String,
          value: CounterValue,
        });
        const current = yield* counters.get("counter");
        const next = (Option.isSome(current) ? current.value.count : 0) + amount;

        yield* counters.put("counter", { count: next });

        return next;
      }),
    get: () =>
      Effect.gen(function* () {
        const state = yield* DurableObjectState.DurableObjectState;
        const counters = state.storage.kv.schema({
          key: S.String,
          value: CounterValue,
        });
        const current = yield* counters.get("counter");

        return Option.isSome(current) ? current.value.count : 0;
      }),
  },
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;
    const url = new URL(request.url);
    const amount = url.searchParams.get("amount") ?? "1";
    const state = yield* DurableObjectState.DurableObjectState;
    const counters = state.storage.kv.schema({
      key: S.String,
      value: CounterValue,
    });
    const current = yield* counters.get("counter");
    const next = (Option.isSome(current) ? current.value.count : 0) + Number(amount);

    yield* counters.put("counter", { count: next });

    return Response.json({ count: next });
  }),
  alarm: () =>
    Effect.gen(function* () {
      const state = yield* DurableObjectState.DurableObjectState;

      yield* state.storage.put("count", { count: 0 });
    }),
});

export class TestCounterDurableObject extends TestCounterLive {
  readonly instanceId = crypto.randomUUID();
}

export class HibernationPingResult extends S.Class<HibernationPingResult>("HibernationPingResult")({
  nonce: S.String,
}) {}

export class HibernationPing extends Rpc.make("HibernationPing", {
  payload: { nonce: S.String },
  success: HibernationPingResult,
}) {}

export class HibernationNever extends Rpc.make("HibernationNever", {
  payload: { nonce: S.String },
  success: S.Void,
}) {}

export class HibernationIncrement extends Rpc.make("HibernationIncrement", {
  payload: { value: S.BigInt },
  success: S.BigInt,
}) {}

export class HibernationEvent extends S.Class<HibernationEvent>("HibernationEvent")({
  cursor: S.Finite,
  value: S.String,
}) {}

export class HibernationAppendEvent extends Rpc.make("HibernationAppendEvent", {
  payload: { value: S.String },
  success: HibernationEvent,
}) {}

export class HibernationEvents extends Rpc.make("HibernationEvents", {
  payload: { subscriptionKey: S.String, after: S.Finite, until: S.Finite },
  success: HibernationEvent,
  stream: true,
}) {}

export class HibernationCheckpointSubscription extends Rpc.make(
  "HibernationCheckpointSubscription",
  {
    payload: { subscriptionKey: S.String, checkpoint: S.Finite },
    success: S.Boolean,
  },
) {}

export class HibernationNonResumableEvents extends Rpc.make("HibernationNonResumableEvents", {
  success: HibernationEvent,
  stream: true,
}) {}

export class HibernationRpcs extends RpcGroup.make(
  HibernationPing,
  HibernationIncrement,
  HibernationNever,
  HibernationAppendEvent,
  HibernationEvents,
  HibernationCheckpointSubscription,
  HibernationNonResumableEvents,
) {}

const HibernationEventsPayload = S.Struct({
  subscriptionKey: S.String,
  after: S.Finite,
  until: S.Finite,
});
const HibernationEventsResumeDescriptor = S.Struct({
  subscriptionKey: S.String,
  until: S.Finite,
});
const decodeHibernationEventsPayload = S.decodeUnknownOption(HibernationEventsPayload);
const decodeHibernationEvent = S.decodeUnknownOption(HibernationEvent);

export const HibernationEventsResume = DurableObjectRpcWebSocket.resumableStream({
  id: "workerd-hibernation-events/v1",
  rpcTag: "HibernationEvents",
  resumeDescriptorSchema: HibernationEventsResumeDescriptor,
  checkpointSchema: S.Finite,
  identify: (request) =>
    Option.map(
      decodeHibernationEventsPayload(request.payload),
      ({ after, subscriptionKey, until }) => ({
        subscriptionKey,
        resumeDescriptor: { subscriptionKey, until },
        acknowledgedCheckpoint: after,
      }),
    ),
  rebuild: ({ resumeDescriptor, acknowledgedCheckpoint }) => ({
    payload: {
      subscriptionKey: resumeDescriptor.subscriptionKey,
      after: acknowledgedCheckpoint,
      until: resumeDescriptor.until,
    },
    headers: [],
  }),
  checkpointFromValue: (value) =>
    Option.map(decodeHibernationEvent(value), (event) => event.cursor),
  checkpointToken: String,
});

interface HibernationEventLogService {
  readonly events: PubSub.PubSub<HibernationEvent>;
  readonly lock: Semaphore.Semaphore;
}

class HibernationEventLog extends Context.Service<
  HibernationEventLog,
  HibernationEventLogService
>()("effect-cf/tests/HibernationEventLog") {}

const HibernationEventLogLive = Layer.effect(
  HibernationEventLog,
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<HibernationEvent>();
    const lock = yield* Semaphore.make(1);

    return { events, lock };
  }),
);

const hibernationEventLogStorageKey = "hibernation-events";

const readHibernationEvents = Effect.gen(function* () {
  const state = yield* DurableObjectState.DurableObjectState;
  const events = yield* state.storage.get<
    Array<{ readonly cursor: number; readonly value: string }>
  >(hibernationEventLogStorageKey);

  return (events ?? []).map((event) => HibernationEvent.make(event));
}).pipe(Effect.orDie);

const HibernationRpcHandlers = HibernationRpcs.toLayer(
  Effect.gen(function* () {
    const eventLog = yield* HibernationEventLog;
    const transport = yield* DurableObjectRpcWebSocket.DurableObjectRpcWebSocket;

    return HibernationRpcs.of({
      HibernationAppendEvent: ({ value }) =>
        eventLog.lock.withPermit(
          Effect.gen(function* () {
            const state = yield* DurableObjectState.DurableObjectState;
            const events = yield* readHibernationEvents;
            const event = HibernationEvent.make({
              cursor: (events.at(-1)?.cursor ?? 0) + 1,
              value,
            });

            yield* state.storage
              .put(hibernationEventLogStorageKey, [...events, event])
              .pipe(Effect.orDie);
            yield* PubSub.publish(eventLog.events, event);

            return event;
          }),
        ),
      HibernationEvents: ({ after, until }) =>
        Stream.unwrap(
          eventLog.lock.withPermit(
            Effect.gen(function* () {
              const subscription = yield* PubSub.subscribe(eventLog.events);
              const replay = yield* readHibernationEvents;

              return Stream.fromIterable(replay).pipe(
                Stream.concat(Stream.fromSubscription(subscription)),
                Stream.filter((event) => event.cursor > after),
                Stream.takeUntil((event) => event.cursor >= until),
                Stream.rechunk(1),
              );
            }),
          ),
        ),
      HibernationCheckpointSubscription: ({ checkpoint, subscriptionKey }, { client }) =>
        transport
          .checkpoint(HibernationEventsResume, {
            clientId: client.id,
            subscriptionKey,
            checkpoint,
          })
          .pipe(Effect.orDie),
      HibernationNonResumableEvents: () =>
        Stream.make(HibernationEvent.make({ cursor: 0, value: "non-resumable" })).pipe(
          Stream.concat(Stream.never),
          Stream.rechunk(1),
        ),
      HibernationPing: ({ nonce }) => Effect.succeed(HibernationPingResult.make({ nonce })),
      HibernationIncrement: ({ value }) => Effect.succeed(value + 1n),
      HibernationNever: () =>
        Effect.gen(function* () {
          const state = yield* DurableObjectState.DurableObjectState;
          const starts =
            (yield* state.storage.get<number>("hibernation-never-starts").pipe(Effect.orDie)) ?? 0;

          yield* state.storage.put("hibernation-never-starts", starts + 1).pipe(Effect.orDie);

          return yield* Effect.never;
        }),
    });
  }),
);

const HibernationTransportLive = DurableObjectRpcWebSocket.layer({
  tag: "hibernation-rpc",
  resumableStreams: [HibernationEventsResume],
});

const HibernationRpcHandlersLive = HibernationRpcHandlers.pipe(
  Layer.provideMerge(HibernationEventLogLive),
  Layer.provideMerge(HibernationTransportLive),
);

const HibernationRpcLive = RpcServer.layer(HibernationRpcs).pipe(
  Layer.provideMerge(HibernationRpcHandlersLive),
  Layer.provide(HibernationTransportLive),
  Layer.provide(RpcSerialization.layerJson),
);

const TestHibernationRpcLive = DurableObject.make(HibernationRpcLive, {
  fetch: Effect.gen(function* () {
    const transport = yield* DurableObjectRpcWebSocket.DurableObjectRpcWebSocket;
    const upgrade = yield* transport.acceptUpgrade({
      // This application-owned field is deliberately unrelated to adapter metadata.
      attachment: { application: "survives", applicationMessageCount: 0 },
      tags: ["application-tag"],
    });

    return upgrade.response;
  }),
  webSocketMessage: (socket, message) =>
    Effect.gen(function* () {
      const transport = yield* DurableObjectRpcWebSocket.DurableObjectRpcWebSocket;
      const attachment = socket.raw.deserializeAttachment();
      const current = Predicate.isObject(attachment) ? attachment : {};
      const applicationMessageCount =
        Predicate.hasProperty(current, "applicationMessageCount") &&
        Predicate.isNumber(current.applicationMessageCount)
          ? current.applicationMessageCount
          : 0;

      socket.raw.serializeAttachment({
        ...current,
        applicationMessageCount: applicationMessageCount + 1,
      });

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

/** A hibernatable finite-RPC transport fixture used by the worker-pool lifecycle test. */
export class TestHibernationRpcDurableObject extends TestHibernationRpcLive {
  readonly instanceId = crypto.randomUUID();
}

const TestComputerWorkspaceLive = TestComputerWorkspaceDefinition.make(
  ComputerWorkspace.ComputerWorkspace.layer,
  {
    rpc: {
      exercise: () =>
        Effect.gen(function* () {
          const workspace = yield* ComputerWorkspace.ComputerWorkspace;

          yield* workspace.mkdir("/notes", { recursive: true });
          yield* workspace.writeFile("/notes/todo.md", "Ship it\nTODO verify\n");
          yield* workspace.writeFile("/blob.bin", new Uint8Array([1, 2, 3]));
          yield* workspace.symlink("/notes/todo.md", "/todo-link");
          yield* workspace.chmod("/notes/todo.md", 0o640);

          const text = yield* workspace.readFile("/notes/todo.md", { byteLength: 7 });
          const byteStream = yield* workspace.readFile("/blob.bin", { encoding: "stream" });
          const bytes = yield* Effect.promise(async () =>
            Array.from(new Uint8Array(await new Response(byteStream).arrayBuffer())),
          );
          const directory = yield* workspace.readdir("/");
          const found = yield* workspace.find("/");
          const grep = yield* workspace.grep("todo", "/", { ignoreCase: true });
          const linkTarget = yield* workspace.readlink("/todo-link");

          yield* workspace.git.init({ defaultBranch: "main" });
          yield* workspace.writeFile("/README.md", "first\n");
          yield* workspace.git.add({ paths: ["README.md"] });
          const committed = yield* workspace.git.commit({ message: "initial commit" });

          yield* workspace.git.branch({ name: "feature" });
          yield* workspace.git.tag({ name: "v1" });
          yield* workspace.git.configSet({ path: "effect-cf.test", value: "works" });

          const branch = (yield* workspace.git.currentBranch()) ?? "detached";
          const branches = yield* workspace.git.branchList();
          const tags = yield* workspace.git.tagList();
          const log = yield* workspace.git.log({ maxCount: 1 });
          const shown = yield* workspace.git.show({ ref: "HEAD" });
          const files = yield* workspace.git.lsFiles();
          const tree = yield* workspace.git.lsTree({ ref: "HEAD" });
          const resolved = yield* workspace.git.revParse("HEAD");

          yield* workspace.writeFile("/README.md", "first\nupdated\n");
          const status = yield* workspace.git.status();
          const diff = yield* workspace.git.diff();
          const configValue = yield* workspace.git.configGet({ path: "effect-cf.test" });

          return {
            text,
            bytes,
            directoryNames: directory.map((entry) => entry.name),
            foundPaths: found.map((entry) => entry.path),
            grepLines: grep.map((match) => match.line),
            linkTarget,
            commit: resolved === committed.oid ? committed.oid : "mismatch",
            branch,
            branches,
            tags,
            logMessage: log[0]?.message ?? "",
            shownMessage: shown.message,
            files,
            treePaths: tree.map((entry) => entry.path),
            statusPaths: status.map((entry) => entry.path),
            diffContainsUpdate: diff.includes("updated"),
            configValue: Array.isArray(configValue) ? configValue.join(",") : (configValue ?? ""),
          };
        }),
    },
  },
);

const TestComputerWorkspaceHost = withComputerWorkspace(TestComputerWorkspaceLive, (_, state) => {
  return {
    storage: state.storage,
    sessionId: state.id.toString(),
    gitIdentity: { name: "effect-cf", email: "tests@effect-cf.example" },
  };
});

export class TestComputerWorkspaceDurableObject extends TestComputerWorkspaceHost {}

export interface TestWorkflowPayload {
  readonly value: string;
}

export const TestWorkflowEntrypoint = Workflow.make(Layer.empty, {
  run: (payload: TestWorkflowPayload) =>
    Effect.gen(function* () {
      const value = yield* Workflow.step("produce-value", Effect.succeed(payload.value));

      yield* Workflow.sleep("pause", "1 hour");

      return { value };
    }),
});

export default Worker.make(Layer.empty, {
  fetch: Effect.sync(() => new Response("effect-cf test fixture", { status: 200 })),
});
