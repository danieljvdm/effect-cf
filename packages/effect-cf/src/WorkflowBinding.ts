import { Data, Effect, Option, Schema as S } from "effect";

import * as Binding from "./Binding";
import type * as RpcDefinition from "./RpcDefinition";

const TypeId = "effect-cf/WorkflowBinding" as const;

export type WorkflowInstanceCreateOptions<Payload> = Omit<
  globalThis.WorkflowInstanceCreateOptions<Payload>,
  "params"
>;

export type WorkflowInstanceCreateBatchOptions<Payload, EncodedPayload = unknown> = ReadonlyArray<
  { readonly payload: Payload } & WorkflowInstanceCreateOptions<EncodedPayload>
>;

export interface WorkflowInstanceRestartOptions {
  readonly from?: {
    readonly name?: string;
    readonly count?: number;
    readonly type?: string;
  };
}

export type WorkflowInstanceStatusName = globalThis.InstanceStatus["status"];

export interface WorkflowInstanceStatus<Result> {
  readonly status: WorkflowInstanceStatusName;
  readonly output: Option.Option<Result>;
  readonly error: Option.Option<{
    readonly name: string;
    readonly message: string;
  }>;
}

export interface WorkflowInstance<Result> {
  readonly raw: globalThis.WorkflowInstance;
  readonly id: string;
  readonly pause: Effect.Effect<void, WorkflowOperationError>;
  readonly resume: Effect.Effect<void, WorkflowOperationError>;
  readonly terminate: Effect.Effect<void, WorkflowOperationError>;
  readonly restart: (
    options?: WorkflowInstanceRestartOptions,
  ) => Effect.Effect<void, WorkflowOperationError>;
  readonly status: Effect.Effect<
    WorkflowInstanceStatus<Result>,
    WorkflowOperationError | WorkflowResultDecodeError
  >;
  readonly sendEvent: (event: WorkflowInstanceEvent) => Effect.Effect<void, WorkflowOperationError>;
}

export interface WorkflowInstanceEvent {
  readonly type: string;
  readonly payload: unknown;
}

export interface WorkflowBindingDefinition<
  Payload extends RpcDefinition.ServiceFreeSchema,
  Result extends RpcDefinition.ServiceFreeSchema,
> {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
  /** Codec used to encode payloads passed to `Workflow.create`. */
  readonly payload: Payload;
  /** Codec used to decode completed workflow status output. */
  readonly result: Result;
}

declare const WorkflowServiceTypeId: unique symbol;

export interface WorkflowService<
  Id extends string,
  Payload extends RpcDefinition.ServiceFreeSchema,
  Result extends RpcDefinition.ServiceFreeSchema,
> {
  readonly [WorkflowServiceTypeId]: {
    readonly id: Id;
    readonly payload: S.Schema.Type<Payload>;
    readonly encodedPayload: S.Codec.Encoded<Payload>;
    readonly result: S.Schema.Type<Result>;
    readonly encodedResult: S.Codec.Encoded<Result>;
  };
}

export class WorkflowOperationError extends Data.TaggedError("WorkflowOperationError")<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class WorkflowResultDecodeError extends Data.TaggedError("WorkflowResultDecodeError")<{
  readonly binding: string;
  readonly instanceId: string;
  readonly cause: unknown;
}> {}

const workflowError = (binding: string, operation: string, cause: unknown) =>
  new WorkflowOperationError({ binding, operation, cause });

const tryWorkflowPromise = <A>(
  binding: string,
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, WorkflowOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => workflowError(binding, operation, cause),
  });

const isWorkflow = <Payload>(value: unknown): value is globalThis.Workflow<Payload> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const resource = value as Record<string, unknown>;

  return (
    typeof resource.create === "function" &&
    typeof resource.createBatch === "function" &&
    typeof resource.get === "function"
  );
};

export const make = <
  Id extends string,
  Payload extends RpcDefinition.ServiceFreeSchema,
  Result extends RpcDefinition.ServiceFreeSchema,
>(
  id: Id,
  definition: WorkflowBindingDefinition<Payload, Result>,
) => Service<WorkflowService<Id, Payload, Result>>()<Id, Payload, Result>(id, definition);

export const Service =
  <Self>() =>
  <
    Id extends string,
    Payload extends RpcDefinition.ServiceFreeSchema,
    Result extends RpcDefinition.ServiceFreeSchema,
  >(
    id: Id,
    definition: WorkflowBindingDefinition<Payload, Result>,
  ) => {
    type PayloadValue = S.Schema.Type<Payload>;
    type EncodedPayload = S.Codec.Encoded<Payload>;
    type ResultValue = S.Schema.Type<Result>;

    const tag = Binding.Service<Self>()(
      id,
      definition.binding,
      (value): value is globalThis.Workflow<EncodedPayload> => isWorkflow<EncodedPayload>(value),
    );

    const encodePayload = S.encodeEffect(definition.payload);
    const decodeResult = S.decodeUnknownEffect(definition.result);

    const wrapInstance = (raw: globalThis.WorkflowInstance): WorkflowInstance<ResultValue> => {
      const operation = <A>(name: string, evaluate: () => Promise<A>) =>
        tryWorkflowPromise(definition.binding, name, evaluate);

      return {
        raw,
        id: raw.id,
        pause: operation("pause", () => raw.pause()),
        resume: operation("resume", () => raw.resume()),
        terminate: operation("terminate", () => raw.terminate()),
        restart: (options) =>
          operation("restart", () =>
            (raw as { restart(options?: WorkflowInstanceRestartOptions): Promise<void> }).restart(
              options,
            ),
          ),
        status: operation("status", () => raw.status()).pipe(
          Effect.flatMap((status) =>
            Effect.gen(function* () {
              const output =
                status.output === undefined
                  ? Option.none<ResultValue>()
                  : Option.some(
                      yield* decodeResult(status.output).pipe(
                        Effect.mapError(
                          (cause) =>
                            new WorkflowResultDecodeError({
                              binding: definition.binding,
                              instanceId: raw.id,
                              cause,
                            }),
                        ),
                      ),
                    );

              return {
                status: status.status,
                output,
                error: status.error === undefined ? Option.none() : Option.some(status.error),
              };
            }),
          ),
        ),
        sendEvent: (event) => operation("sendEvent", () => raw.sendEvent(event)),
      };
    };

    const create = Effect.fnUntraced(function* (
      payload: PayloadValue,
      options?: WorkflowInstanceCreateOptions<EncodedPayload>,
    ) {
      const workflow = yield* tag;
      const encoded = yield* encodePayload(payload);
      const raw = yield* tryWorkflowPromise(definition.binding, "create", () =>
        workflow.create({ ...options, params: encoded }),
      );

      return wrapInstance(raw);
    });

    const createBatch = Effect.fnUntraced(function* (
      batch: WorkflowInstanceCreateBatchOptions<PayloadValue, EncodedPayload>,
    ) {
      const workflow = yield* tag;
      const encodedBatch: Array<globalThis.WorkflowInstanceCreateOptions<EncodedPayload>> = [];

      for (const item of batch) {
        const { payload, ...options } = item;

        encodedBatch.push({
          ...options,
          params: yield* encodePayload(payload),
        });
      }

      const rawInstances = yield* tryWorkflowPromise(definition.binding, "createBatch", () =>
        workflow.createBatch(encodedBatch),
      );

      return rawInstances.map(wrapInstance);
    });

    const get = Effect.fnUntraced(function* (instanceId: string) {
      const workflow = yield* tag;
      const raw = yield* tryWorkflowPromise(definition.binding, "get", () =>
        workflow.get(instanceId),
      );

      return wrapInstance(raw);
    });

    return Object.assign(tag, {
      [TypeId]: TypeId,
      binding: definition.binding,
      create,
      createBatch,
      get,
    });
  };
