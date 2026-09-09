import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { DurableObject, DurableObjectAlarm, DurableObjectState, Worker } from "effect-cf";

import { headers, mark } from "./instrumentation";

const Mode = Schema.Literals(["independent", "transaction"]);
const Count = Schema.Literals([1, 10, 100]);

// 2100-01-01 UTC. No timer can fire during this benchmark.
const futureTimestamp = 4102444800000;
const AlarmRow = Schema.Struct({
  alarm_id: Schema.String,
  tag: Schema.String,
  run_at: Schema.Int,
  payload: Schema.String,
});
const Verification = Schema.Struct({
  count: Schema.Int,
  nextAlarm: Schema.NullOr(Schema.Int),
  rows: Schema.Array(AlarmRow),
});
const Cleaned = Schema.Struct({
  cleaned: Schema.Boolean,
  nextAlarm: Schema.NullOr(Schema.Int),
  tables: Schema.Int,
});

class AlarmsApi extends DurableObject.Tag<AlarmsApi>()("hot-bench/AlarmsApi", {
  schedule: DurableObject.method({
    args: [Schema.String, Mode, Count],
    success: Schema.Struct({ scheduled: Count, runAt: Schema.Int }),
  }),
  verify: DurableObject.method({ args: [Schema.String], success: Verification }),
  cleanup: DurableObject.method({ args: [Schema.String], success: Cleaned }),
}) {}

export class AlarmBench extends AlarmsApi.make(Layer.empty, {
  rpc: {
    schedule: Effect.fn("AlarmBench.schedule")(function* (benchId, mode, count) {
      yield* mark("alarm", benchId, { operation: "schedule", mode, count });
      const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;
      const schedule = Effect.fn("AlarmBench.scheduleRelated")(function* (
        scheduler: DurableObjectAlarm.AlarmTransaction,
      ) {
        for (let index = 0; index < count; index++) {
          yield* scheduler.scheduleAlarm({
            tag: "order-followup",
            id: `ORDER-${String(index).padStart(6, "0")}`,
            runAt: DateTime.makeUnsafe(futureTimestamp + index * 1000),
            payload: { orderId: `ORDER-${String(index).padStart(6, "0")}`, step: index },
          });
        }
      });

      if (mode === "transaction") yield* alarms.transaction(schedule);
      else yield* schedule(alarms);

      return { scheduled: count, runAt: futureTimestamp };
    }),
    verify: Effect.fn("AlarmBench.verify")(function* (benchId) {
      yield* mark("alarm", benchId, { operation: "verify" });
      const state = yield* DurableObjectState.DurableObjectState;
      const cursor = yield* state.storage.sql.exec(
        "SELECT alarm_id, tag, run_at, payload FROM effect_cf_scheduled_alarms ORDER BY alarm_id",
      );
      const rows = yield* Schema.decodeUnknownEffect(Schema.Array(AlarmRow))(
        yield* cursor.toArray(),
      );

      return { count: rows.length, nextAlarm: yield* state.storage.getAlarm(), rows };
    }),
    cleanup: Effect.fn("AlarmBench.cleanup")(function* (benchId) {
      yield* mark("alarm", benchId, { operation: "cleanup" });
      const state = yield* DurableObjectState.DurableObjectState;

      yield* state.storage.deleteAlarm();
      yield* state.storage.deleteAll();
      const nextAlarm = yield* state.storage.getAlarm();
      const cursor = yield* state.storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_cf_scheduled_alarms'",
      );
      const tables = (yield* cursor.toArray()).length;

      return { cleaned: nextAlarm === null && tables === 0, nextAlarm, tables };
    }),
  },
  alarm: () =>
    Effect.gen(function* () {
      yield* mark("alarm", "unexpected-platform-alarm", { operation: "unexpected-alarm" });
      const state = yield* DurableObjectState.DurableObjectState;

      yield* state.storage.deleteAlarm();
      yield* state.storage.deleteAll();
    }),
}) {}

const Params = Schema.Struct({
  mode: Mode,
  count: Schema.Literals(["1", "10", "100"]),
  object: Schema.NonEmptyString,
});

export default Worker.makeFetchHandler(AlarmsApi.layer({ binding: "ALARMS" }), {
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;
    const url = new URL(request.url);
    const params = yield* Schema.decodeUnknownEffect(Params)({
      mode: url.searchParams.get("mode") ?? "independent",
      count: url.searchParams.get("count") ?? "1",
      object: url.searchParams.get("object"),
    });
    const benchId = request.headers.get("x-bench-id") ?? "unlabelled";
    const objectName = `${params.mode}/${params.count}/${params.object}`;
    const state = yield* mark("alarm-gateway", benchId, { operation: url.pathname, objectName });
    const namespace = yield* AlarmsApi;
    const stub = yield* namespace.getByName(objectName);
    const responseHeaders = headers(state);

    if (url.pathname === "/alarm/schedule" && request.method === "POST") {
      const count = yield* Schema.decodeUnknownEffect(Count)(Number(params.count));

      return Response.json(yield* namespace.schedule(stub, benchId, params.mode, count), {
        headers: responseHeaders,
      });
    }
    if (url.pathname === "/alarm/verify" && request.method === "GET")
      return Response.json(yield* namespace.verify(stub, benchId), { headers: responseHeaders });
    if (url.pathname === "/alarm/cleanup" && request.method === "DELETE")
      return Response.json(yield* namespace.cleanup(stub, benchId), { headers: responseHeaders });

    return new Response("Not Found", { status: 404, headers: responseHeaders });
  }),
});
