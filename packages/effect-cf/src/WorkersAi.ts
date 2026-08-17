import { Context, Data, Effect, Option, Predicate, Schema as S, type Layer } from "effect";
import type {
  Ai as CloudflareAi,
  AiAsyncBatchResponse,
  AiGateway as CloudflareAiGateway,
  AiModelListType,
  AiModels,
  AiModelsSearchObject,
  AiModelsSearchParams,
  AiOptions,
  AiTextEmbeddingsInput,
  Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Input,
} from "@cloudflare/workers-types";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";
import * as ErrorMessage from "./internal/ErrorMessage";

const expectedWorkersAiBinding = "Workers AI binding with run(), gateway(), and models()";

/** Error raised when a Workers AI operation fails. */
export class WorkersAiOperationError extends Data.TaggedError("WorkersAiOperationError")<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Workers AI ${this.operation} failed for binding "${this.binding}": ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

/** Typed Workers AI binding definition. */
export interface WorkersAiDefinition {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
}

export type WorkersAiBinding<ModelList extends AiModelListType = AiModels> =
  CloudflareAi<ModelList>;
export type WorkersAiOptions = AiOptions;
export type WorkersAiModelsSearchParams = AiModelsSearchParams;
export type WorkersAiModelsSearchObject = AiModelsSearchObject;
export type WorkersAiAsyncBatchResponse = AiAsyncBatchResponse;
export type WorkersAiEmbeddingInput =
  | AiTextEmbeddingsInput
  | Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Input
  | Parameters<WorkersAiBinding["run"]>[1];

const embeddingDimensionsKey = "shape";

export interface WorkersAiEmbeddingResponse {
  readonly data: ReadonlyArray<ReadonlyArray<number>>;
  readonly [embeddingDimensionsKey]: ReadonlyArray<number>;
}

export interface WorkersAiClient<ModelList extends AiModelListType = AiModels> {
  readonly aiGatewayLogId: Effect.Effect<string | null, WorkersAiOperationError>;
  readonly run: {
    <Name extends keyof ModelList>(
      model: Name,
      input: {
        readonly requests: ReadonlyArray<ModelList[Name]["inputs"]>;
      },
      options: WorkersAiOptions & {
        readonly queueRequest: true;
      },
    ): Effect.Effect<WorkersAiAsyncBatchResponse, WorkersAiOperationError>;
    <Name extends keyof ModelList>(
      model: Name,
      input: ModelList[Name]["inputs"],
      options: WorkersAiOptions & {
        readonly returnRawResponse: true;
      },
    ): Effect.Effect<Response, WorkersAiOperationError>;
    <Name extends keyof ModelList>(
      model: Name,
      input: ModelList[Name]["inputs"],
      options: WorkersAiOptions & {
        readonly websocket: true;
      },
    ): Effect.Effect<Response, WorkersAiOperationError>;
    <Name extends keyof ModelList>(
      model: Name,
      input: ModelList[Name]["inputs"] & {
        readonly stream: true;
      },
      options?: WorkersAiOptions,
    ): Effect.Effect<ReadableStream, WorkersAiOperationError>;
    <Name extends keyof ModelList>(
      model: Name,
      input: ModelList[Name]["inputs"],
      options?: WorkersAiOptions,
    ): Effect.Effect<ModelList[Name]["postProcessedOutputs"], WorkersAiOperationError>;
    <
      Input extends Parameters<WorkersAiBinding["run"]>[1],
      Output = Awaited<ReturnType<WorkersAiBinding["run"]>>,
    >(
      model: string,
      input: Input,
      options?: WorkersAiOptions,
    ): Effect.Effect<Output, WorkersAiOperationError>;
  };
  readonly runEmbedding: <Input extends WorkersAiEmbeddingInput>(
    model: string,
    input: Input,
    options?: WorkersAiOptions,
  ) => Effect.Effect<WorkersAiEmbeddingResponse, WorkersAiOperationError>;
  readonly models: (
    params?: WorkersAiModelsSearchParams,
  ) => Effect.Effect<ReadonlyArray<WorkersAiModelsSearchObject>, WorkersAiOperationError>;
  readonly gateway: (
    gatewayId: string,
  ) => Effect.Effect<CloudflareAiGateway, WorkersAiOperationError>;
  readonly rawUnsafe: Effect.Effect<WorkersAiBinding<ModelList>>;
  readonly definition: WorkersAiDefinition;
}

declare const WorkersAiServiceTypeId: unique symbol;

/** Nominal service marker for Workers AI services created with {@link make}. */
export interface WorkersAiService<Id extends string> {
  readonly [WorkersAiServiceTypeId]: {
    readonly id: Id;
  };
}

export type LayerOptions = {
  readonly binding: string;
};

export interface TagClass<
  Self,
  Id extends string,
  ModelList extends AiModelListType = AiModels,
> extends Context.ServiceClass<Self, Id, WorkersAiClient<ModelList>> {
  readonly id: Id;
  readonly layer: (
    options: LayerOptions,
  ) => Layer.Layer<
    Self,
    Binding.BindingNotFoundError | Binding.BindingValidationError,
    WorkerEnvironment
  >;
}

const workersAiError = (binding: string, operation: string, cause: unknown) =>
  new WorkersAiOperationError({ binding, operation, cause });

const tryWorkersAiPromise = <A>(
  binding: string,
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, WorkersAiOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => workersAiError(binding, operation, cause),
  });

const tryWorkersAiSync = <A>(
  binding: string,
  operation: string,
  evaluate: () => A,
): Effect.Effect<A, WorkersAiOperationError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) => workersAiError(binding, operation, cause),
  });

type WorkersAiBindingValue = S.Schema.Type<typeof S.Unknown>;

const WorkersAiBindingSchema = S.declare(
  (value: WorkersAiBindingValue): value is WorkersAiBinding =>
    Predicate.hasProperty(value, "run") &&
    Predicate.isFunction(value.run) &&
    Predicate.hasProperty(value, "gateway") &&
    Predicate.isFunction(value.gateway) &&
    Predicate.hasProperty(value, "models") &&
    Predicate.isFunction(value.models),
);
const decodeWorkersAiBinding = S.decodeUnknownOption(WorkersAiBindingSchema);

export const isWorkersAiBinding = (value: WorkersAiBindingValue): value is WorkersAiBinding =>
  Option.isSome(decodeWorkersAiBinding(value));

export const embeddingResponse = (value: {
  readonly data?: ReadonlyArray<ReadonlyArray<number>>;
  readonly [embeddingDimensionsKey]?: ReadonlyArray<number>;
}): WorkersAiEmbeddingResponse => ({
  data: value.data ?? [],
  [embeddingDimensionsKey]: value[embeddingDimensionsKey] ?? [],
});

const decodeEmbeddingResponse = S.decodeUnknownOption(
  S.Struct({
    data: S.optional(S.Array(S.Array(S.Number))),
    [embeddingDimensionsKey]: S.optional(S.Array(S.Number)),
  }),
);

export const makeClient =
  <ModelList extends AiModelListType = AiModels>(definition: WorkersAiDefinition) =>
  (ai: WorkersAiBinding<ModelList>): WorkersAiClient<ModelList> => {
    const run = Effect.fn("WorkersAi.run")(
      (model: string, input: Parameters<WorkersAiBinding["run"]>[1], options?: WorkersAiOptions) =>
        tryWorkersAiPromise(definition.binding, "run", () => {
          // SAFETY: a non-literal string intentionally selects Cloudflare's unknown-model fallback overload.
          return ai.run(model as string & {}, input, options);
        }),
    );

    return {
      definition,
      aiGatewayLogId: tryWorkersAiSync(
        definition.binding,
        "aiGatewayLogId",
        () => ai.aiGatewayLogId,
      ),
      run,
      runEmbedding: Effect.fn("WorkersAi.runEmbedding")(
        (model: string, input: WorkersAiEmbeddingInput, options?: WorkersAiOptions) => {
          // SAFETY: every WorkersAiEmbeddingInput variant is a string-keyed Workers AI payload.
          const modelInput = input as Parameters<WorkersAiBinding["run"]>[1];

          return run(model, modelInput, options).pipe(
            Effect.map((response) =>
              Option.match(decodeEmbeddingResponse(response), {
                onNone: () => embeddingResponse({}),
                onSome: embeddingResponse,
              }),
            ),
          );
        },
      ),
      models: Effect.fn("WorkersAi.models")((params?: WorkersAiModelsSearchParams) =>
        tryWorkersAiPromise(definition.binding, "models", () => ai.models(params)),
      ),
      gateway: (gatewayId) =>
        tryWorkersAiSync(definition.binding, "gateway", () => ai.gateway(gatewayId)),
      rawUnsafe: Effect.succeed(ai),
    };
  };

export const layer = <Self, ModelList extends AiModelListType = AiModels>(
  tag: Context.Service<Self, WorkersAiClient<ModelList>>,
  definition: WorkersAiDefinition,
) =>
  Binding.layer(
    tag,
    definition.binding,
    (value): value is WorkersAiBinding<ModelList> => isWorkersAiBinding(value),
    makeClient<ModelList>(definition),
    {
      expected: expectedWorkersAiBinding,
    },
  );

export const make = <Id extends string>(id: Id) => Tag<WorkersAiService<Id>>()<Id, AiModels>(id);

export const Tag =
  <Self>() =>
  <Id extends string, ModelList extends AiModelListType = AiModels>(id: Id) => {
    const tag = Context.Service<Self, WorkersAiClient<ModelList>>()(id);

    const makeLayer = (definition: LayerOptions) => layer(tag, definition);

    // SAFETY: Object.assign attaches exactly the static id/layer members declared by TagClass.
    return Object.assign(tag, {
      id,
      layer: makeLayer,
    }) as TagClass<Self, Id, ModelList>;
  };
