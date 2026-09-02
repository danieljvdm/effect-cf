import { DateTime, Effect, Schema } from "effect";
import { DurableObject, DurableObjectAlarm, DurableObjectState, Worker } from "effect-cf";

class Seat extends DurableObject.Tag<Seat>()("Seat", {
  reserve: DurableObject.method({ success: Schema.NullOr(Schema.String) }),
}) {}

const SeatAlarms = DurableObjectAlarm.define({
  expire: Schema.Struct({ holdId: Schema.String }),
});

const SeatLive = Seat.make(DurableObjectAlarm.DurableObjectAlarm.layer, {
  rpc: {
    reserve: Effect.fn("Seat.reserve")(function* () {
      const state = yield* DurableObjectState.DurableObjectState;
      const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

      return yield* alarms.transaction((tx) =>
        Effect.gen(function* () {
          if ((yield* state.storage.get<string>("hold")) !== undefined) {
            return null;
          }
          const holdId = crypto.randomUUID();
          const now = yield* DateTime.now;

          // If scheduling fails, roll back the hold so the seat stays available.
          yield* state.storage.put("hold", holdId);
          yield* tx.scheduleAlarm({
            tag: "expire",
            id: holdId,
            runAt: DateTime.add(now, { seconds: 30 }),
            payload: { holdId },
          });

          return holdId;
        }),
      );
    }),
  },
  alarms: SeatAlarms.handlers({
    expire: Effect.fn("Seat.expire")(function* ({ payload }) {
      const state = yield* DurableObjectState.DurableObjectState;

      yield* state.storage.transaction(() =>
        Effect.gen(function* () {
          // A retried old alarm must not release a newer hold.
          if ((yield* state.storage.get<string>("hold")) === payload.holdId) {
            yield* state.storage.delete("hold");
          }
        }),
      );
    }),
  }),
});

export class SeatDurableObject extends SeatLive {}

export default Worker.make(Seat.layer({ binding: "SEATS" }), {
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;

    if (request.method !== "POST") {
      return new Response("Use POST to reserve a seat", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }
    const seats = yield* Seat;
    const holdId = yield* seats.byName(new URL(request.url).pathname).reserve();

    return holdId === null
      ? Response.json({ error: "Seat already held" }, { status: 409 })
      : Response.json({ holdId }, { status: 201 });
  }),
});
