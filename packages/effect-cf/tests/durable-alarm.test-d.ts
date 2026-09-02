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

const DocumentAlarms = DurableObjectAlarm.define({
  archive: Schema.Struct({ key: Schema.String, revision: Schema.FiniteFromString }),
  cleanup: { payload: Schema.Null, failure: "retry" },
});
const runAt = DateTime.makeUnsafe(1);
const archiveInput = {
  tag: "archive",
  id: "a",
  runAt,
  payload: { key: "a", revision: 1 },
} as const;

void DocumentAlarms.scheduleAlarm(archiveInput);
// @ts-expect-error The tag must belong to this definition.
void DocumentAlarms.scheduleAlarm({ ...archiveInput, tag: "archvie" });
// @ts-expect-error Scheduling accepts the decoded type, not its wire encoding.
void DocumentAlarms.scheduleAlarm({ ...archiveInput, payload: { key: "a", revision: "1" } });
// @ts-expect-error A known tag cannot be paired with another tag's payload.
void DocumentAlarms.scheduleAlarm({ ...archiveInput, tag: "cleanup" });
// @ts-expect-error Cancellation uses the same defined tags.
void DocumentAlarms.cancelAlarm({ tag: "archvie", id: "a" });

expectTypeOf(DocumentAlarms.transaction(() => application)).toEqualTypeOf<
  Effect.Effect<
    number,
    ApplicationError | DurableObjectStorage.StorageOperationError,
    Application | DurableObjectAlarm.DurableObjectAlarm
  >
>();

void DocumentAlarms.transaction((typedTx) => {
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

// The default scheduler is available to construction layers as well as handlers.
const scheduled = Context.Service<{ readonly ready: boolean }>("test/Scheduled");

DurableObject.make(
  Layer.effect(
    scheduled,
    DocumentAlarms.scheduleAlarm(archiveInput).pipe(Effect.as({ ready: true })),
  ),
  {
    initialize: DocumentAlarms.scheduleAlarm(archiveInput),
    alarms: DocumentAlarms.handlers({ archive: () => Effect.void, cleanup: () => Effect.void }),
    rpc: { schedule: () => DocumentAlarms.scheduleAlarm(archiveInput) },
  },
);
