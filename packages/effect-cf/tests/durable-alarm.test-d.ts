import { expectTypeOf } from "vitest";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";

import {
  DurableObject,
  DurableObjectAlarm,
  DurableObjectState,
  DurableObjectStorage,
} from "../src/index";

class Application extends Context.Service<Application, { readonly id: string }>()("Application") {}
class ApplicationError extends Schema.TaggedError<ApplicationError>()("ApplicationError", {}) {}

declare const alarms: DurableObjectAlarm.AlarmScheduler;
declare const application: Effect.Effect<number, ApplicationError, Application>;

expectTypeOf(alarms.transaction(() => application)).toEqualTypeOf<
  Effect.Effect<number, ApplicationError | DurableObjectStorage.StorageOperationError, Application>
>();

const composed = alarms.transaction((tx) =>
  Effect.gen(function* () {
    const app = yield* Application;
    const sql = yield* SqlClient.SqlClient;
    const state = yield* DurableObjectState.DurableObjectState;

    yield* sql`INSERT INTO application_jobs (id) VALUES (${app.id})`;
    yield* state.storage.put("last-job", app.id);
    yield* tx.scheduleAlarm({
      tag: "job",
      id: app.id,
      payload: null,
      runAt: DateTime.makeUnsafe(1),
    });
    yield* tx.cancelAlarm({ tag: "obsolete", id: app.id });

    return yield* application;
  }),
);

expectTypeOf(composed).toEqualTypeOf<
  Effect.Effect<
    number,
    | ApplicationError
    | SqlError.SqlError
    | DurableObjectStorage.StorageOperationError
    | DurableObjectAlarm.InvalidAlarmRefError
    | DurableObjectAlarm.InvalidAlarmPayloadError
    | DurableObjectAlarm.InvalidRepeatEveryError,
    Application | SqlClient.SqlClient | DurableObjectState.DurableObjectState
  >
>();

declare const tx: DurableObjectAlarm.AlarmTransaction;

// @ts-expect-error The callback only exposes mutations, not another transaction boundary.
tx.transaction(() => Effect.void);
// @ts-expect-error Dispatch and external handler work do not belong in the transaction.
tx.processDueAlarms(() => Effect.void);

class DocumentAlarms extends DurableObjectAlarm.Tag<DocumentAlarms>()("DocumentAlarms", {
  archive: Schema.Struct({ key: Schema.String, revision: Schema.FiniteFromString }),
  cleanup: { payload: Schema.Null, failure: "retry" },
}) {}
class OtherAlarms extends DurableObjectAlarm.Tag<OtherAlarms>()("OtherAlarms", {
  archive: Schema.Struct({ key: Schema.String, revision: Schema.FiniteFromString }),
  cleanup: { payload: Schema.Null, failure: "retry" },
}) {}
declare const documentAlarms: DocumentAlarms["Service"];
const runAt = DateTime.makeUnsafe(1);
const archiveInput = {
  tag: "archive",
  id: "a",
  runAt,
  payload: { key: "a", revision: 1 },
} as const;

void documentAlarms.scheduleAlarm(archiveInput);
// @ts-expect-error A schema definition alone does not provide scheduling.
void DocumentAlarms.scheduleAlarm(archiveInput);
// @ts-expect-error The tag must belong to this definition.
void documentAlarms.scheduleAlarm({ ...archiveInput, tag: "archvie" });
// @ts-expect-error Scheduling accepts the decoded type, not its wire encoding.
void documentAlarms.scheduleAlarm({ ...archiveInput, payload: { key: "a", revision: "1" } });
// @ts-expect-error A known tag cannot be paired with another tag's payload.
void documentAlarms.scheduleAlarm({ ...archiveInput, tag: "cleanup" });
// @ts-expect-error Cancellation uses the same defined tags.
void documentAlarms.cancelAlarm({ tag: "archvie", id: "a" });

expectTypeOf(documentAlarms.transaction(() => application)).toEqualTypeOf<
  Effect.Effect<number, ApplicationError | DurableObjectStorage.StorageOperationError, Application>
>();

void documentAlarms.transaction((typedTx) => {
  void typedTx.scheduleAlarm(archiveInput);
  void typedTx.cancelAlarm({ tag: "cleanup", id: "a" });
  // @ts-expect-error Transactional scheduling is definition-bound too.
  void typedTx.scheduleAlarm({ ...archiveInput, tag: "archvie" });
  // @ts-expect-error Transactional scheduling keeps tag and payload correlated.
  void typedTx.scheduleAlarm({ ...archiveInput, tag: "cleanup" });
  // @ts-expect-error A transaction handle cannot open nested transactions.
  void typedTx.transaction(() => Effect.void);

  return application;
});

const schedule = Effect.fn("schedule")(function* () {
  const alarms = yield* DocumentAlarms;

  yield* alarms.scheduleAlarm(archiveInput);

  return "saved";
});
const handlers = {
  archive: Effect.fn("archive")(function* ({ id }: { readonly id: string }) {
    const alarms = yield* DocumentAlarms;

    yield* alarms.cancelAlarm({ tag: "archive", id });
  }),
  cleanup: () => Effect.void,
};
const registration = DocumentAlarms.handlers(handlers);

// @ts-expect-error All declared alarms need handlers.
DocumentAlarms.handlers({ archive: handlers.archive });

DurableObject.make(Layer.empty, { alarms: registration, rpc: { save: schedule } });
// @ts-expect-error Removing the registration leaves DocumentAlarms unsatisfied.
// @effect-diagnostics-next-line missingEffectContext:off
DurableObject.make(Layer.empty, { rpc: { save: schedule } });
// @ts-expect-error A raw alarm hook cannot provide the typed scheduler.
// @effect-diagnostics-next-line missingEffectContext:off
DurableObject.make(Layer.empty, { alarms: Effect.void, rpc: { save: schedule } });
// Another service with identical payloads cannot satisfy DocumentAlarms.
DurableObject.make(Layer.empty, {
  alarms: OtherAlarms.handlers({ archive: () => Effect.void, cleanup: () => Effect.void }),
  // @ts-expect-error The registered service does not satisfy schedule's dependency.
  // @effect-diagnostics-next-line missingEffectContext:off
  rpc: { save: schedule },
});

class Documents extends DurableObject.Tag<Documents>()("Documents", {
  save: DurableObject.method({ success: Schema.String }),
}) {}
Documents.make(Layer.empty, { alarms: registration, rpc: { save: schedule } });
// @ts-expect-error Tagged DOs must register the service too.
Documents.make(Layer.empty, { rpc: { save: schedule } });

const scheduleRpc = { save: schedule };
const runtimeOnly = { rpc: scheduleRpc };
const eventOnly = { eventLayer: registration.layer, rpc: scheduleRpc };
const otherRegistration = OtherAlarms.handlers({
  archive: () => Effect.void,
  cleanup: () => Effect.void,
});
const wrongRegistration = { alarms: otherRegistration, rpc: scheduleRpc };

// @ts-expect-error Installing the service layer alone does not install its dispatcher.
DurableObject.make(registration.layer, runtimeOnly);
// @ts-expect-error A layer can schedule work during construction even without RPC methods.
DurableObject.make(registration.layer);
// @ts-expect-error An event layer cannot substitute for handler registration.
DurableObject.make(Layer.empty, eventOnly);
// @ts-expect-error Tagged DOs cannot bypass registration through application outputs.
Documents.make(registration.layer, runtimeOnly);
// @ts-expect-error Tagged DOs cannot bypass registration through event outputs.
Documents.make(Layer.empty, eventOnly);
// @ts-expect-error A different dispatcher does not cover the service in the application layer.
DurableObject.make(registration.layer, wrongRegistration);

DurableObject.make(registration.layer, { alarms: registration, rpc: scheduleRpc });
Documents.make(Layer.empty, { ...eventOnly, alarms: registration });

const scheduled = Context.Service<{ readonly ready: boolean }>("test/Scheduled");
const applicationLayer = Layer.effect(scheduled, schedule().pipe(Effect.as({ ready: true })));

DurableObject.make(applicationLayer, {
  alarms: registration,
  initialize: schedule().pipe(Effect.asVoid),
  eventLayer: Layer.effect(scheduled, schedule().pipe(Effect.as({ ready: true }))),
  rpc: { save: schedule },
});
// @ts-expect-error Application layers cannot use an unregistered alarm service.
// @effect-diagnostics-next-line missingLayerContext:off
DurableObject.make(applicationLayer);
