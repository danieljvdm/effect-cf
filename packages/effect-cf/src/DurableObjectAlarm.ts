import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as S from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { DurableObjectState } from "./DurableObjectState";
import { type SqlStorageValue, StorageOperationError } from "./DurableObjectStorage";
import * as ErrorMessage from "./internal/ErrorMessage";

const INIT_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS effect_cf_scheduled_alarms (
  storage_id TEXT PRIMARY KEY,
  alarm_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'automatic',
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
`;

const WAKE_INDEX = "idx_effect_cf_scheduled_alarms_wake_at_storage_id";
const LIFECYCLE_INDEX = "idx_effect_cf_scheduled_alarms_lifecycle_wake_at_storage_id";

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
  /** Check for due alarms after RPC/fetch responses unwind. Native alarms remain recovery authority. */
  readonly dispatchAfterEvent?: boolean;
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

/** Automatic alarms acknowledge/retry on handler exit; manual alarms retain consumer control. */
export type AlarmLifecycle = "automatic" | "manual";

const AlarmLifecycleSchema = S.Literals(["automatic", "manual"]);

const ScheduleConfigurationSchema = S.Struct({
  dispatchAfterEvent: S.Boolean,
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
  readonly lifecycle: AlarmLifecycle;
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

const AlarmSelection = Context.Reference<
  { readonly tags: readonly string[]; readonly exclude: boolean } | undefined
>("effect-cf/DurableObjectAlarm/AlarmSelection", { defaultValue: () => undefined });
const ManualPermits = Context.Reference<Semaphore.Semaphore | undefined>(
  "effect-cf/DurableObjectAlarm/ManualPermits",
  { defaultValue: () => undefined },
);
const ManualTags: unique symbol = Symbol("effect-cf/DurableObjectAlarm/ManualTags");
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
        dispatchAfterEvent: input.dispatchAfterEvent ?? false,
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
  /** Prefer selecting the lifecycle in a typed Tag definition. Defaults to automatic. */
  readonly lifecycle?: AlarmLifecycle;
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
  readonly [ManualTags]?: ReadonlySet<string>;
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
>;

export interface AlarmStatus {
  readonly attempts: number;
  readonly parked: boolean;
  readonly runAt: DateTime.Utc;
  readonly retryAt: DateTime.Utc | undefined;
}

/** @internal */
export const RunAlarm: unique symbol = Symbol("effect-cf/DurableObjectAlarm/RunAlarm");
/** @internal */
export const DispatchAfterEvent: unique symbol = Symbol(
  "effect-cf/DurableObjectAlarm/DispatchAfterEvent",
);
/** @internal */
export const HasDueAlarms: unique symbol = Symbol("effect-cf/DurableObjectAlarm/HasDueAlarms");

/** Own `storage.setAlarm()` exclusively: a Durable Object has one platform alarm timestamp. */
export type AlarmScheduler = {
  /** @internal DurableObject.make shares this scoped event across native and post-event dispatch. */
  readonly [RunAlarm]: <R>(
    event: (beginDispatch: Effect.Effect<void>) => Effect.Effect<void, unknown, R>,
    native: boolean,
  ) => Effect.Effect<void, unknown, R>;
  /** @internal Read the current event's opt-in without acquiring another event layer. */
  readonly [DispatchAfterEvent]: Effect.Effect<boolean>;
  /** @internal Check inside the alarm event so its clock and configuration apply. */
  readonly [HasDueAlarms]: Effect.Effect<boolean, StorageOperationError>;
  /**
   * Keep a native recovery alarm armed while coalescing checkpoint changes across this
   * object's concurrent and nested scopes. Source/checkpoint transactions still commit;
   * the last scope reconciles their current deadlines on success, failure or interruption.
   * Run outside transactions, around bounded maintenance or inline work. The first scope's
   * parkedRetryDelay bounds the shared guard; renew it if it expires and is consumed while
   * scopes remain active. A process loss before exit recovers at that retained alarm.
   */
  readonly deferWakes: <A, E, R>(
    body: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | InvalidScheduleConfigurationError | StorageOperationError, R>;
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
const StoredTags = S.fromJsonString(S.Array(S.String));

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
    LIFECYCLE_INDEX,
  );

  if ((yield* index.toArray()).length > 0) return;
  const columns = yield* state.storage.sql.exec<{ name: string }>(
    "SELECT name FROM pragma_table_info('effect_cf_scheduled_alarms')",
  );
  const names = new Set((yield* columns.toArray()).map((column) => column.name));

  if (!names.has("lifecycle")) {
    yield* state.storage.sql.exec(
      "ALTER TABLE effect_cf_scheduled_alarms ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'automatic'",
    );
  }
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
  yield* state.storage.sql.exec(`CREATE INDEX IF NOT EXISTS ${LIFECYCLE_INDEX}
    ON effect_cf_scheduled_alarms (lifecycle, wake_at, storage_id)`);
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

export type AlarmDefinitionConfig<Payload extends AlarmPayloadSchema = AlarmPayloadSchema> = {
  readonly payload: Payload;
} & (
  | {
      readonly lifecycle?: "automatic";
      readonly failure?: AlarmFailurePolicy;
      readonly retry?: AlarmRetryPolicy;
    }
  | {
      readonly lifecycle: "manual";
      readonly failure?: never;
      readonly retry?: never;
    }
);

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
  readonly [Tag in keyof Definitions & string]: Omit<
    ScheduleAlarmInput<Tag>,
    "payload" | "lifecycle" | "repeatEvery" | "progress"
  > & {
    readonly payload: AlarmDefinitionPayload<Definitions[Tag]>;
  } & (Definitions[Tag] extends { readonly lifecycle: "manual" }
      ? { readonly repeatEvery?: never; readonly progress?: never }
      : Pick<ScheduleAlarmInput<Tag>, "repeatEvery" | "progress">);
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
  readonly deferWakes: AlarmScheduler["deferWakes"];
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

interface AlarmDispatcher<R, E> {
  readonly tags: readonly string[];
  readonly automatic: boolean;
  readonly run: AlarmRegistration<never, R, E>["run"];
}

interface RegistrationParts<R, E> {
  readonly services: readonly string[];
  readonly dispatchers: readonly AlarmDispatcher<R, E>[];
  readonly invalid?: string;
}

const emptyResult: ProcessDueAlarmsResult = { failed: [], handled: [], parked: [] };

const missingAlarm = (tag: string) =>
  new InvalidAlarmRegistrationError({
    cause: new Error(`No manual handler registered for alarm tag "${tag}"`),
  });

const validateRegistration = <R, E>(parts: RegistrationParts<R, E>) =>
  Effect.try({
    try: () => {
      if (parts.invalid !== undefined) throw new Error(parts.invalid);
      const tags = parts.dispatchers.flatMap((dispatcher) => dispatcher.tags);

      S.decodeUnknownSync(S.Array(S.NonEmptyString))([...parts.services, ...tags]);
      if (
        new Set(parts.services).size !== parts.services.length ||
        new Set(tags).size !== tags.length
      ) {
        throw new Error(
          "Alarm service keys and definition tags must be unique within a Durable Object",
        );
      }
    },
    catch: (cause) => new InvalidAlarmRegistrationError({ cause }),
  });

const runRegistrations = <R, E>(
  parts: RegistrationParts<R, E>,
  rawAlarm?: Effect.Effect<void, E, R>,
): AlarmRegistration<never, R, E>["run"] =>
  Effect.gen(function* () {
    yield* validateRegistration(parts);
    const alarms = yield* DurableObjectAlarm;
    const permits = yield* Semaphore.make(4);
    const tags = parts.dispatchers.flatMap((dispatcher) => dispatcher.tags);
    const fallback =
      rawAlarm === undefined
        ? makeDefinition({}).handlers({})
        : Effect.suspend(() => {
            const pass = { processed: false };

            return rawAlarm.pipe(
              Effect.onExit(() =>
                pass.processed ? Effect.void : makeDefinition({}).handlers({}).pipe(Effect.asVoid),
              ),
              Effect.provideService(CurrentRawDispatch, pass),
              Effect.as(emptyResult),
            );
          });

    return yield* alarms.deferWakes(
      Effect.gen(function* () {
        const registered = parts.dispatchers.map((dispatcher) =>
          dispatcher.run.pipe(
            Effect.provideService(AlarmSelection, { tags: dispatcher.tags, exclude: false }),
          ),
        );
        const recovery = fallback.pipe(
          Effect.provideService(AlarmSelection, { tags, exclude: true }),
        );
        // Preserve raw-hook ordering after explicit automatic registrations. Manual-only
        // registrations leave raw application dispatch independent of queue processing.
        const orderedRaw =
          rawAlarm !== undefined && parts.dispatchers.some((dispatcher) => dispatcher.automatic);
        const exits = yield* Effect.forEach(
          orderedRaw ? registered : [...registered, recovery],
          Effect.exit,
          // Static registrations run independently; manual handlers share four permits.
          { concurrency: "unbounded" },
        );

        if (orderedRaw) exits.push(yield* Effect.exit(recovery));

        yield* Exit.asVoidAll(exits);

        return {
          failed: exits.flatMap((exit) => (Exit.isSuccess(exit) ? exit.value.failed : [])),
          handled: exits.flatMap((exit) => (Exit.isSuccess(exit) ? exit.value.handled : [])),
          parked: exits.flatMap((exit) => (Exit.isSuccess(exit) ? exit.value.parked : [])),
        };
      }).pipe(Effect.provideService(ManualPermits, permits)),
    );
  });

const makeRegistration = <Self, R, E>(
  layer: AlarmRegistration<Self>["layer"],
  parts: RegistrationParts<R, E>,
): AlarmRegistration<Self, R, E> => ({
  [RegistrationParts]: parts,
  layer: layer.pipe(Layer.provide(Layer.effectDiscard(validateRegistration(parts)))),
  run: runRegistrations(parts),
});

/** Compose independent typed alarm registrations under one native alarm owner. */
export function mergeAll<
  const Registrations extends readonly [
    AlarmRegistration<never, unknown, unknown>,
    ...AlarmRegistration<never, unknown, unknown>[],
  ],
>(
  ...registrations: Registrations
): AlarmRegistration<
  Layer.Success<Registrations[number]["layer"]>,
  Exclude<Effect.Services<Registrations[number]["run"]>, DurableObjectAlarm>,
  Exclude<Effect.Error<Registrations[number]["run"]>, DurableObjectAlarmError>
>;
export function mergeAll(
  registration: AlarmRegistration<never, unknown, unknown>,
  ...others: readonly AlarmRegistration<never, unknown, unknown>[]
): AlarmRegistration<never, unknown, unknown> {
  const registrations = [registration, ...others];
  const parts = registrations.map((item) => item[RegistrationParts]);

  return makeRegistration(Layer.mergeAll(registration.layer, ...others.map((item) => item.layer)), {
    services: parts.flatMap((part) => part?.services ?? []),
    dispatchers: parts.flatMap((part) => part?.dispatchers ?? []),
    invalid: parts.some((part) => part === undefined)
      ? "mergeAll requires registrations returned by Tag.handlers"
      : parts.find((part) => part?.invalid !== undefined)?.invalid,
  });
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

        yield* mutations[method]({
          ...input,
          payload,
          lifecycle: isAlarmDefinitionConfig(definition) ? definition.lifecycle : undefined,
        });
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
      deferWakes: alarms.deferWakes,
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
          [ManualTags]: new Set(
            Object.entries(definitions)
              .filter(
                ([, definition]) =>
                  isAlarmDefinitionConfig(definition) && definition.lifecycle === "manual",
              )
              .map(([tag]) => tag),
          ),
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

const hasSchedulerTables = Effect.fnUntraced(function* (state: DurableObjectState["Service"]) {
  return yield* Effect.gen(function* () {
    if (state.raw.storage.sql === undefined) return false;
    // Inspect without creating tables: raw-only SQLite and KV objects retain native ownership.
    const tables = yield* state.storage.sql.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      "effect_cf_scheduled_alarms",
    );

    return (yield* tables.toArray()).length > 0;
  }).pipe(
    Effect.catchIf(
      (error) =>
        error.cause instanceof Error &&
        (error.cause.message.startsWith("SQL is not enabled for this Durable Object class") ||
          error.cause.message.startsWith("This Durable Object is not backed by SQLite storage")),
      () => Effect.succeed(false),
    ),
  );
});

/** @internal Preserve custom dispatch while recovering retained alarms after deployments. */
export const dispatchRawAlarm = <Self, E, R>(
  rawAlarm: Effect.Effect<void, E, R>,
  registration?: AlarmRegistration<Self, R, E>,
): Effect.Effect<void, E | DurableObjectAlarmError, R | DurableObjectAlarm | DurableObjectState> =>
  Effect.gen(function* () {
    const parts = registration?.[RegistrationParts];

    if (parts !== undefined) return yield* runRegistrations(parts, rawAlarm).pipe(Effect.asVoid);
    const custom =
      registration === undefined ? rawAlarm : registration.run.pipe(Effect.andThen(rawAlarm));
    const state = yield* DurableObjectState;
    const hasScheduler = yield* hasSchedulerTables(state);

    if (!hasScheduler) return yield* custom;

    return yield* runRegistrations({ services: [], dispatchers: [] }, custom).pipe(Effect.asVoid);
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
          dispatchers: [
            {
              tags: Object.keys(definitions),
              automatic: Object.values(definitions).some(
                (entry) => !isAlarmDefinitionConfig(entry) || entry.lifecycle !== "manual",
              ),
              run: definition.handlers(handlers, options),
            },
          ],
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
      let wakesReady: Deferred.Deferred<void> | undefined;
      let pendingAlarm: Deferred.Deferred<void, unknown> | undefined;
      let dispatchActive = false;
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
        if (wakeDeferrals > 0 || dispatchActive) {
          const current = yield* state.storage.getAlarm();
          const now = yield* Clock.currentTimeMillis;

          if (deferredRecoveryAt <= now) {
            deferredRecoveryAt = now + deferredRecoveryDelay;
          }

          // Commit the guard before user work. Later transactions keep it even when
          // logical deadlines move earlier or every checkpoint is cancelled.
          if (current === null || current <= now || current > deferredRecoveryAt) {
            yield* writeNativeAlarm(deferredRecoveryAt);
          }

          return;
        }
        const cursor = yield* state.storage.sql.exec<NextAlarmRow>(
          `SELECT wake_at AS run_at FROM effect_cf_scheduled_alarms
           ORDER BY wake_at, storage_id LIMIT 1`,
        );
        const next = (yield* cursor.toArray())[0];

        yield* writeNativeAlarm(next?.run_at ?? null);
      });

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
        const lifecycle = yield* S.decodeUnknownEffect(AlarmLifecycleSchema)(
          input.lifecycle ?? "automatic",
        ).pipe(Effect.mapError((cause) => new InvalidAlarmRefError({ cause })));

        if (
          lifecycle === "manual" &&
          (input.repeatEvery !== undefined || input.progress !== undefined)
        ) {
          return yield* Effect.fail(
            new InvalidAlarmRefError({
              cause: new Error("Manual alarms own their repeats and progress budgets"),
            }),
          );
        }
        const repeatEveryMillis = yield* toRepeatEveryMillis(
          input.repeatEvery,
          configuration.minimumRepeatInterval,
        );
        const payload = yield* encodeStoredPayload(input.payload);
        const storageId = getScheduledEventId(ref);
        const existing = yield* readRow(storageId);
        const pass = yield* CurrentAlarmPass;
        const source =
          lifecycle === "automatic" && pass?.row.lifecycle === "automatic" ? pass.row : undefined;
        const progress = existing?.progress ?? source?.progress ?? -1;

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
        const scheduledRepeat =
          lifecycle === "manual"
            ? null
            : keepEarlier
              ? existing.repeat_every_ms
              : repeatEveryMillis;
        const nextProgress = lifecycle === "manual" ? -1 : Math.max(progress, input.progress ?? -1);

        yield* state.storage.sql.exec(
          `INSERT OR REPLACE INTO effect_cf_scheduled_alarms
            (storage_id, alarm_id, tag, lifecycle, run_at, repeat_every_ms, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          storageId,
          ref.id,
          ref.tag,
          lifecycle,
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
        const pass = yield* CurrentAlarmPass;

        if (pass !== undefined && !pass.active) {
          return yield* Effect.fail(
            new StorageOperationError({
              operation: "alarm.transaction",
              cause: new Error("Alarm handlers cannot mutate detached work after their pass ends"),
            }),
          );
        }
        const reports: string[] = [];
        const result = yield* state.storage.transaction(() =>
          Effect.withFiber((owner) => {
            let active = true;
            const requireActive = <A, E>(effect: Effect.Effect<A, E>) =>
              Effect.withFiber<A, E | StorageOperationError>((fiber) =>
                // A queued or suspended transaction can outlive the handler that admitted it.
                active && fiber === owner && (pass === undefined || pass.active)
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

      const deferWakes: AlarmScheduler["deferWakes"] = (body) =>
        Effect.acquireUseRelease(
          Effect.gen(function* () {
            const configuration = yield* getScheduleConfiguration(configurationDefaults);
            const now = yield* Clock.currentTimeMillis;

            if (wakeDeferrals === 0) {
              deferredRecoveryDelay = configuration.parkedRetryDelay;
              deferredRecoveryAt = now + deferredRecoveryDelay;
              wakesReady ??= Deferred.makeUnsafe<void>();
            }
            wakeDeferrals++;
          }),
          () => transaction(() => Effect.void).pipe(Effect.andThen(body)),
          () =>
            Effect.gen(function* () {
              wakeDeferrals--;
              if (wakeDeferrals === 0) {
                yield* transaction(() => Effect.void).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      if (wakeDeferrals === 0 && wakesReady !== undefined) {
                        Deferred.doneUnsafe(wakesReady, Effect.void);
                        wakesReady = undefined;
                      }
                    }),
                  ),
                );
              }
            }),
        );

      const awaitWakes: Effect.Effect<void> = Effect.suspend(() =>
        wakesReady === undefined
          ? Effect.void
          : Deferred.await(wakesReady).pipe(Effect.andThen(awaitWakes)),
      );
      const runAlarm: AlarmScheduler[typeof RunAlarm] = (event, native) =>
        Effect.flatMap(hasSchedulerTables(state), (managed) =>
          !managed
            ? native
              ? event(Effect.void)
              : Effect.void
            : Effect.uninterruptibleMask((restore) =>
                Effect.suspend(() => {
                  const pending = pendingAlarm;

                  if (pending !== undefined) {
                    // A native delivery consumed its timestamp. Restore recovery before joining.
                    return restore(
                      (native ? transaction(() => Effect.void) : Effect.void).pipe(
                        Effect.andThen(Deferred.await(pending)),
                      ),
                    );
                  }
                  const completed = Deferred.makeUnsafe<void, unknown>();
                  let dispatchStarted = false;

                  pendingAlarm = completed;

                  return restore(
                    Effect.gen(function* () {
                      // Native-first delivery can consume an inline region's guard before
                      // any prompt pass exists to join. Restore it while waiting for exit.
                      if (native && wakesReady !== undefined) yield* transaction(() => Effect.void);
                      yield* awaitWakes;
                      dispatchActive = true;
                      yield* event(
                        Effect.sync(() => {
                          dispatchStarted = true;
                        }),
                      );
                    }),
                  ).pipe(
                    Effect.onExit((exit) =>
                      Effect.gen(function* () {
                        // The event includes its scope finalizers. Late enrollments cannot be
                        // swallowed by a native delivery that joined after the final checkpoint.
                        // Acquisition failure never reached a dispatcher: keep a future guard
                        // instead of rearming untouched due rows into an immediate retry loop.
                        dispatchActive = Exit.isFailure(exit) && !dispatchStarted;
                        const reconciled = yield* transaction(() => Effect.void).pipe(Effect.exit);

                        dispatchActive = false;
                        pendingAlarm = undefined;
                        yield* Deferred.done(completed, Exit.asVoidAll([exit, reconciled]));
                        yield* reconciled;
                      }),
                    ),
                  );
                }),
              ),
        );

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
        const limit = yield* getProcessLimit(options);
        const initialDelay = yield* getFailureRetryDelay(options, configuration);
        const now = yield* Clock.currentTimeMillis;
        const rawDispatch = yield* CurrentRawDispatch;

        // A validated dispatcher owns its remaining batch, including newly enrolled work.
        if (rawDispatch !== undefined) rawDispatch.processed = true;

        const selection = yield* AlarmSelection;
        const tagFilter =
          selection === undefined
            ? ""
            : ` AND a.tag ${selection.exclude ? "NOT IN" : "IN"} (SELECT value FROM json_each(?))`;
        const tagBindings =
          selection === undefined ? [] : [S.encodeSync(StoredTags)([...selection.tags])];
        const select = Effect.fnUntraced(function* (lifecycle: AlarmLifecycle, batchLimit: number) {
          const cursor = yield* state.storage.sql.exec<AlarmRow>(
            `${alarmRowsSql} WHERE a.lifecycle = ? AND a.wake_at <= ?${tagFilter}
             ORDER BY a.wake_at ASC, a.storage_id ASC LIMIT ?`,
            lifecycle,
            now,
            ...tagBindings,
            batchLimit,
          );

          return yield* cursor.toArray();
        });
        // Manual recovery never consumes the raw/automatic dispatcher's batch allowance.
        const dueRows = yield* select("automatic", limit);
        const manualRows = yield* select("manual", DEFAULT_PROCESS_DUE_ALARMS_LIMIT);

        if (manualRows.length > 0) {
          yield* transaction(() =>
            Effect.gen(function* () {
              for (const row of manualRows) {
                // Keep the selected revision: a racing replacement must survive this guard.
                yield* state.storage.sql.exec(
                  `UPDATE effect_cf_scheduled_alarms SET run_at = ?, wake_at = ? WHERE ${sameRevisionSql}`,
                  now + configuration.parkedRetryDelay,
                  now + configuration.parkedRetryDelay,
                  row.storage_id,
                  row.storage_id,
                  row.revision,
                );
              }
            }),
          );
        }
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

        const handleRow = Effect.fnUntraced(function* (row: AlarmRow) {
          const current = yield* readRow(row.storage_id);

          if (current === undefined || current.revision !== row.revision) return;
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
          const manual = row.lifecycle === "manual";

          if (manual && !options?.[ManualTags]?.has(row.tag)) {
            return yield* Effect.fail(missingAlarm(row.tag));
          }
          const eventExit = yield* Effect.exit(toAlarmDue(row));

          if (Exit.isFailure(eventExit)) {
            if (manual) return yield* Effect.failCause(eventExit.cause);

            return yield* inPass(handleFailure(row, undefined, eventExit.cause));
          }
          const event = eventExit.value;
          const handleExit = yield* Effect.exit(inPass(Effect.suspend(() => handle(event))));

          if (Exit.isFailure(handleExit)) {
            if (manual) return yield* Effect.failCause(handleExit.cause);

            return yield* inPass(handleFailure(row, event, handleExit.cause));
          }
          if (!manual) yield* transaction(() => acknowledgeAlarm(row, configuration));
          handled.push(event);
        });
        const permits = (yield* ManualPermits) ?? (yield* Semaphore.make(4));
        const automatic = Effect.forEach(dueRows, handleRow, { discard: true }).pipe(Effect.exit);
        const exits = yield* manualRows.length === 0
          ? automatic.pipe(Effect.map((exit) => [exit]))
          : Effect.all(
              [
                automatic,
                Effect.forEach(
                  manualRows,
                  (row) => permits.withPermits(1)(handleRow(row)).pipe(Effect.exit),
                  { concurrency: 4 },
                ).pipe(Effect.flatMap(Exit.asVoidAll), Effect.exit),
              ],
              { concurrency: 2 },
            );

        yield* transaction(() => Effect.void);
        yield* Exit.asVoidAll(exits);

        return { failed, handled, parked };
      });

      return DurableObjectAlarm.of({
        [RunAlarm]: runAlarm,
        [DispatchAfterEvent]: Effect.map(
          ScheduleConfiguration,
          (configuration) =>
            (configuration.dispatchAfterEvent ?? configurationDefaults.dispatchAfterEvent) === true,
        ),
        [HasDueAlarms]: Effect.gen(function* () {
          yield* ensureTable(state);
          const now = yield* Clock.currentTimeMillis;
          const cursor = yield* state.storage.sql.exec(
            "SELECT 1 FROM effect_cf_scheduled_alarms WHERE wake_at <= ? LIMIT 1",
            now,
          );

          return (yield* cursor.toArray()).length > 0;
        }),
        deferWakes,
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
