import type {
  InstanceStatus as CloudflareInstanceStatus,
  Workflow as CloudflareWorkflow,
  WorkflowInstance as CloudflareWorkflowInstance,
  WorkflowInstanceCreateOptions as CloudflareWorkflowInstanceCreateOptions,
  WorkflowInstanceLocationHint as CloudflareWorkflowInstanceLocationHint,
  WorkflowInstanceRestartOptions as CloudflareWorkflowInstanceRestartOptions,
  WorkflowInstanceTerminateOptions as CloudflareWorkflowInstanceTerminateOptions,
} from "@cloudflare/workers-types";
import { type Context, Data, Effect, Option, Predicate, Schema as S } from "effect";

import * as Binding from "./Binding";
import type * as RpcDefinition from "./RpcDefinition";
import * as ErrorMessage from "./internal/ErrorMessage";

const expectedWorkflow = "Workflow binding with create(), createBatch(), and get()";

export type WorkflowInstanceCreateOptions<Payload> = Omit<
  CloudflareWorkflowInstanceCreateOptions<Payload>,
  "params"
>;

export type WorkflowInstanceCreateBatchOptions<Payload, EncodedPayload = unknown> = ReadonlyArray<
  { readonly payload: Payload } & WorkflowInstanceCreateOptions<EncodedPayload>
>;

export type WorkflowInstanceRestartOptions = CloudflareWorkflowInstanceRestartOptions;
export type WorkflowInstanceTerminateOptions = CloudflareWorkflowInstanceTerminateOptions;
export type WorkflowInstanceLocationHint = CloudflareWorkflowInstanceLocationHint;

export type WorkflowInstanceStatusName = CloudflareInstanceStatus["status"];

export interface WorkflowInstanceStatus<Result> {
  readonly status: WorkflowInstanceStatusName;
  readonly output: Option.Option<Result>;
  readonly error: Option.Option<{
    readonly name: string;
    readonly message: string;
  }>;
}

export interface WorkflowInstance<Result> {
  readonly raw: CloudflareWorkflowInstance;
  readonly id: string;
  readonly pause: Effect.Effect<void, WorkflowOperationError>;
  readonly resume: Effect.Effect<void, WorkflowOperationError>;
  readonly terminate: (
    options?: WorkflowInstanceTerminateOptions,
  ) => Effect.Effect<void, WorkflowOperationError>;
  readonly restart: (
    options?: WorkflowInstanceRestartOptions,
  ) => Effect.Effect<void, WorkflowOperationError>;
  readonly delete: Effect.Effect<void, WorkflowOperationError>;
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

export interface WorkflowBindingClient<
  Payload extends RpcDefinition.ServiceFreeSchema,
  Result extends RpcDefinition.ServiceFreeSchema,
> {
  readonly create: (
    payload: S.Schema.Type<Payload>,
    options?: WorkflowInstanceCreateOptions<S.Codec.Encoded<Payload>>,
  ) => Effect.Effect<
    WorkflowInstance<S.Schema.Type<Result>>,
    WorkflowOperationError | S.SchemaError
  >;
  readonly createBatch: (
    batch: WorkflowInstanceCreateBatchOptions<S.Schema.Type<Payload>, S.Codec.Encoded<Payload>>,
  ) => Effect.Effect<
    ReadonlyArray<WorkflowInstance<S.Schema.Type<Result>>>,
    WorkflowOperationError | S.SchemaError
  >;
  readonly get: (
    instanceId: string,
  ) => Effect.Effect<WorkflowInstance<S.Schema.Type<Result>>, WorkflowOperationError>;
  readonly rawUnsafe: Effect.Effect<CloudflareWorkflow<S.Codec.Encoded<Payload>>>;
}

export class WorkflowOperationError extends Data.TaggedError("WorkflowOperationError")<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Workflow ${this.operation} failed for binding "${this.binding}": ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

export class WorkflowResultDecodeError extends Data.TaggedError("WorkflowResultDecodeError")<{
  readonly binding: string;
  readonly instanceId: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Workflow result decode failed for binding "${this.binding}" instance "${this.instanceId}": ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

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

type WorkflowBindingValue = S.Schema.Type<typeof S.Unknown>;

const WorkflowBindingSchema = S.declare(
  (value: WorkflowBindingValue): value is CloudflareWorkflow<WorkflowBindingValue> =>
    Predicate.hasProperty(value, "create") &&
    Predicate.isFunction(value.create) &&
    Predicate.hasProperty(value, "createBatch") &&
    Predicate.isFunction(value.createBatch) &&
    Predicate.hasProperty(value, "get") &&
    Predicate.isFunction(value.get),
);
const decodeWorkflowBinding = S.decodeUnknownOption(WorkflowBindingSchema);

export const isWorkflow = <Payload>(
  value: WorkflowBindingValue,
): value is CloudflareWorkflow<Payload> => Option.isSome(decodeWorkflowBinding(value));

export const makeClient = <
  Payload extends RpcDefinition.ServiceFreeSchema,
  Result extends RpcDefinition.ServiceFreeSchema,
>(
  definition: WorkflowBindingDefinition<Payload, Result>,
): ((
  workflow: CloudflareWorkflow<S.Codec.Encoded<Payload>>,
) => WorkflowBindingClient<Payload, Result>) => {
  type PayloadValue = S.Schema.Type<Payload>;
  type EncodedPayload = S.Codec.Encoded<Payload>;
  type ResultValue = S.Schema.Type<Result>;

  const encodePayload = S.encodeEffect(definition.payload);
  const decodeResult = S.decodeUnknownEffect(definition.result);

  const wrapInstance = (raw: CloudflareWorkflowInstance): WorkflowInstance<ResultValue> => {
    const operation = <A>(name: string, evaluate: () => Promise<A>) =>
      tryWorkflowPromise(definition.binding, name, evaluate);

    return {
      raw,
      id: raw.id,
      pause: operation("pause", () => raw.pause()),
      resume: operation("resume", () => raw.resume()),
      terminate: (options) => operation("terminate", () => raw.terminate(options)),
      restart: (options) => operation("restart", () => raw.restart(options)),
      delete: operation("delete", () => raw.delete()),
      status: operation("status", () => raw.status()).pipe(
        Effect.flatMap((status) =>
          Effect.gen(function* () {
            // Cloudflare reports `output: null` as a no-output sentinel while an
            // instance is not complete; only a complete instance may carry a real
            // null result (e.g. Schema.Null).
            const output =
              status.output === undefined ||
              (status.output === null && status.status !== "complete")
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
              error:
                status.error === null || status.error === undefined
                  ? Option.none()
                  : Option.some(status.error),
            };
          }),
        ),
      ),
      sendEvent: (event) => operation("sendEvent", () => raw.sendEvent(event)),
    };
  };

  return (workflow) => ({
    create: Effect.fn("WorkflowBinding.create", {
      attributes: { binding: definition.binding, operation: "create" },
    })(function* (payload: PayloadValue, options?: WorkflowInstanceCreateOptions<EncodedPayload>) {
      const encoded = yield* encodePayload(payload);
      const raw = yield* tryWorkflowPromise(definition.binding, "create", () =>
        workflow.create({ ...options, params: encoded }),
      );

      return wrapInstance(raw);
    }),
    createBatch: Effect.fn("WorkflowBinding.createBatch", {
      attributes: { binding: definition.binding, operation: "createBatch" },
    })(function* (batch: WorkflowInstanceCreateBatchOptions<PayloadValue, EncodedPayload>) {
      const encodedBatch: Array<CloudflareWorkflowInstanceCreateOptions<EncodedPayload>> = [];

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
    }),
    get: (instanceId) =>
      tryWorkflowPromise(definition.binding, "get", () => workflow.get(instanceId)).pipe(
        Effect.map(wrapInstance),
      ),
    rawUnsafe: Effect.succeed(workflow),
  });
};

export const layer = <
  Self,
  Payload extends RpcDefinition.ServiceFreeSchema,
  Result extends RpcDefinition.ServiceFreeSchema,
>(
  tag: Context.Service<Self, WorkflowBindingClient<Payload, Result>>,
  definition: WorkflowBindingDefinition<Payload, Result>,
) =>
  Binding.layer(
    tag,
    definition.binding,
    (value): value is CloudflareWorkflow<S.Codec.Encoded<Payload>> =>
      isWorkflow<S.Codec.Encoded<Payload>>(value),
    makeClient(definition),
    { expected: expectedWorkflow },
  );
