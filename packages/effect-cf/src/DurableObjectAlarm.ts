import {
  Clock,
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Predicate,
  Schema as S,
} from "effect";

import { DurableObjectState } from "./DurableObjectState";
import { type SqlStorageValue, StorageOperationError } from "./DurableObjectStorage";
import * as ErrorMessage from "./internal/ErrorMessage";

const INIT_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS effect_cf_scheduled_alarms (
  storage_id TEXT PRIMARY KEY,
  alarm_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  run_at INTEGER NOT NULL,
  repeat_every_ms INTEGER,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_effect_cf_scheduled_alarms_run_at_storage_id
  ON effect_cf_scheduled_alarms (run_at, storage_id);
`;

const DEFAULT_PROCESS_DUE_ALARMS_LIMIT = 100;
const DEFAULT_PROCESS_DUE_ALARMS_FAILURE_RESCHEDULE_AFTER = "30 seconds" satisfies Duration.Input;

const getScheduledEventId = (input: { readonly id: string; readonly tag: string }) =>
  `effect-cf-alarm:${encodeURIComponent(input.tag)}:${encodeURIComponent(input.id)}`;

export type AlarmPayload = S.Json;

interface AlarmRow extends Record<string, SqlStorageValue> {
  readonly alarm_id: string;
  readonly payload: string;
  readonly repeat_every_ms: number | null;
  readonly run_at: number;
  readonly storage_id: string;
  readonly tag: string;
}

interface NextAlarmRow extends Record<string, SqlStorageValue> {
  readonly run_at: number;
}

export class InvalidAlarmRefError extends Data.TaggedError("InvalidAlarmRefError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Invalid Durable Object alarm ref: ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

export class InvalidAlarmPayloadError extends Data.TaggedError("InvalidAlarmPayloadError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Invalid Durable Object alarm payload: ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

export class InvalidRepeatEveryError extends Data.TaggedError("InvalidRepeatEveryError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Invalid Durable Object alarm repeatEvery: ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

export class InvalidProcessDueAlarmsOptionsError extends Data.TaggedError(
  "InvalidProcessDueAlarmsOptionsError",
)<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Invalid processDueAlarms options: ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

export class StoredAlarmDecodeError extends Data.TaggedError("StoredAlarmDecodeError")<{
  readonly cause: unknown;
  readonly storageId: string;
}> {
  override get message(): string {
    return `Failed to decode stored alarm "${this.storageId}": ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

export type DurableObjectAlarmError =
  | InvalidAlarmPayloadError
  | InvalidAlarmRefError
  | InvalidProcessDueAlarmsOptionsError
  | InvalidRepeatEveryError
  | StorageOperationError
  | StoredAlarmDecodeError;

export const DurableObjectAlarmEvent = S.TaggedUnion({
  AlarmDue: {
    id: S.NonEmptyString,
    payload: S.Json,
    /** Persisted due time, which can differ from the invocation time during retries. */
    scheduledAt: S.DateTimeUtc,
    tag: S.NonEmptyString,
  },
});
export type DurableObjectAlarmEvent = typeof DurableObjectAlarmEvent.Type;

export type AlarmRef<Tag extends string = string> = {
  readonly id: string;
  readonly tag: Tag;
};

const AlarmRefSchema = S.Struct({
  id: S.NonEmptyString,
  tag: S.NonEmptyString,
});

const decodeAlarmRef = (input: AlarmRef) =>
  S.decodeUnknownEffect(AlarmRefSchema)(input).pipe(
    Effect.mapError((cause) => new InvalidAlarmRefError({ cause })),
  );

/** Reusing `{tag, id}` replaces an alarm. Repeats run after success, never as fixed-cadence catch-up. */
export type ScheduleAlarmInput<Tag extends string = string> = AlarmRef<Tag> & {
  readonly payload: AlarmPayload;
  readonly repeatEvery?: Duration.Input;
  readonly runAt: DateTime.Utc;
};

export type ProcessDueAlarmsMode = "isolated" | "ordered";

export interface ProcessDueAlarmsFailure {
  readonly cause: unknown;
  readonly event?: DurableObjectAlarmEvent;
  readonly id: string;
  readonly storageId: string;
  readonly tag: string;
}

export interface ProcessDueAlarmsResult {
  readonly failed: readonly ProcessDueAlarmsFailure[];
  readonly handled: readonly DurableObjectAlarmEvent[];
}

export type ProcessDueAlarmsFailureAction =
  | "ordered"
  | "retry"
  | "skip-and-advance-repeat"
  | {
      readonly mode: "ordered";
    }
  | {
      readonly mode: "retry";
      readonly retryFailedAfter?: Duration.Input;
    }
  | {
      readonly mode: "skip-and-advance-repeat";
    };

export interface ProcessDueAlarmsOptions<OnFailureR = never, OnFailureE = never> {
  readonly limit?: number;
  /** `isolated` retries only the failed row; `ordered` stops before later rows. */
  readonly mode?: ProcessDueAlarmsMode;
  readonly onFailure?: (
    failure: ProcessDueAlarmsFailure,
  ) => Effect.Effect<ProcessDueAlarmsFailureAction | void, OnFailureE, OnFailureR>;
  readonly retryFailedAfter?: Duration.Input;
}

export type ProcessDueAlarmsHandler<R = never, E = never> = (
  event: DurableObjectAlarmEvent,
) => Effect.Effect<void, E, R>;

/**
 * Alarm mutations owned by one transaction callback. Run them in the callback's
 * fiber; forked work and use after the callback ends fail with StorageOperationError.
 */
export type AlarmTransaction = Pick<AlarmScheduler, "scheduleAlarm" | "cancelAlarm">;

/** Own `storage.setAlarm()` exclusively: a Durable Object has one platform alarm timestamp. */
export type AlarmScheduler = {
  /**
   * Commits local application storage and logical alarms in one native SQLite
   * Durable Object transaction, reconciling the native alarm before commit.
   * Use the supplied mutations, not standalone alarm methods or nested transactions.
   * SqlClient queries must use this same Durable Object's storage.
   *
   * Failure, defects and interruption before commit roll back. A lost reply or
   * interruption after commit does not undo committed state. Keep RPC and other
   * external effects outside; atomically pre-arm a later wake before fallible work.
   * Cloudflare's native retries are bounded; composition does not remove the
   * pre-arm requirement or promise infinite retry liveness.
   */
  readonly transaction: <A, E, R>(
    closure: (alarms: AlarmTransaction) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StorageOperationError, R>;

  readonly cancelAlarm: (
    input: AlarmRef,
  ) => Effect.Effect<void, InvalidAlarmRefError | StorageOperationError>;

  /** Acknowledge after handling. Conditional writes preserve handler replacements; alarms are at-least-once. */
  readonly processDueAlarms: <R = never, E = never, OnFailureR = never, OnFailureE = never>(
    handle: ProcessDueAlarmsHandler<R, E>,
    options?: ProcessDueAlarmsOptions<OnFailureR, OnFailureE>,
  ) => Effect.Effect<
    ProcessDueAlarmsResult,
    E | OnFailureE | DurableObjectAlarmError,
    R | OnFailureR
  >;

  /** A failed platform setAlarm rolls back the logical schedule in the same transaction. */
  readonly scheduleAlarm: (
    input: ScheduleAlarmInput,
  ) => Effect.Effect<
    void,
    | InvalidAlarmPayloadError
    | InvalidAlarmRefError
    | InvalidRepeatEveryError
    | StorageOperationError
  >;
};

const StoredPayloadString = S.fromJsonString(S.Json);

const decodeStoredPayload = (row: AlarmRow) =>
  S.decodeUnknownEffect(StoredPayloadString)(row.payload).pipe(
    Effect.mapError((cause) => new StoredAlarmDecodeError({ cause, storageId: row.storage_id })),
  );

const encodeStoredPayload = (payload: AlarmPayload) =>
  S.encodeEffect(StoredPayloadString)(payload).pipe(
    Effect.mapError((cause) => new InvalidAlarmPayloadError({ cause })),
  );

const ensureTable = (state: DurableObjectState["Service"]) =>
  state.storage.sql.exec(INIT_TABLE_SQL).pipe(Effect.asVoid);

const toRepeatEveryMillis = (input: Duration.Input | undefined) => {
  if (input === undefined) {
    return Effect.succeed(null);
  }

  return Effect.try({
    try: () => {
      const millis = Duration.toMillis(input);

      if (!Number.isFinite(millis) || millis <= 0) {
        throw new Error("Alarm repeatEvery must be a positive finite duration");
      }

      return Math.ceil(millis);
    },
    catch: (cause) => new InvalidRepeatEveryError({ cause }),
  });
};

const toAlarmDue = (row: AlarmRow) =>
  Effect.gen(function* () {
    if (!Number.isFinite(row.run_at)) {
      return yield* Effect.fail(
        new StoredAlarmDecodeError({
          cause: new Error("Stored alarm run_at must be a finite number"),
          storageId: row.storage_id,
        }),
      );
    }

    return DurableObjectAlarmEvent.make({
      _tag: "AlarmDue",
      id: row.alarm_id,
      payload: yield* decodeStoredPayload(row),
      scheduledAt: DateTime.makeUnsafe(row.run_at),
      tag: row.tag,
    });
  });

const getProcessLimit = (options: ProcessDueAlarmsOptions<unknown, unknown> | undefined) => {
  const limit = options?.limit ?? DEFAULT_PROCESS_DUE_ALARMS_LIMIT;

  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return Effect.fail(
      new InvalidProcessDueAlarmsOptionsError({
        cause: new Error("processDueAlarms limit must be a positive safe integer"),
      }),
    );
  }

  return Effect.succeed(limit);
};

const toFailureRescheduleMillis = (input: Duration.Input) =>
  Effect.try({
    try: () => {
      const millis = Duration.toMillis(input);

      if (!Number.isFinite(millis) || millis <= 0) {
        throw new Error("Alarm failure rescheduleAfter must be a positive finite duration");
      }

      return Math.ceil(millis);
    },
    catch: (cause) => new InvalidProcessDueAlarmsOptionsError({ cause }),
  });

const getFailureRetryDelay = (options: ProcessDueAlarmsOptions<unknown, unknown> | undefined) =>
  toFailureRescheduleMillis(
    options?.retryFailedAfter ?? DEFAULT_PROCESS_DUE_ALARMS_FAILURE_RESCHEDULE_AFTER,
  );

const getFailureActionMode = (action: ProcessDueAlarmsFailureAction) =>
  Predicate.isString(action) ? action : action.mode;

const getFailureActionRetryDelay = (action: ProcessDueAlarmsFailureAction) =>
  Predicate.isString(action) || action.mode !== "retry" ? undefined : action.retryFailedAfter;

export const processDue = <R = never, E = never, OnFailureR = never, OnFailureE = never>(
  handle: ProcessDueAlarmsHandler<R, E>,
  options: ProcessDueAlarmsOptions<OnFailureR, OnFailureE> = {},
) =>
  Effect.gen(function* () {
    const durableObjectAlarm = yield* DurableObjectAlarm;

    return yield* durableObjectAlarm.processDueAlarms(handle, options);
  });

export type AlarmPayloadSchema = S.Codec<any, any, never, never>;

export type AlarmFailurePolicy = "ordered" | "retry" | "skip-and-advance-repeat";

export interface AlarmRetryPolicy {
  readonly initialDelay?: Duration.Input;
}

export interface AlarmDefinitionConfig<Payload extends AlarmPayloadSchema = AlarmPayloadSchema> {
  readonly failure?: AlarmFailurePolicy;
  readonly payload: Payload;
  readonly retry?: AlarmRetryPolicy;
}

export type AlarmDefinitionEntry = AlarmDefinitionConfig | AlarmPayloadSchema;

export type AlarmDefinitions = Readonly<Record<string, AlarmDefinitionEntry>>;

type AlarmDefinitionSchema<Definition> =
  Definition extends AlarmDefinitionConfig<infer Payload> ? Payload : Definition;

export type AlarmDefinitionPayload<Definition> =
  AlarmDefinitionSchema<Definition> extends S.Codec<infer A, any, never, never> ? A : never;

export type DefinedAlarmEvent<Tag extends string, Payload> = Omit<
  DurableObjectAlarmEvent,
  "payload" | "tag"
> & {
  readonly payload: Payload;
  readonly tag: Tag;
};

export type DefinedAlarmHandlers<Definitions extends AlarmDefinitions, R = never, E = never> = {
  readonly [Tag in keyof Definitions & string]: (
    event: DefinedAlarmEvent<Tag, AlarmDefinitionPayload<Definitions[Tag]>>,
  ) => Effect.Effect<void, E, R>;
};

/** A discriminated union keeps each tag paired with its decoded payload type. */
export type DefinedScheduleAlarmInput<Definitions extends AlarmDefinitions> = {
  readonly [Tag in keyof Definitions & string]: Omit<ScheduleAlarmInput<Tag>, "payload"> & {
    readonly payload: AlarmDefinitionPayload<Definitions[Tag]>;
  };
}[keyof Definitions & string];

export interface DefinedAlarmTransaction<Definitions extends AlarmDefinitions> {
  readonly scheduleAlarm: (
    input: DefinedScheduleAlarmInput<Definitions>,
  ) => ReturnType<AlarmScheduler["scheduleAlarm"]>;
  readonly cancelAlarm: (
    input: AlarmRef<keyof Definitions & string>,
  ) => ReturnType<AlarmScheduler["cancelAlarm"]>;
}

const isAlarmDefinitionConfig = (
  definition: AlarmDefinitionEntry,
): definition is AlarmDefinitionConfig => Predicate.isObject(definition) && "payload" in definition;

const getAlarmDefinitionSchema = (definition: AlarmDefinitionEntry) =>
  isAlarmDefinitionConfig(definition) ? definition.payload : definition;

const getAlarmDefinitionFailureAction = (
  definition: AlarmDefinitionEntry | undefined,
): ProcessDueAlarmsFailureAction | undefined => {
  if (definition === undefined || !isAlarmDefinitionConfig(definition)) {
    return undefined;
  }

  if (definition.failure === undefined) {
    return undefined;
  }

  return definition.failure === "retry"
    ? { mode: "retry", retryFailedAfter: definition.retry?.initialDelay }
    : { mode: definition.failure };
};

export const define = <const Definitions extends AlarmDefinitions>(definitions: Definitions) => {
  const definitionFor = (tag: string) =>
    Object.hasOwn(definitions, tag) ? definitions[tag] : undefined;

  const bind = (mutations: AlarmTransaction): DefinedAlarmTransaction<Definitions> => ({
    scheduleAlarm: Effect.fn("DefinedAlarms.scheduleAlarm")(function* (
      input: DefinedScheduleAlarmInput<Definitions>,
    ) {
      const definition = definitionFor(input.tag);

      if (definition === undefined) {
        return yield* Effect.fail(
          new InvalidAlarmRefError({
            cause: new Error(`Unknown alarm tag "${input.tag}"`),
          }),
        );
      }
      const payload = yield* S.encodeEffect(getAlarmDefinitionSchema(definition))(
        input.payload,
      ).pipe(
        Effect.flatMap(S.decodeUnknownEffect(S.Json)),
        Effect.mapError((cause) => new InvalidAlarmPayloadError({ cause })),
      );

      yield* mutations.scheduleAlarm({ ...input, payload });
    }),
    cancelAlarm: Effect.fn("DefinedAlarms.cancelAlarm")(function* (
      input: AlarmRef<keyof Definitions & string>,
    ) {
      if (definitionFor(input.tag) === undefined) {
        return yield* Effect.fail(
          new InvalidAlarmRefError({
            cause: new Error(`Unknown alarm tag "${input.tag}"`),
          }),
        );
      }

      yield* mutations.cancelAlarm(input);
    }),
  });

  return {
    /** Encodes and validates the payload before persisting it. */
    scheduleAlarm: Effect.fn("DefinedAlarms.scheduleAlarm")(function* (
      input: DefinedScheduleAlarmInput<Definitions>,
    ) {
      const alarms = yield* DurableObjectAlarm;

      yield* bind(alarms).scheduleAlarm(input);
    }),
    cancelAlarm: Effect.fn("DefinedAlarms.cancelAlarm")(function* (
      input: AlarmRef<keyof Definitions & string>,
    ) {
      const alarms = yield* DurableObjectAlarm;

      yield* bind(alarms).cancelAlarm(input);
    }),
    /** Uses the same callback-owned transaction as the raw scheduler. */
    transaction: <A, E, R>(
      closure: (alarms: DefinedAlarmTransaction<Definitions>) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | StorageOperationError, R | DurableObjectAlarm> =>
      Effect.flatMap(DurableObjectAlarm, (alarms) => alarms.transaction((tx) => closure(bind(tx)))),
    handlers: <R = never, E = never>(
      handlers: DefinedAlarmHandlers<Definitions, R, E>,
      options?: ProcessDueAlarmsOptions<R, E>,
    ) =>
      processDue(
        (event) =>
          Effect.gen(function* () {
            const definition = definitionFor(event.tag);

            if (definition === undefined) {
              return yield* Effect.fail(
                new StoredAlarmDecodeError({
                  cause: new Error(`Unknown alarm tag "${event.tag}"`),
                  storageId: getScheduledEventId(event),
                }),
              );
            }

            const schema = getAlarmDefinitionSchema(definition);
            // SAFETY: schema is selected from the same tagged definition used to select its handler.
            const payload = yield* (
              S.decodeUnknownEffect(schema)(event.payload) as Effect.Effect<
                AlarmDefinitionPayload<Definitions[keyof Definitions & string]>,
                unknown
              >
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new StoredAlarmDecodeError({
                    cause,
                    storageId: getScheduledEventId(event),
                  }),
              ),
            );
            const handler = handlers[event.tag];

            // SAFETY: event.tag indexes the matching definition and handler, whose payload schema was decoded above.
            yield* handler({ ...event, payload } as never);
          }),
        {
          ...options,
          onFailure: (failure) =>
            Effect.gen(function* () {
              const action = getAlarmDefinitionFailureAction(definitionFor(failure.tag));
              const optionAction =
                options?.onFailure === undefined ? undefined : yield* options.onFailure(failure);

              return action ?? optionAction;
            }),
        },
      ),
  };
};

export class DurableObjectAlarm extends Context.Service<DurableObjectAlarm, AlarmScheduler>()(
  "effect-cf/DurableObjectAlarm",
) {
  static readonly layer: Layer.Layer<DurableObjectAlarm, never, DurableObjectState> = Layer.effect(
    DurableObjectAlarm,
    Effect.gen(function* () {
      const state = yield* DurableObjectState;

      const reconcileAlarm = Effect.fn("DurableObjectAlarm.reconcileAlarm")(function* () {
        const cursor = yield* state.storage.sql.exec<NextAlarmRow>(
          `SELECT run_at FROM effect_cf_scheduled_alarms ORDER BY run_at ASC, storage_id ASC LIMIT 1`,
        );
        const next = (yield* cursor.toArray())[0];

        if (next === undefined) {
          yield* state.storage.deleteAlarm();

          return;
        }

        yield* state.storage.setAlarm(next.run_at);
      });

      const rescheduleFailedAlarm = Effect.fn("DurableObjectAlarm.rescheduleFailedAlarm")(
        function* (row: AlarmRow, retryDelayMillis: number) {
          const retryAt = (yield* Clock.currentTimeMillis) + retryDelayMillis;

          if (row.repeat_every_ms === null) {
            const cursor = yield* state.storage.sql.exec(
              `UPDATE effect_cf_scheduled_alarms
                  SET run_at = ?
                WHERE storage_id = ?
                  AND run_at = ?
                  AND repeat_every_ms IS NULL
                  AND payload = ?`,
              retryAt,
              row.storage_id,
              row.run_at,
              row.payload,
            );

            yield* cursor.rowsWritten;

            return;
          }

          const cursor = yield* state.storage.sql.exec(
            `UPDATE effect_cf_scheduled_alarms
                SET run_at = ?
              WHERE storage_id = ?
                AND run_at = ?
                AND repeat_every_ms = ?
                AND payload = ?`,
            retryAt,
            row.storage_id,
            row.run_at,
            row.repeat_every_ms,
            row.payload,
          );

          yield* cursor.rowsWritten;
        },
      );

      const acknowledgeAlarm = Effect.fn("DurableObjectAlarm.acknowledgeAlarm")(function* (
        row: AlarmRow,
      ) {
        if (row.repeat_every_ms === null) {
          const cursor = yield* state.storage.sql.exec(
            `DELETE FROM effect_cf_scheduled_alarms
              WHERE storage_id = ?
                AND run_at = ?
                AND repeat_every_ms IS NULL
                AND payload = ?`,
            row.storage_id,
            row.run_at,
            row.payload,
          );

          yield* cursor.rowsWritten;

          return;
        }

        const acknowledgedAt = yield* Clock.currentTimeMillis;
        const cursor = yield* state.storage.sql.exec(
          `UPDATE effect_cf_scheduled_alarms
              SET run_at = ?
            WHERE storage_id = ?
              AND run_at = ?
              AND repeat_every_ms = ?
              AND payload = ?`,
          acknowledgedAt + row.repeat_every_ms,
          row.storage_id,
          row.run_at,
          row.repeat_every_ms,
          row.payload,
        );

        yield* cursor.rowsWritten;
      });

      const cancelAlarm = Effect.fn("DurableObjectAlarm.cancelAlarm")(function* (input: AlarmRef) {
        const ref = yield* decodeAlarmRef(input);

        yield* state.storage.sql.exec(
          `DELETE FROM effect_cf_scheduled_alarms WHERE storage_id = ?`,
          getScheduledEventId(ref),
        );
      });

      const scheduleAlarm = Effect.fn("DurableObjectAlarm.scheduleAlarm")(function* (
        input: ScheduleAlarmInput,
      ) {
        const ref = yield* decodeAlarmRef(input);
        const repeatEveryMillis = yield* toRepeatEveryMillis(input.repeatEvery);
        const payload = yield* encodeStoredPayload(input.payload);
        const runAt = DateTime.toEpochMillis(input.runAt);

        yield* state.storage.sql.exec(
          `INSERT OR REPLACE INTO effect_cf_scheduled_alarms
                   (storage_id, alarm_id, tag, run_at, repeat_every_ms, payload)
                 VALUES (?, ?, ?, ?, ?, ?)`,
          getScheduledEventId(ref),
          ref.id,
          ref.tag,
          runAt,
          repeatEveryMillis,
          payload,
        );
      });

      const transaction: AlarmScheduler["transaction"] = (closure) =>
        state.storage.transaction(() =>
          Effect.withFiber((owner) => {
            let active = true;

            // A callback-owned handle cannot escape via a returned Effect or a
            // detached fiber and write after reconciliation or rollback.
            const requireActive = <A, E>(effect: Effect.Effect<A, E>) =>
              Effect.withFiber<A, E | StorageOperationError>((fiber) =>
                active && fiber === owner
                  ? effect
                  : Effect.fail(
                      new StorageOperationError({
                        operation: "alarm.transaction",
                        cause: new Error(
                          "Alarm mutations require their active transaction callback",
                        ),
                      }),
                    ),
              );

            return Effect.gen(function* () {
              yield* ensureTable(state);
              const result = yield* Effect.suspend(() =>
                closure({
                  cancelAlarm: (input) => requireActive(cancelAlarm(input)),
                  scheduleAlarm: (input) => requireActive(scheduleAlarm(input)),
                }),
              ).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    active = false;
                  }),
                ),
              );

              yield* reconcileAlarm();

              return result;
            });
          }),
        );

      const processDueAlarms = Effect.fn("DurableObjectAlarm.processDueAlarms")(function* <
        R,
        E,
        OnFailureR,
        OnFailureE,
      >(
        handle: ProcessDueAlarmsHandler<R, E>,
        options?: ProcessDueAlarmsOptions<OnFailureR, OnFailureE>,
      ) {
        yield* ensureTable(state);
        const mode = options?.mode ?? "isolated";
        const limit = yield* getProcessLimit(options);
        const now = yield* Clock.currentTimeMillis;
        const cursor = yield* state.storage.sql.exec<AlarmRow>(
          `SELECT storage_id, alarm_id, tag, run_at, repeat_every_ms, payload
             FROM effect_cf_scheduled_alarms
            WHERE run_at <= ?
            ORDER BY run_at ASC, storage_id ASC
            LIMIT ?`,
          now,
          limit,
        );
        const dueRows = yield* cursor.toArray();
        const handled: DurableObjectAlarmEvent[] = [];
        const failed: ProcessDueAlarmsFailure[] = [];

        const handleFailure = function* (
          row: AlarmRow,
          event: DurableObjectAlarmEvent | undefined,
          cause: unknown,
        ) {
          const failure: ProcessDueAlarmsFailure = {
            cause,
            event,
            id: row.alarm_id,
            storageId: row.storage_id,
            tag: row.tag,
          };

          failed.push(failure);
          const failureAction =
            options?.onFailure === undefined ? undefined : yield* options.onFailure(failure);
          const actionMode =
            failureAction === undefined ? mode : getFailureActionMode(failureAction);

          if (actionMode === "retry" || actionMode === "isolated") {
            const actionRetryDelay =
              failureAction === undefined ? undefined : getFailureActionRetryDelay(failureAction);
            const retryDelay =
              actionRetryDelay === undefined
                ? yield* getFailureRetryDelay(options)
                : yield* toFailureRescheduleMillis(actionRetryDelay);

            yield* rescheduleFailedAlarm(row, retryDelay);

            return "continue" as const;
          }

          if (actionMode === "skip-and-advance-repeat") {
            yield* acknowledgeAlarm(row);

            return "continue" as const;
          }

          yield* reconcileAlarm();

          return "stop" as const;
        };

        for (const row of dueRows) {
          const eventExit = yield* Effect.exit(toAlarmDue(row));

          if (Exit.isFailure(eventExit)) {
            const action = yield* handleFailure(row, undefined, eventExit.cause);

            if (action === "stop") {
              return yield* Effect.failCause(eventExit.cause);
            }
            continue;
          }

          const event = eventExit.value;
          const handleExit = yield* Effect.exit(handle(event));

          if (Exit.isFailure(handleExit)) {
            const action = yield* handleFailure(row, event, handleExit.cause);

            if (action === "stop") {
              return yield* Effect.failCause(handleExit.cause);
            }
            continue;
          }

          yield* acknowledgeAlarm(row);
          handled.push(event);
        }

        yield* reconcileAlarm();

        return { failed, handled };
      });

      return DurableObjectAlarm.of({
        cancelAlarm: (input) => transaction((alarms) => alarms.cancelAlarm(input)),
        processDueAlarms,
        scheduleAlarm: (input) => transaction((alarms) => alarms.scheduleAlarm(input)),
        transaction,
      });
    }),
  );
}
