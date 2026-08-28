import { expectTypeOf } from "vitest";
import { Context, DateTime, Effect, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";

import { DurableObjectAlarm, DurableObjectState, DurableObjectStorage } from "../src/index";

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
