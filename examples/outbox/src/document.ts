import { DateTime, Effect, Schema } from "effect";
import { DurableObject, DurableObjectAlarm, DurableObjectState, R2 } from "effect-cf";

const Snapshot = Schema.Struct({ revision: Schema.Int, body: Schema.String });

export class Documents extends DurableObject.Tag<Documents>()("Documents", {
  save: DurableObject.method({ args: [Schema.String], success: Schema.String }),
  read: DurableObject.method({ success: Schema.NullOr(Snapshot) }),
}) {}

export class Archive extends R2.Tag<Archive>()("Archive") {}

const DocumentAlarms = DurableObjectAlarm.define({
  archive: Schema.Struct({ key: Schema.String, body: Schema.String }),
});

const DocumentLive = Documents.make(Archive.layer({ binding: "ARCHIVE" }), {
  rpc: {
    save: Effect.fn("Documents.save")(function* (body) {
      const state = yield* DurableObjectState.DurableObjectState;

      return yield* DocumentAlarms.transaction((tx) =>
        Effect.gen(function* () {
          const previous = yield* state.storage.get<typeof Snapshot.Type>("document");
          const revision = (previous?.revision ?? 0) + 1;
          const name = state.id.name ?? state.id.toString();
          const key = `${name}/${revision}.txt`;
          const now = yield* DateTime.now;

          // A restart cannot leave a saved revision with no delivery alarm.
          yield* state.storage.put("document", { revision, body });
          yield* tx.scheduleAlarm({
            tag: "archive",
            id: key,
            // The demo leaves time to stop Wrangler before delivery.
            runAt: DateTime.add(now, { seconds: 30 }),
            payload: { key, body },
          });

          return key;
        }),
      );
    }),
    read: Effect.fn("Documents.read")(function* () {
      const state = yield* DurableObjectState.DurableObjectState;

      return (yield* state.storage.get<typeof Snapshot.Type>("document")) ?? null;
    }),
  },
  alarms: DocumentAlarms.handlers({
    archive: Effect.fn("Documents.archive")(function* ({ tag, id, payload }) {
      const archive = yield* Archive;
      const now = yield* DateTime.now;

      // Persist another wake BEFORE the external write, in case execution stops.
      yield* DocumentAlarms.scheduleAlarm({
        tag,
        id,
        runAt: DateTime.add(now, { seconds: 30 }),
        payload,
      });

      // Outside the transaction. Replays write the same key and exact content.
      yield* archive.put(payload.key, payload.body);
      yield* DocumentAlarms.cancelAlarm({ tag, id });
    }),
  }),
});

export class DocumentDurableObject extends DocumentLive {}
