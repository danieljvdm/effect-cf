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
  wake_at INTEGER NOT NULL DEFAULT 0,
  repeat_every_ms INTEGER,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS effect_cf_alarm_attempts (
  storage_id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  parked INTEGER NOT NULL,
  retry_at INTEGER,
  progress INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS effect_cf_alarm_wakeups (
  key TEXT PRIMARY KEY,
  run_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_effect_cf_alarm_wakeups_run_at_key
  ON effect_cf_alarm_wakeups (run_at, key);
`;

const WAKE_INDEX = "idx_effect_cf_scheduled_alarms_wake_at_storage_id";

const DEFAULT_PROCESS_DUE_ALARMS_LIMIT = 100;

export const MIN_RETRY_DELAY_MS = 1_000;
/** Default unchanged-attempt budget. */
export const UNCHANGED_ATTEMPT_BUDGET = 8;
/** Minimum and default parked recovery interval. */
export const PARKED_RETRY_DELAY_MS = 3_600_000;

/** Absolute product repeat floor. */
export const MIN_REPEAT_INTERVAL_MS = 1_000;
/** Default product schedule floor. Never use repeats to poll state. */
export const DEFAULT_MIN_REPEAT_INTERVAL_MS = 60_000;

export interface ScheduleConfiguration {
  /** Retry floor, at least one second. Defaults to one second. */
  readonly minimumRetryDelay?: Duration.Input;
  /** Positive safe integer. Defaults to eight unchanged attempts. */
  readonly unchangedAttemptBudget?: number;
  /** Recovery interval, at least one hour and the retry floor. Defaults to one hour. */
  readonly parkedRetryDelay?: Duration.Input;
  /** Product repeat floor, at least one second. Defaults to one minute. */
  readonly minimumRepeatInterval?: Duration.Input;
}

/** Optional policy overrides. Provide with Layer.succeed in the Durable Object's application layer. */
export const ScheduleConfiguration = Context.Reference<ScheduleConfiguration>(
  "effect-cf/DurableObjectAlarm/ScheduleConfiguration",
  { defaultValue: () => ({}) },
);

const safeIntegerAtLeast = (minimum: number) =>
  S.Int.check(S.isGreaterThanOrEqualTo(minimum), S.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));

const WakeupRow = S.Struct({ key: S.NonEmptyString, run_at: safeIntegerAtLeast(0) });

const ScheduleConfigurationSchema = S.Struct({
  minimumRetryDelay: safeIntegerAtLeast(MIN_RETRY_DELAY_MS),
  unchangedAttemptBudget: safeIntegerAtLeast(1),
  parkedRetryDelay: safeIntegerAtLeast(PARKED_RETRY_DELAY_MS),
  minimumRepeatInterval: safeIntegerAtLeast(MIN_REPEAT_INTERVAL_MS),
}).check(
  S.makeFilter((configuration) =>
    configuration.parkedRetryDelay >= configuration.minimumRetryDelay
      ? undefined
      : "parkedRetryDelay must be at least minimumRetryDelay",
  ),
);

type ResolvedScheduleConfiguration = typeof ScheduleConfigurationSchema.Type;

const retryDelay = (
  attempts: number,
  configuration: ResolvedScheduleConfiguration,
  parked: boolean,
  initialDelay = configuration.minimumRetryDelay,
) =>
  parked
    ? configuration.parkedRetryDelay
    : Math.min(configuration.parkedRetryDelay, initialDelay * 2 ** (attempts - 1));

const getScheduledEventId = (input: { readonly id: string; readonly tag: string }) =>
  `effect-cf-alarm:${encodeURIComponent(input.tag)}:${encodeURIComponent(input.id)}`;

export type AlarmPayload = S.Json;

interface AlarmRow extends Record<string, SqlStorageValue> {
  readonly attempts: number;
  readonly alarm_id: string;
  readonly payload: string;
  readonly repeat_every_ms: number | null;
  readonly run_at: number;
  readonly wake_at: number;
  readonly storage_id: string;
  readonly tag: string;
  readonly revision: string;
  readonly parked: number;
  readonly retry_at: number | null;
  readonly progress: number;
}

const alarmRowsSql = `
  SELECT a.*, COALESCE(s.revision, '') AS revision,
         COALESCE(s.attempts, 0) AS attempts, COALESCE(s.parked, 0) AS parked,
         s.retry_at, COALESCE(s.progress, -1) AS progress
    FROM effect_cf_scheduled_alarms a
    LEFT JOIN effect_cf_alarm_attempts s USING (storage_id)`;

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

const CurrentWakeupPass = Context.Reference<{ active: boolean } | undefined>(
  "effect-cf/DurableObjectAlarm/CurrentWakeupPass",
  { defaultValue: () => undefined },
);

const PrepareWakeups: unique symbol = Symbol("effect-cf/DurableObjectAlarm/PrepareWakeups");
const WakeupsPrepared = Context.Reference<boolean>("effect-cf/DurableObjectAlarm/WakeupsPrepared", {
  defaultValue: () => false,
});
const CurrentRawDispatch = Context.Reference<{ processed: boolean } | undefined>(
  "effect-cf/DurableObjectAlarm/CurrentRawDispatch",
  { defaultValue: () => undefined },
);

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

export class InvalidScheduleConfigurationError extends Data.TaggedError(
  "InvalidScheduleConfigurationError",
)<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Invalid Durable Object alarm configuration: ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

export class InvalidWakeupError extends Data.TaggedError("InvalidWakeupError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Invalid Durable Object wakeup: ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

export class InvalidAlarmRegistrationError extends Data.TaggedError(
  "InvalidAlarmRegistrationError",
)<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Invalid Durable Object alarm registration: ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

const getScheduleConfiguration = Effect.fnUntraced(function* (defaults: ScheduleConfiguration) {
  const input = { ...defaults, ...(yield* ScheduleConfiguration) };

  return yield* Effect.try({
    try: () =>
      S.decodeUnknownSync(ScheduleConfigurationSchema)({
        minimumRetryDelay: Math.ceil(
          Duration.toMillis(input.minimumRetryDelay ?? MIN_RETRY_DELAY_MS),
        ),
        unchangedAttemptBudget: input.unchangedAttemptBudget ?? UNCHANGED_ATTEMPT_BUDGET,
        parkedRetryDelay: Math.ceil(
          Duration.toMillis(input.parkedRetryDelay ?? PARKED_RETRY_DELAY_MS),
        ),
        minimumRepeatInterval: Math.ceil(
          Duration.toMillis(input.minimumRepeatInterval ?? DEFAULT_MIN_REPEAT_INTERVAL_MS),
        ),
      }),
    catch: (cause) => new InvalidScheduleConfigurationError({ cause }),
  });
});

export class StoredAlarmDecodeError extends Data.TaggedError("StoredAlarmDecodeError")<{
  readonly cause: unknown;
  readonly storageId: string;
}> {
  override get message(): string {
    return `Failed to decode stored alarm "${this.storageId}": ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

export type DurableObjectAlarmError =
  | InvalidAlarmRegistrationError
  | InvalidAlarmPayloadError
  | InvalidAlarmRefError
  | InvalidProcessDueAlarmsOptionsError
  | InvalidRepeatEveryError
  | InvalidScheduleConfigurationError
  | InvalidWakeupError
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
 * Reusing `{tag, id}` replaces an alarm. Product repeats use the configured floor and run after completion.
 */
export type ScheduleAlarmInput<Tag extends string = string> = AlarmRef<Tag> & {
  readonly payload: AlarmPayload;
  readonly repeatEvery?: Duration.Input;
  readonly runAt: DateTime.Utc;
  /** Optional monotonic source cursor. Only a strictly increasing cursor resets a live budget. */
  readonly progress?: number;
};

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
  | "retry"
  | "skip-and-advance-repeat"
  | {
      readonly mode: "retry";
      readonly retryFailedAfter?: Duration.Input;
    }
  | {
      readonly mode: "skip-and-advance-repeat";
    };

export interface ProcessDueAlarmsOptions<OnFailureR = never, OnFailureE = never> {
  readonly limit?: number;
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
> & {
  /** Mutate a named maintenance checkpoint inside this same transaction. */
  readonly wakeup: (key: string) => WakeupTransaction;
};

/** Local checkpoint mutations. The owning queue decides when work is idle or next due. */
export interface WakeupTransaction {
  readonly scheduleAt: (
    runAt: DateTime.Utc,
  ) => Effect.Effect<void, InvalidWakeupError | StorageOperationError>;
  readonly scheduleEarlier: WakeupTransaction["scheduleAt"];
  readonly cancel: Effect.Effect<void, InvalidWakeupError | StorageOperationError>;
}

/**
 * A namespaced wake for a durable queue that already owns its claims, retries and progress budget.
 * It is not automatically acknowledged: cancel when idle, or enroll the queue's next deadline.
 */
export interface WakeupScheduler extends WakeupTransaction {
  readonly [TypedAlarmSchedulerTypeId]: typeof TypedAlarmSchedulerTypeId;
  readonly withWakesDeferred: AlarmScheduler["withWakesDeferred"];
  readonly scheduledAt: Effect.Effect<
    DateTime.Utc | undefined,
    InvalidWakeupError | StorageOperationError
  >;
  readonly transaction: <A, E, R>(
    closure: (wakeup: WakeupTransaction) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StorageOperationError, R>;
}

export interface AlarmStatus {
  readonly attempts: number;
  readonly parked: boolean;
  readonly runAt: DateTime.Utc;
  readonly retryAt: DateTime.Utc | undefined;
}

/** Own `storage.setAlarm()` exclusively: a Durable Object has one platform alarm timestamp. */
export type AlarmScheduler = {
  /** Prefer Wakeup services, whose handler registration is checked by DurableObject.make. */
  readonly wakeup: (key: string) => WakeupScheduler;
  /**
   * Keep a native recovery alarm armed while coalescing checkpoint changes across this
   * object's concurrent and nested scopes. Source/checkpoint transactions still commit;
   * the last scope reconciles their current deadlines on success, failure or interruption.
   * Run outside transactions, around bounded maintenance or inline work. The first scope's
   * parkedRetryDelay bounds the shared guard; renew it if it expires and is consumed while
   * scopes remain active. A process loss before exit recovers at that retained alarm.
   */
  readonly withWakesDeferred: <A, E, R>(
    body: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | InvalidScheduleConfigurationError | StorageOperationError, R>;
  /** @internal Commits recovery checkpoints before any named wakeup handler can run. */
  readonly [PrepareWakeups]: Effect.Effect<readonly string[], DurableObjectAlarmError>;
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

  /**
   * Dispatch by effective wake deadline, then storage key. Failures retry independently.
   * Conditional acknowledgements preserve handler replacements; alarms are at-least-once.
   */
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
    | InvalidScheduleConfigurationError
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

const ensureTable = Effect.fnUntraced(function* (state: DurableObjectState["Service"]) {
  yield* state.storage.sql.exec(INIT_TABLE_SQL);
  const index = yield* state.storage.sql.exec(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
    WAKE_INDEX,
  );

  if ((yield* index.toArray()).length > 0) return;
  const columns = yield* state.storage.sql.exec<{ name: string }>(
    "SELECT name FROM pragma_table_info('effect_cf_scheduled_alarms')",
  );
  const names = new Set((yield* columns.toArray()).map((column) => column.name));

  if (!names.has("wake_at")) {
    yield* state.storage.sql.exec(
      "ALTER TABLE effect_cf_scheduled_alarms ADD COLUMN wake_at INTEGER NOT NULL DEFAULT 0",
    );
  }
  // Backfill once, including retained schedules from before attempt tracking existed.
  // The wake index is the durable migration marker and is created only after the backfill.
  yield* state.storage.sql.exec(`UPDATE effect_cf_scheduled_alarms SET
    wake_at = MAX(run_at, COALESCE((SELECT retry_at FROM effect_cf_alarm_attempts s
      WHERE s.storage_id = effect_cf_scheduled_alarms.storage_id), run_at))`);
  yield* state.storage.sql.exec(
    "DROP INDEX IF EXISTS idx_effect_cf_scheduled_alarms_run_at_storage_id",
  );
  yield* state.storage.sql.exec(`CREATE INDEX IF NOT EXISTS ${WAKE_INDEX}
    ON effect_cf_scheduled_alarms (wake_at, storage_id)`);
});

const toRepeatEveryMillis = (input: Duration.Input | undefined, minimum: number) => {
  if (input === undefined) {
    return Effect.succeed(null);
  }

  return Effect.try({
    try: () => {
      const millis = Duration.toMillis(input);

      if (!Number.isFinite(millis) || millis < minimum) {
        throw new Error(`Alarm repeatEvery must be at least ${minimum} milliseconds and finite`);
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

const toFailureRescheduleMillis = (input: Duration.Input, minimum: number) =>
  Effect.try({
    try: () => {
      const millis = Duration.toMillis(input);

      if (!Number.isFinite(millis) || millis <= 0) {
        throw new Error("Alarm failure rescheduleAfter must be a positive finite duration");
      }

      return Math.max(minimum, Math.ceil(millis));
    },
    catch: (cause) => new InvalidProcessDueAlarmsOptionsError({ cause }),
  });

const getFailureRetryDelay = (
  options: ProcessDueAlarmsOptions<unknown, unknown> | undefined,
  configuration: ResolvedScheduleConfiguration,
) =>
  toFailureRescheduleMillis(
    options?.retryFailedAfter ?? configuration.minimumRetryDelay,
    configuration.minimumRetryDelay,
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

export type AlarmFailurePolicy = "retry" | "skip-and-advance-repeat";

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
  readonly layer: Layer.Layer<Self, InvalidAlarmRegistrationError, DurableObjectAlarm>;
  readonly run: Effect.Effect<
    ProcessDueAlarmsResult,
    E | DurableObjectAlarmError,
    R | DurableObjectAlarm
  >;
  readonly [RegistrationParts]?: RegistrationParts<R, E>;
}

const RegistrationParts: unique symbol = Symbol("effect-cf/DurableObjectAlarm/RegistrationParts");
const NamedWakeup: unique symbol = Symbol("effect-cf/DurableObjectAlarm/NamedWakeup");

interface WakeupHandler<R, E> {
  readonly key: string;
  readonly run: Effect.Effect<void, E, R>;
}

interface RegistrationParts<R, E> {
  readonly services: readonly string[];
  readonly wakeups: readonly WakeupHandler<R, E>[];
  readonly hasManaged: boolean;
  readonly managed: AlarmRegistration<never, R, E>["run"];
}

export interface WakeupRegistration<Self, R = never, E = never> extends AlarmRegistration<
  Self,
  R,
  E
> {
  readonly [NamedWakeup]: true;
  readonly [RegistrationParts]: RegistrationParts<R, E>;
}

export interface WakeupTagClass<Self, Id extends string> extends Context.ServiceClass<
  Self,
  Id,
  WakeupScheduler
> {
  readonly handler: <R = never, E = never>(
    handler: Effect.Effect<void, E, R>,
  ) => WakeupRegistration<Self, R, E>;
}

const emptyResult: ProcessDueAlarmsResult = { failed: [], handled: [], parked: [] };

const missingWakeup = (key: string) =>
  new InvalidAlarmRegistrationError({
    cause: new Error(`No handler registered for named wakeup "${key}"`),
  });

const makeRegistration = <Self, R, E>(
  layer: AlarmRegistration<Self>["layer"],
  parts: RegistrationParts<R, E>,
): AlarmRegistration<Self, R, E> => {
  const validate = Effect.try({
    try: () => {
      S.decodeUnknownSync(S.Array(S.NonEmptyString))(parts.services);
      if (new Set(parts.services).size !== parts.services.length) {
        throw new Error("Alarm and wakeup service keys must be unique within a Durable Object");
      }
    },
    catch: (cause) => new InvalidAlarmRegistrationError({ cause }),
  });
  const handlers = new Map(parts.wakeups.map((wakeup) => [wakeup.key, wakeup.run]));

  return {
    [RegistrationParts]: parts,
    layer: layer.pipe(Layer.provide(Layer.effectDiscard(validate))),
    run: Effect.gen(function* () {
      yield* validate;
      const alarms = yield* DurableObjectAlarm;

      return yield* alarms.withWakesDeferred(
        Effect.gen(function* () {
          const due = yield* alarms[PrepareWakeups];
          const runWakeup = (key: string) =>
            Effect.suspend<void, E | InvalidAlarmRegistrationError, R>(() => {
              const handler = handlers.get(key);

              if (handler === undefined) return Effect.fail(missingWakeup(key));
              const pass = { active: true };

              return handler.pipe(
                Effect.provideService(CurrentWakeupPass, pass),
                Effect.ensuring(
                  Effect.sync(() => {
                    pass.active = false;
                  }),
                ),
              );
            });
          // The managed branch always has its own slot. A failed handler cannot interrupt another.
          const [managed, wakeups] = yield* Effect.all(
            [
              parts.managed.pipe(Effect.provideService(WakeupsPrepared, true), Effect.exit),
              Effect.forEach(due, (key) => Effect.exit(runWakeup(key)), { concurrency: 4 }),
            ],
            { concurrency: 2 },
          );

          yield* Exit.asVoidAll([managed, ...wakeups]);

          return Exit.isSuccess(managed) ? managed.value : emptyResult;
        }),
      );
    }),
  };
};

/**
 * Register one durable queue's checkpoint under a stable, unique service key.
 * The queue owns per-item claims, leases, retries and progress budgets. Before dispatch,
 * effect-cf commits a fallback at parkedRetryDelay (at least one hour). The handler must
 * recompute its next deadline or cancel atomically with its source state after doing work.
 */
export const Wakeup =
  <Self>() =>
  <const Id extends string>(id: Id): WakeupTagClass<Self, Id> => {
    const tag = Context.Service<Self, WakeupScheduler>()(id);

    return Object.assign(tag, {
      handler: <R = never, E = never>(
        handler: Effect.Effect<void, E, R>,
      ): WakeupRegistration<Self, R, E> => {
        const parts: RegistrationParts<R, E> = {
          services: [id],
          wakeups: [{ key: id, run: handler }],
          hasManaged: false,
          managed: makeDefinition({}).handlers({}),
        };

        return {
          ...makeRegistration(
            Layer.effect(
              tag,
              Effect.map(DurableObjectAlarm, (alarms) => alarms.wakeup(id)),
            ),
            parts,
          ),
          [NamedWakeup]: true,
          [RegistrationParts]: parts,
        };
      },
    });
  };

type WakeupEffect<Registration extends WakeupRegistration<never, unknown, unknown>> =
  Registration[typeof RegistrationParts]["wakeups"][number]["run"];

/** Compose one managed-alarm registration with named queues under the same platform alarm owner. */
export function withWakeups<
  Self,
  R,
  E,
  const Wakeups extends readonly WakeupRegistration<never, unknown, unknown>[],
>(
  registration: AlarmRegistration<Self, R, E>,
  ...wakeups: Wakeups
): AlarmRegistration<
  Self | Layer.Success<Wakeups[number]["layer"]>,
  R | Effect.Services<WakeupEffect<Wakeups[number]>>,
  E | Effect.Error<WakeupEffect<Wakeups[number]>>
>;
// The overload preserves each heterogeneous registration's service, error and requirement types.
export function withWakeups(
  registration: AlarmRegistration<never, unknown, unknown>,
  ...wakeups: readonly WakeupRegistration<never, unknown, unknown>[]
): AlarmRegistration<never, unknown, unknown> {
  const parts = registration[RegistrationParts] ?? {
    services: [],
    wakeups: [],
    hasManaged: true,
    managed: registration.run,
  };

  return makeRegistration(
    Layer.mergeAll(registration.layer, ...wakeups.map((wakeup) => wakeup.layer)),
    {
      services: [
        ...parts.services,
        ...wakeups.flatMap((wakeup) => wakeup[RegistrationParts].services),
      ],
      wakeups: [
        ...parts.wakeups,
        ...wakeups.flatMap((wakeup) => wakeup[RegistrationParts].wakeups),
      ],
      hasManaged: parts.hasManaged,
      managed: parts.managed,
    },
  );
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

/** @internal Compose raw dispatch with named wakeups, retaining explicit managed dispatchers. */
export const dispatchRawAlarm = <Self, E, R>(
  rawAlarm: Effect.Effect<void, E, R>,
  registration?: AlarmRegistration<Self, R, E>,
): Effect.Effect<void, E | DurableObjectAlarmError, R | DurableObjectAlarm | DurableObjectState> =>
  Effect.gen(function* () {
    const parts = registration?.[RegistrationParts];

    if (registration !== undefined && (parts === undefined || parts.hasManaged)) {
      yield* registration.run;

      return yield* rawAlarm;
    }
    if (registration === undefined) {
      const state = yield* DurableObjectState;
      const hasScheduler = yield* Effect.gen(function* () {
        if (state.raw.storage.sql === undefined) return false;
        // Inspect without creating tables: raw-only objects retain native alarm ownership.
        const tables = yield* state.storage.sql.exec(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?) LIMIT 1",
          "effect_cf_scheduled_alarms",
          "effect_cf_alarm_wakeups",
        );

        return (yield* tables.toArray()).length > 0;
      }).pipe(
        Effect.catchIf(
          (error) =>
            error.cause instanceof Error &&
            (error.cause.message.startsWith("SQL is not enabled for this Durable Object class") ||
              error.cause.message.startsWith(
                "This Durable Object is not backed by SQLite storage",
              )),
          () => Effect.succeed(false),
        ),
      );

      // Legacy KV objects also support raw alarms but cannot contain scheduler SQL tables.
      if (!hasScheduler) return yield* rawAlarm;
    }

    return yield* makeRegistration(Layer.empty, {
      services: parts?.services ?? [],
      wakeups: parts?.wakeups ?? [],
      hasManaged: true,
      managed: Effect.suspend(() => {
        const pass = { processed: false };

        return rawAlarm.pipe(
          Effect.onExit(() =>
            pass.processed ? Effect.void : makeDefinition({}).handlers({}).pipe(Effect.asVoid),
          ),
          Effect.provideService(CurrentRawDispatch, pass),
          Effect.as(emptyResult),
        );
      }),
    }).run.pipe(Effect.asVoid);
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
      ): AlarmRegistration<Self, R, E> =>
        makeRegistration(Layer.effect(tag, Effect.map(DurableObjectAlarm, definition.make)), {
          services: [id],
          wakeups: [],
          hasManaged: true,
          managed: definition.handlers(handlers, options),
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
      const configurationDefaults = { ...(yield* ScheduleConfiguration) };
      let wakeDeferrals = 0;
      let deferredRecoveryDelay = PARKED_RETRY_DELAY_MS;
      let deferredRecoveryAt = 0;

      const readRow = Effect.fnUntraced(function* (storageId: string) {
        const cursor = yield* state.storage.sql.exec<AlarmRow>(
          `${alarmRowsSql} WHERE a.storage_id = ?`,
          storageId,
        );

        return (yield* cursor.toArray())[0];
      });

      // The scheduler is the sole alarm writer. Raw storage is confined to this boundary.
      const writeNativeAlarm = (runAt: number | null) =>
        Effect.tryPromise({
          try: () =>
            runAt === null ? state.raw.storage.deleteAlarm() : state.raw.storage.setAlarm(runAt),
          catch: (cause) =>
            new StorageOperationError({
              operation: runAt === null ? "deleteAlarm" : "setAlarm",
              cause,
            }),
        });

      const reconcileAlarm = Effect.fn("DurableObjectAlarm.reconcileAlarm")(function* () {
        if (wakeDeferrals > 0) {
          const current = yield* state.storage.getAlarm();
          const now = yield* Clock.currentTimeMillis;

          if (current === null && deferredRecoveryAt <= now) {
            deferredRecoveryAt = now + deferredRecoveryDelay;
          }

          // Commit the guard before user work. Later transactions keep it even when
          // logical deadlines move earlier or every checkpoint is cancelled.
          if (current === null || current > deferredRecoveryAt) {
            yield* writeNativeAlarm(deferredRecoveryAt);
          }

          return;
        }
        const cursor = yield* state.storage.sql.exec<NextAlarmRow>(
          `SELECT run_at FROM (
             SELECT wake_at AS run_at FROM effect_cf_scheduled_alarms
               ORDER BY wake_at, storage_id LIMIT 1
           ) UNION ALL SELECT run_at FROM (
             SELECT run_at FROM effect_cf_alarm_wakeups ORDER BY run_at, key LIMIT 1
           ) ORDER BY run_at LIMIT 1`,
        );
        const next = (yield* cursor.toArray())[0];

        yield* writeNativeAlarm(next?.run_at ?? null);
      });

      const decodeWakeupKey = (key: string) =>
        S.decodeUnknownEffect(S.NonEmptyString)(key).pipe(
          Effect.mapError((cause) => new InvalidWakeupError({ cause })),
        );

      const wakeupMutations = (key: string): WakeupTransaction => {
        const check = Effect.gen(function* () {
          const pass = yield* CurrentWakeupPass;

          if (pass !== undefined && !pass.active) {
            return yield* Effect.fail(
              new StorageOperationError({
                operation: "wakeup.schedule",
                cause: new Error(
                  "Wakeup handlers cannot mutate detached work after their pass ends",
                ),
              }),
            );
          }

          return yield* decodeWakeupKey(key);
        });
        const schedule = (runAt: DateTime.Utc, earlier: boolean) =>
          Effect.gen(function* () {
            yield* check;
            const row = yield* S.decodeUnknownEffect(WakeupRow)({
              key,
              run_at: DateTime.toEpochMillis(runAt),
            }).pipe(Effect.mapError((cause) => new InvalidWakeupError({ cause })));

            yield* state.storage.sql.exec(
              `INSERT INTO effect_cf_alarm_wakeups (key, run_at) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET run_at = ${
                earlier ? "MIN(effect_cf_alarm_wakeups.run_at, excluded.run_at)" : "excluded.run_at"
              }`,
              row.key,
              row.run_at,
            );
          });

        return {
          scheduleAt: (runAt) => schedule(runAt, false),
          scheduleEarlier: (runAt) => schedule(runAt, true),
          cancel: Effect.gen(function* () {
            yield* check;
            yield* state.storage.sql.exec("DELETE FROM effect_cf_alarm_wakeups WHERE key = ?", key);
          }),
        };
      };

      const writeAttempts = Effect.fnUntraced(function* (
        storageId: string,
        attempts: number,
        parked: number,
        retryAt: number | null,
        progress: number,
      ) {
        yield* state.storage.sql.exec(
          `INSERT OR REPLACE INTO effect_cf_alarm_attempts
            (storage_id, revision, attempts, parked, retry_at, progress)
           VALUES (?, ?, ?, ?, ?, ?)`,
          storageId,
          crypto.randomUUID(),
          attempts,
          parked,
          retryAt,
          progress,
        );
        // Materialize the effective wake in the same transaction for indexed dispatch/reconciliation.
        yield* state.storage.sql.exec(
          `UPDATE effect_cf_scheduled_alarms
            SET wake_at = MAX(run_at, COALESCE(?, run_at))
            WHERE storage_id = ?`,
          retryAt,
          storageId,
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
        const configuration = yield* getScheduleConfiguration(configurationDefaults);
        const ref = yield* decodeAlarmRef(input);
        const repeatEveryMillis = yield* toRepeatEveryMillis(
          input.repeatEvery,
          configuration.minimumRepeatInterval,
        );
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
            : source.parked === 1 || existing?.parked === 1
              ? Math.max(source.attempts, existing?.attempts ?? 0)
              : Math.min(
                  configuration.unchangedAttemptBudget,
                  Math.max(source.attempts + 1, existing?.attempts ?? 0),
                );
        const parked =
          attempts > 0 &&
          (attempts >= configuration.unchangedAttemptBudget ||
            source?.parked === 1 ||
            existing?.parked === 1)
            ? 1
            : 0;
        const now = yield* Clock.currentTimeMillis;
        const retryAt =
          attempts === 0 ? null : now + retryDelay(attempts, configuration, parked === 1);
        const runAt = DateTime.toEpochMillis(input.runAt);
        const keepEarlier = earlier && existing !== undefined && existing.run_at <= runAt;
        const scheduledAt = keepEarlier ? existing.run_at : runAt;
        const scheduledPayload = keepEarlier ? existing.payload : payload;
        const scheduledRepeat = keepEarlier ? existing.repeat_every_ms : repeatEveryMillis;
        const nextProgress = Math.max(progress, input.progress ?? -1);

        yield* state.storage.sql.exec(
          `INSERT OR REPLACE INTO effect_cf_scheduled_alarms
            (storage_id, alarm_id, tag, run_at, repeat_every_ms, payload)
           VALUES (?, ?, ?, ?, ?, ?)`,
          storageId,
          ref.id,
          ref.tag,
          scheduledAt,
          scheduledRepeat,
          scheduledPayload,
        );
        yield* writeAttempts(storageId, attempts, parked, retryAt, nextProgress);
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
                  wakeup: (key) => {
                    const mutations = wakeupMutations(key);

                    return {
                      scheduleAt: (runAt) => requireActive(mutations.scheduleAt(runAt)),
                      scheduleEarlier: (runAt) => requireActive(mutations.scheduleEarlier(runAt)),
                      cancel: requireActive(mutations.cancel),
                    };
                  },
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

      const withWakesDeferred: AlarmScheduler["withWakesDeferred"] = (body) =>
        Effect.acquireUseRelease(
          Effect.gen(function* () {
            const configuration = yield* getScheduleConfiguration(configurationDefaults);
            const now = yield* Clock.currentTimeMillis;

            if (wakeDeferrals === 0) {
              deferredRecoveryDelay = configuration.parkedRetryDelay;
              deferredRecoveryAt = now + deferredRecoveryDelay;
            }
            wakeDeferrals++;
          }),
          () => transaction(() => Effect.void).pipe(Effect.andThen(body)),
          () =>
            Effect.gen(function* () {
              wakeDeferrals--;
              if (wakeDeferrals === 0) yield* transaction(() => Effect.void);
            }),
        );

      const wakeup = (key: string): WakeupScheduler => ({
        [TypedAlarmSchedulerTypeId]: TypedAlarmSchedulerTypeId,
        withWakesDeferred,
        scheduleAt: (runAt) => transaction((tx) => tx.wakeup(key).scheduleAt(runAt)),
        scheduleEarlier: (runAt) => transaction((tx) => tx.wakeup(key).scheduleEarlier(runAt)),
        cancel: transaction((tx) => tx.wakeup(key).cancel),
        transaction: (closure) => transaction((tx) => closure(tx.wakeup(key))),
        scheduledAt: Effect.gen(function* () {
          yield* decodeWakeupKey(key);
          yield* ensureTable(state);
          const cursor = yield* state.storage.sql.exec(
            "SELECT key, run_at FROM effect_cf_alarm_wakeups WHERE key = ?",
            key,
          );
          const row = (yield* cursor.toArray())[0];

          if (row === undefined) return undefined;
          const decoded = yield* S.decodeUnknownEffect(WakeupRow)(row).pipe(
            Effect.mapError((cause) => new InvalidWakeupError({ cause })),
          );

          return DateTime.makeUnsafe(decoded.run_at);
        }),
      });

      const prepareWakeups = Effect.gen(function* () {
        yield* ensureTable(state);
        const now = yield* Clock.currentTimeMillis;
        const due = yield* state.storage.sql.exec(
          "SELECT key FROM effect_cf_alarm_wakeups WHERE run_at <= ? LIMIT 1",
          now,
        );

        if ((yield* due.toArray()).length === 0) return [];
        const configuration = yield* getScheduleConfiguration(configurationDefaults);

        return yield* transaction(() =>
          Effect.gen(function* () {
            const cursor = yield* state.storage.sql.exec(
              `SELECT key, run_at FROM effect_cf_alarm_wakeups
              WHERE run_at <= ? ORDER BY run_at, key LIMIT ?`,
              now,
              DEFAULT_PROCESS_DUE_ALARMS_LIMIT,
            );
            const rows = yield* S.decodeUnknownEffect(S.Array(WakeupRow))(
              yield* cursor.toArray(),
            ).pipe(Effect.mapError((cause) => new InvalidWakeupError({ cause })));

            // Include unknown keys: removing a registration must not leave a past-due hot loop.
            for (const row of rows) {
              yield* state.storage.sql.exec(
                "UPDATE effect_cf_alarm_wakeups SET run_at = ? WHERE key = ?",
                now + configuration.parkedRetryDelay,
                row.key,
              );
            }

            return rows.map((row) => row.key);
          }),
        );
      });

      const rescheduleFailedAlarm = Effect.fnUntraced(function* (
        row: AlarmRow,
        initialDelay: number,
        configuration: ResolvedScheduleConfiguration,
        reports: string[],
      ) {
        const current = yield* readRow(row.storage_id);

        // A self-rearm already charged this pass; a newer schedule must survive a stale failure.
        if (current === undefined || current.revision !== row.revision) return;
        const attempts =
          row.parked === 1
            ? row.attempts
            : Math.min(configuration.unchangedAttemptBudget, row.attempts + 1);
        const parked = row.parked === 1 || attempts >= configuration.unchangedAttemptBudget ? 1 : 0;
        const retryAt =
          (yield* Clock.currentTimeMillis) +
          retryDelay(attempts, configuration, parked === 1, initialDelay);

        yield* writeAttempts(row.storage_id, attempts, parked, retryAt, row.progress);
        if (parked === 1 && row.parked === 0) {
          reports.push(row.storage_id);
        }
      });

      const acknowledgeAlarm = Effect.fnUntraced(function* (
        row: AlarmRow,
        configuration: ResolvedScheduleConfiguration,
      ) {
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
          now + Math.max(configuration.minimumRepeatInterval, row.repeat_every_ms),
          row.storage_id,
          row.storage_id,
          row.revision,
        );

        if ((yield* cursor.rowsWritten) > 0) {
          // A completed product occurrence is progress. Missed occurrences are never replayed.
          yield* writeAttempts(row.storage_id, 0, 0, null, row.progress);
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
        const configuration = yield* getScheduleConfiguration(configurationDefaults);

        yield* ensureTable(state);
        const unregisteredWakeups = (yield* WakeupsPrepared) ? [] : yield* prepareWakeups;
        const limit = yield* getProcessLimit(options);
        const initialDelay = yield* getFailureRetryDelay(options, configuration);
        const now = yield* Clock.currentTimeMillis;
        const rawDispatch = yield* CurrentRawDispatch;

        // A validated dispatcher owns its remaining batch, including newly enrolled work.
        if (rawDispatch !== undefined) rawDispatch.processed = true;

        const cursor = yield* state.storage.sql.exec<AlarmRow>(
          `${alarmRowsSql}
            WHERE a.wake_at <= ? ORDER BY a.wake_at ASC, a.storage_id ASC LIMIT ?`,
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
          const actionMode = action === undefined ? "retry" : getFailureActionMode(action);
          const delayInput = action === undefined ? undefined : getFailureActionRetryDelay(action);
          const delayExit = yield* Effect.exit(
            delayInput === undefined
              ? Effect.succeed(initialDelay)
              : toFailureRescheduleMillis(delayInput, configuration.minimumRetryDelay),
          );
          const delay = Exit.isSuccess(delayExit) ? delayExit.value : initialDelay;
          const reports: string[] = [];

          yield* transaction(() =>
            actionMode === "skip-and-advance-repeat"
              ? acknowledgeAlarm(row, configuration)
              : rescheduleFailedAlarm(row, delay, configuration, reports),
          );
          yield* reportParked(reports);
          if (Exit.isFailure(actionExit)) {
            return yield* Effect.failCause(actionExit.cause);
          }
          if (Exit.isFailure(delayExit)) {
            return yield* Effect.failCause(delayExit.cause);
          }
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
            yield* inPass(handleFailure(row, undefined, eventExit.cause));
            continue;
          }
          const event = eventExit.value;
          const handleExit = yield* Effect.exit(inPass(Effect.suspend(() => handle(event))));

          if (Exit.isFailure(handleExit)) {
            yield* inPass(handleFailure(row, event, handleExit.cause));
            continue;
          }
          yield* transaction(() => acknowledgeAlarm(row, configuration));
          handled.push(event);
        }
        yield* transaction(() => Effect.void);

        if (unregisteredWakeups.length > 0) {
          return yield* Effect.fail(missingWakeup(unregisteredWakeups[0]!));
        }

        return { failed, handled, parked };
      });

      return DurableObjectAlarm.of({
        wakeup,
        withWakesDeferred,
        [PrepareWakeups]: prepareWakeups,
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
