import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as S from "effect/Schema";

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
CREATE TABLE IF NOT EXISTS effect_cf_alarm_attempts (
  storage_id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  parked INTEGER NOT NULL,
  retry_at INTEGER,
  ordered INTEGER NOT NULL,
  progress INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_effect_cf_alarm_attempts_ordered
  ON effect_cf_alarm_attempts (storage_id) WHERE ordered = 1;
`;

const DEFAULT_PROCESS_DUE_ALARMS_LIMIT = 100;

export const MIN_RETRY_DELAY_MS = 1_000;
export const UNCHANGED_ATTEMPT_BUDGET = 8;
export const PARKED_RETRY_DELAY_MS = 3_600_000;

/** Product schedules must be at least one minute apart. Never use repeats to poll state. */
export const MIN_REPEAT_INTERVAL_MS = 60_000;

const retryDelay = (attempts: number, initialDelay = MIN_RETRY_DELAY_MS) =>
  attempts >= UNCHANGED_ATTEMPT_BUDGET
    ? PARKED_RETRY_DELAY_MS
    : Math.min(PARKED_RETRY_DELAY_MS, initialDelay * 2 ** (attempts - 1));

const getScheduledEventId = (input: { readonly id: string; readonly tag: string }) =>
  `effect-cf-alarm:${encodeURIComponent(input.tag)}:${encodeURIComponent(input.id)}`;

export type AlarmPayload = S.Json;

interface AlarmRow extends Record<string, SqlStorageValue> {
  readonly attempts: number;
  readonly alarm_id: string;
  readonly payload: string;
  readonly repeat_every_ms: number | null;
  readonly run_at: number;
  readonly storage_id: string;
  readonly tag: string;
  readonly revision: string;
  readonly parked: number;
  readonly retry_at: number | null;
  readonly ordered: number;
  readonly progress: number;
}

const alarmRowsSql = `
  SELECT a.*, COALESCE(s.revision, '') AS revision,
         COALESCE(s.attempts, 0) AS attempts, COALESCE(s.parked, 0) AS parked,
         s.retry_at, COALESCE(s.ordered, 0) AS ordered, COALESCE(s.progress, -1) AS progress
    FROM effect_cf_scheduled_alarms a
    LEFT JOIN effect_cf_alarm_attempts s USING (storage_id)`;

// A failed ordered row keeps its logical position while its retry deadline moves.
const eligibleRowsSql = `NOT EXISTS (
  SELECT 1 FROM effect_cf_scheduled_alarms blocker
  JOIN effect_cf_alarm_attempts budget USING (storage_id)
  WHERE budget.ordered = 1 AND
    (blocker.run_at < a.run_at OR
     (blocker.run_at = a.run_at AND blocker.storage_id < a.storage_id)))`;

const sameRevisionSql = `storage_id = ? AND COALESCE(
  (SELECT revision FROM effect_cf_alarm_attempts WHERE storage_id = ?), '') = ?`;

/** Content-free: no alarm identifiers, payload, error text or consumer state. */
export const AlarmParked = S.TaggedStruct("AlarmParked", {
  attempts: S.Int,
  retryAt: S.DateTimeUtc,
});
export type AlarmParked = typeof AlarmParked.Type;

/** Install with Layer.succeed / Effect.provideService. Reporting cannot undo a committed guard. */
export const AlarmReporter = Context.Reference<(event: AlarmParked) => Effect.Effect<void>>(
  "effect-cf/DurableObjectAlarm/AlarmReporter",
  { defaultValue: () => (event) => Effect.logWarning(event) },
);

const CurrentAlarmPass = Context.Reference<
  { readonly row: AlarmRow; readonly parked: AlarmParked[]; active: boolean } | undefined
>("effect-cf/DurableObjectAlarm/CurrentAlarmPass", { defaultValue: () => undefined });

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

/**
 * Arm a logical deadline. External enrollment is progress; handler self-rearms consume a budget.
 * Reusing `{tag, id}` replaces an alarm. Product repeats (minimum one minute) run after completion.
 */
export type ScheduleAlarmInput<Tag extends string = string> = AlarmRef<Tag> & {
  readonly payload: AlarmPayload;
  readonly repeatEvery?: Duration.Input;
  readonly runAt: DateTime.Utc;
  /** Optional monotonic source cursor. Only a strictly increasing cursor resets a live budget. */
  readonly progress?: number;
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
  readonly parked: readonly AlarmParked[];
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
export type AlarmTransaction = Pick<
  AlarmScheduler,
  "scheduleAlarm" | "scheduleAlarmEarlier" | "cancelAlarm"
>;

export interface AlarmStatus {
  readonly attempts: number;
  readonly parked: boolean;
  readonly runAt: DateTime.Utc;
  readonly retryAt: DateTime.Utc | undefined;
}

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

  /** Inspect retained work, including hourly recovery deadlines. */
  readonly getAlarmStatus: (
    input: AlarmRef,
  ) => Effect.Effect<AlarmStatus | undefined, InvalidAlarmRefError | StorageOperationError>;

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
  /** Atomically min-merge a logical deadline. Preserves an earlier alarm's payload and repeat. */
  readonly scheduleAlarmEarlier: AlarmScheduler["scheduleAlarm"];
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

      if (!Number.isFinite(millis) || millis < MIN_REPEAT_INTERVAL_MS) {
        throw new Error("Alarm repeatEvery must be at least one minute and finite");
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

      return Math.max(MIN_RETRY_DELAY_MS, Math.ceil(millis));
    },
    catch: (cause) => new InvalidProcessDueAlarmsOptionsError({ cause }),
  });

const getFailureRetryDelay = (options: ProcessDueAlarmsOptions<unknown, unknown> | undefined) =>
  toFailureRescheduleMillis(options?.retryFailedAfter ?? MIN_RETRY_DELAY_MS);

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
  readonly scheduleAlarmEarlier: DefinedAlarmTransaction<Definitions>["scheduleAlarm"];
  readonly cancelAlarm: (
    input: AlarmRef<keyof Definitions & string>,
  ) => ReturnType<AlarmScheduler["cancelAlarm"]>;
}

const TypedAlarmSchedulerTypeId: unique symbol = Symbol.for(
  "effect-cf/DurableObjectAlarm/TypedScheduler",
);

/** Identifies service requirements whose scheduler needs a registered dispatcher. */
export interface AlarmService {
  readonly Service: {
    readonly [TypedAlarmSchedulerTypeId]: typeof TypedAlarmSchedulerTypeId;
  };
}

export interface DefinedAlarmScheduler<
  Definitions extends AlarmDefinitions,
> extends DefinedAlarmTransaction<Definitions> {
  readonly [TypedAlarmSchedulerTypeId]: typeof TypedAlarmSchedulerTypeId;
  readonly getAlarmStatus: (
    input: AlarmRef<keyof Definitions & string>,
  ) => ReturnType<AlarmScheduler["getAlarmStatus"]>;
  readonly transaction: <A, E, R>(
    closure: (alarms: DefinedAlarmTransaction<Definitions>) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StorageOperationError, R>;
}

/** Registers a dispatcher and the service authorized to schedule its alarms. */
export interface AlarmRegistration<Self, R = never, E = never> {
  readonly layer: Layer.Layer<Self, never, DurableObjectAlarm>;
  readonly run: Effect.Effect<
    ProcessDueAlarmsResult,
    E | DurableObjectAlarmError,
    R | DurableObjectAlarm
  >;
}

export interface AlarmTagClass<
  Self,
  Id extends string,
  Definitions extends AlarmDefinitions,
> extends Context.ServiceClass<Self, Id, DefinedAlarmScheduler<Definitions>> {
  readonly handlers: <R = never, E = never>(
    handlers: DefinedAlarmHandlers<Definitions, R, E>,
    options?: ProcessDueAlarmsOptions<R, E>,
  ) => AlarmRegistration<Self, R, E>;
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

const makeDefinition = <const Definitions extends AlarmDefinitions>(definitions: Definitions) => {
  const definitionFor = (tag: string) =>
    Object.hasOwn(definitions, tag) ? definitions[tag] : undefined;

  const bind = (mutations: AlarmTransaction): DefinedAlarmTransaction<Definitions> => {
    const schedule = (method: "scheduleAlarm" | "scheduleAlarmEarlier") =>
      Effect.fn("DefinedAlarms.scheduleAlarm")(function* (
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

        yield* mutations[method]({ ...input, payload });
      });

    return {
      scheduleAlarm: schedule("scheduleAlarm"),
      scheduleAlarmEarlier: schedule("scheduleAlarmEarlier"),
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
    };
  };

  return {
    make: (alarms: AlarmScheduler): DefinedAlarmScheduler<Definitions> => ({
      [TypedAlarmSchedulerTypeId]: TypedAlarmSchedulerTypeId,
      ...bind(alarms),
      getAlarmStatus: (input) => alarms.getAlarmStatus(input),
      transaction: (closure) => alarms.transaction((tx) => closure(bind(tx))),
    }),
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

/** Handler-only definitions for applications using the raw scheduler. Prefer Tag for typed scheduling. */
export const define = <const Definitions extends AlarmDefinitions>(definitions: Definitions) => ({
  handlers: makeDefinition(definitions).handlers,
});

/** The typed scheduler becomes available when its handlers are registered on a Durable Object. */
export const Tag =
  <Self>() =>
  <const Id extends string, const Definitions extends AlarmDefinitions>(
    id: Id,
    definitions: Definitions,
  ): AlarmTagClass<Self, Id, Definitions> => {
    const tag = Context.Service<Self, DefinedAlarmScheduler<Definitions>>()(id);
    const definition = makeDefinition(definitions);

    return Object.assign(tag, {
      handlers: <R = never, E = never>(
        handlers: DefinedAlarmHandlers<Definitions, R, E>,
        options?: ProcessDueAlarmsOptions<R, E>,
      ): AlarmRegistration<Self, R, E> => ({
        layer: Layer.effect(tag, Effect.map(DurableObjectAlarm, definition.make)),
        run: definition.handlers(handlers, options),
      }),
    });
  };

export class DurableObjectAlarm extends Context.Service<DurableObjectAlarm, AlarmScheduler>()(
  "effect-cf/DurableObjectAlarm",
) {
  static readonly layer: Layer.Layer<DurableObjectAlarm, never, DurableObjectState> = Layer.effect(
    DurableObjectAlarm,
    Effect.gen(function* () {
      const state = yield* DurableObjectState;

      const readRow = Effect.fnUntraced(function* (storageId: string) {
        const cursor = yield* state.storage.sql.exec<AlarmRow>(
          `${alarmRowsSql} WHERE a.storage_id = ?`,
          storageId,
        );

        return (yield* cursor.toArray())[0];
      });

      const reconcileAlarm = Effect.fn("DurableObjectAlarm.reconcileAlarm")(function* () {
        const cursor = yield* state.storage.sql.exec<NextAlarmRow>(
          `SELECT MAX(a.run_at, COALESCE(s.retry_at, a.run_at)) AS run_at
             FROM effect_cf_scheduled_alarms a
             LEFT JOIN effect_cf_alarm_attempts s USING (storage_id)
            WHERE ${eligibleRowsSql}
            ORDER BY run_at ASC, a.storage_id ASC LIMIT 1`,
        );
        const next = (yield* cursor.toArray())[0];

        // The scheduler is the sole alarm writer. Raw storage is confined to this boundary.
        yield* Effect.tryPromise({
          try: () =>
            next === undefined
              ? state.raw.storage.deleteAlarm()
              : state.raw.storage.setAlarm(next.run_at),
          catch: (cause) =>
            new StorageOperationError({
              operation: next === undefined ? "deleteAlarm" : "setAlarm",
              cause,
            }),
        });
      });

      const writeAttempts = Effect.fnUntraced(function* (
        storageId: string,
        attempts: number,
        parked: number,
        retryAt: number | null,
        ordered: number,
        progress: number,
      ) {
        yield* state.storage.sql.exec(
          `INSERT OR REPLACE INTO effect_cf_alarm_attempts
            (storage_id, revision, attempts, parked, retry_at, ordered, progress)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          storageId,
          crypto.randomUUID(),
          attempts,
          parked,
          retryAt,
          ordered,
          progress,
        );
      });

      const cancelAlarm = Effect.fn("DurableObjectAlarm.cancelAlarm")(function* (input: AlarmRef) {
        const ref = yield* decodeAlarmRef(input);
        const storageId = getScheduledEventId(ref);

        yield* state.storage.sql.exec(
          `DELETE FROM effect_cf_scheduled_alarms WHERE storage_id = ?`,
          storageId,
        );
        yield* state.storage.sql.exec(
          `DELETE FROM effect_cf_alarm_attempts WHERE storage_id = ?`,
          storageId,
        );
      });

      const scheduleAlarm = Effect.fn("DurableObjectAlarm.scheduleAlarm")(function* (
        input: ScheduleAlarmInput,
        earlier: boolean,
        reports: string[],
      ) {
        const ref = yield* decodeAlarmRef(input);
        const repeatEveryMillis = yield* toRepeatEveryMillis(input.repeatEvery);
        const payload = yield* encodeStoredPayload(input.payload);
        const storageId = getScheduledEventId(ref);
        const existing = yield* readRow(storageId);
        const pass = yield* CurrentAlarmPass;
        const source = pass?.row;
        const progress = existing?.progress ?? source?.progress ?? -1;

        if (pass !== undefined && !pass.active) {
          return yield* Effect.fail(
            new StorageOperationError({
              operation: "alarm.schedule",
              cause: new Error(
                "Alarm handlers cannot schedule detached work after their pass ends",
              ),
            }),
          );
        }
        if (input.progress !== undefined) {
          yield* S.decodeUnknownEffect(S.Natural)(input.progress).pipe(
            Effect.mapError((cause) => new InvalidAlarmRefError({ cause })),
          );
        }
        // Replayed source notices cannot refill a live lane's budget or replace newer state.
        if (source === undefined && input.progress !== undefined && input.progress <= progress) {
          return;
        }
        const progressed = input.progress !== undefined && input.progress > progress;
        const sourceProgressed =
          source !== undefined && storageId === source.storage_id && progress > source.progress;
        const attempts =
          source === undefined || progressed || sourceProgressed
            ? 0
            : Math.min(
                UNCHANGED_ATTEMPT_BUDGET,
                Math.max(source.attempts + 1, existing?.attempts ?? 0),
              );
        const parked = attempts >= UNCHANGED_ATTEMPT_BUDGET ? 1 : 0;
        const now = yield* Clock.currentTimeMillis;
        const retryAt = attempts === 0 ? null : now + retryDelay(attempts);
        const runAt = DateTime.toEpochMillis(input.runAt);
        const keepEarlier = earlier && existing !== undefined && existing.run_at <= runAt;
        const scheduledAt = keepEarlier ? existing.run_at : runAt;

        yield* state.storage.sql.exec(
          `INSERT OR REPLACE INTO effect_cf_scheduled_alarms
            (storage_id, alarm_id, tag, run_at, repeat_every_ms, payload)
           VALUES (?, ?, ?, ?, ?, ?)`,
          storageId,
          ref.id,
          ref.tag,
          scheduledAt,
          keepEarlier ? existing.repeat_every_ms : repeatEveryMillis,
          keepEarlier ? existing.payload : payload,
        );
        yield* writeAttempts(
          storageId,
          attempts,
          parked,
          retryAt,
          0,
          Math.max(progress, input.progress ?? -1),
        );
        if (parked === 1 && retryAt !== null && (existing?.parked ?? source?.parked ?? 0) === 0) {
          reports.push(storageId);
        }
      });

      const reportParked = Effect.fnUntraced(function* (storageIds: readonly string[]) {
        if (storageIds.length === 0) return;
        const pass = yield* CurrentAlarmPass;
        const report = yield* AlarmReporter;

        for (const storageId of new Set(storageIds)) {
          const row = yield* readRow(storageId);

          // Cancellation or progress later in the same transaction removes tentative parking.
          if (row === undefined || row.parked === 0 || row.retry_at === null) continue;
          const event = AlarmParked.make({
            attempts: row.attempts,
            retryAt: DateTime.makeUnsafe(Math.max(row.run_at, row.retry_at)),
          });

          pass?.parked.push(event);
          // Reporting is at-most-once per parked episode, after the native commit.
          yield* Effect.exit(Effect.suspend(() => report(event)));
        }
      });

      const transaction: AlarmScheduler["transaction"] = Effect.fnUntraced(function* (closure) {
        const reports: string[] = [];
        const result = yield* state.storage.transaction(() =>
          Effect.withFiber((owner) => {
            let active = true;
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
                  scheduleAlarm: (input) => requireActive(scheduleAlarm(input, false, reports)),
                  scheduleAlarmEarlier: (input) =>
                    requireActive(scheduleAlarm(input, true, reports)),
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

        yield* reportParked(reports);

        return result;
      });

      const rescheduleFailedAlarm = Effect.fnUntraced(function* (
        row: AlarmRow,
        initialDelay: number,
        ordered: boolean,
        reports: string[],
      ) {
        const current = yield* readRow(row.storage_id);

        if (current === undefined || current.revision !== row.revision) {
          return;
        }
        const attempts = Math.min(UNCHANGED_ATTEMPT_BUDGET, row.attempts + 1);
        const retryAt = (yield* Clock.currentTimeMillis) + retryDelay(attempts, initialDelay);
        const parked = attempts >= UNCHANGED_ATTEMPT_BUDGET ? 1 : 0;

        yield* writeAttempts(
          row.storage_id,
          attempts,
          parked,
          retryAt,
          ordered ? 1 : 0,
          row.progress,
        );
        if (parked === 1 && row.parked === 0) {
          reports.push(row.storage_id);
        }
      });

      const acknowledgeAlarm = Effect.fnUntraced(function* (row: AlarmRow) {
        if (row.repeat_every_ms === null) {
          const cursor = yield* state.storage.sql.exec(
            `DELETE FROM effect_cf_scheduled_alarms WHERE ${sameRevisionSql}`,
            row.storage_id,
            row.storage_id,
            row.revision,
          );

          if ((yield* cursor.rowsWritten) > 0) {
            yield* state.storage.sql.exec(
              `DELETE FROM effect_cf_alarm_attempts WHERE storage_id = ?`,
              row.storage_id,
            );
          }

          return;
        }
        const now = yield* Clock.currentTimeMillis;
        const cursor = yield* state.storage.sql.exec(
          `UPDATE effect_cf_scheduled_alarms SET run_at = ? WHERE ${sameRevisionSql}`,
          now + Math.max(MIN_REPEAT_INTERVAL_MS, row.repeat_every_ms),
          row.storage_id,
          row.storage_id,
          row.revision,
        );

        if ((yield* cursor.rowsWritten) > 0) {
          // A completed product occurrence is progress. Missed occurrences are never replayed.
          yield* writeAttempts(row.storage_id, 0, 0, null, 0, row.progress);
        }
      });

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
        const initialDelay = yield* getFailureRetryDelay(options);
        const now = yield* Clock.currentTimeMillis;
        const cursor = yield* state.storage.sql.exec<AlarmRow>(
          `${alarmRowsSql}
            WHERE MAX(a.run_at, COALESCE(s.retry_at, a.run_at)) <= ? AND ${eligibleRowsSql}
            ORDER BY a.run_at ASC, a.storage_id ASC LIMIT ?`,
          now,
          limit,
        );
        const dueRows = yield* cursor.toArray();
        const handled: DurableObjectAlarmEvent[] = [];
        const failed: ProcessDueAlarmsFailure[] = [];
        const parked: AlarmParked[] = [];

        const handleFailure = Effect.fnUntraced(function* (
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
          const actionExit = yield* Effect.exit(
            options?.onFailure === undefined
              ? Effect.void
              : Effect.suspend(() => options.onFailure!(failure)),
          );
          const action = Exit.isSuccess(actionExit) ? actionExit.value : undefined;
          const actionMode = action === undefined ? mode : getFailureActionMode(action);
          const delayInput = action === undefined ? undefined : getFailureActionRetryDelay(action);
          const delayExit = yield* Effect.exit(
            delayInput === undefined
              ? Effect.succeed(initialDelay)
              : toFailureRescheduleMillis(delayInput),
          );
          const delay = Exit.isSuccess(delayExit) ? delayExit.value : initialDelay;
          const reports: string[] = [];

          yield* transaction(() =>
            actionMode === "skip-and-advance-repeat"
              ? acknowledgeAlarm(row)
              : rescheduleFailedAlarm(row, delay, actionMode === "ordered", reports),
          );
          yield* reportParked(reports);
          if (Exit.isFailure(actionExit)) {
            return yield* Effect.failCause(actionExit.cause);
          }
          if (Exit.isFailure(delayExit)) {
            return yield* Effect.failCause(delayExit.cause);
          }

          return actionMode === "ordered" ? ("stop" as const) : ("continue" as const);
        });

        for (const row of dueRows) {
          const current = yield* readRow(row.storage_id);

          if (current === undefined || current.revision !== row.revision) {
            continue;
          }
          const inPass = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
            const pass = { row, parked, active: true };

            return effect.pipe(
              Effect.provideService(CurrentAlarmPass, pass),
              Effect.ensuring(
                Effect.sync(() => {
                  pass.active = false;
                }),
              ),
            );
          };
          const eventExit = yield* Effect.exit(toAlarmDue(row));

          if (Exit.isFailure(eventExit)) {
            const action = yield* inPass(handleFailure(row, undefined, eventExit.cause));

            if (action === "stop") {
              return yield* Effect.failCause(eventExit.cause);
            }
            continue;
          }
          const event = eventExit.value;
          const handleExit = yield* Effect.exit(inPass(Effect.suspend(() => handle(event))));

          if (Exit.isFailure(handleExit)) {
            const action = yield* inPass(handleFailure(row, event, handleExit.cause));

            if (action === "stop") {
              return yield* Effect.failCause(handleExit.cause);
            }
            continue;
          }
          yield* transaction(() => acknowledgeAlarm(row));
          handled.push(event);
        }
        yield* transaction(() => Effect.void);

        return { failed, handled, parked };
      });

      return DurableObjectAlarm.of({
        cancelAlarm: (input) => transaction((alarms) => alarms.cancelAlarm(input)),
        getAlarmStatus: Effect.fnUntraced(function* (input) {
          const ref = yield* decodeAlarmRef(input);

          yield* ensureTable(state);
          const row = yield* readRow(getScheduledEventId(ref));

          return row === undefined
            ? undefined
            : {
                attempts: row.attempts,
                parked: row.parked === 1,
                runAt: DateTime.makeUnsafe(row.run_at),
                retryAt: row.retry_at === null ? undefined : DateTime.makeUnsafe(row.retry_at),
              };
        }),
        processDueAlarms,
        scheduleAlarm: (input) => transaction((alarms) => alarms.scheduleAlarm(input)),
        scheduleAlarmEarlier: (input) =>
          transaction((alarms) => alarms.scheduleAlarmEarlier(input)),
        transaction,
      });
    }),
  );
}
