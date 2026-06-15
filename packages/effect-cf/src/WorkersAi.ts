import { Context, Data, Effect, type Layer } from "effect";
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

const expectedWorkersAiBinding = "Workers AI binding with run(), gateway(), and models()";

/** Error raised when a Workers AI operation fails. */
export class WorkersAiOperationError extends Data.TaggedError("WorkersAiOperationError")<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
}> {}

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
  | Record<string, unknown>;

export interface WorkersAiEmbeddingResponse {
  readonly data: ReadonlyArray<ReadonlyArray<number>>;
  readonly shape: ReadonlyArray<number>;
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
    <Input extends Record<string, unknown>, Output = Record<string, unknown>>(
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
  readonly unsafeRaw: Effect.Effect<WorkersAiBinding<ModelList>>;
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

const hasFunction = (value: object, key: string): boolean =>
  typeof Reflect.get(value, key) === "function";

export const isWorkersAiBinding = (value: unknown): value is WorkersAiBinding =>
  typeof value === "object" &&
  value !== null &&
  hasFunction(value, "run") &&
  hasFunction(value, "gateway") &&
  hasFunction(value, "models");

export const embeddingResponse = (value: {
  readonly data?: ReadonlyArray<ReadonlyArray<number>>;
  readonly shape?: ReadonlyArray<number>;
}): WorkersAiEmbeddingResponse => ({
  data: value.data ?? [],
  shape: value.shape ?? [],
});

export const makeClient =
  <ModelList extends AiModelListType = AiModels>(definition: WorkersAiDefinition) =>
  (ai: WorkersAiBinding<ModelList>): WorkersAiClient<ModelList> => {
    const run = ((model: string, input: Record<string, unknown>, options?: WorkersAiOptions) =>
      tryWorkersAiPromise(definition.binding, "run", () =>
        ai.run(model as string & {}, input, options),
      )) as WorkersAiClient<ModelList>["run"];

    return {
      definition,
      aiGatewayLogId: tryWorkersAiSync(
        definition.binding,
        "aiGatewayLogId",
        () => ai.aiGatewayLogId,
      ),
      run,
      runEmbedding: (model, input, options) =>
        run(model, input, options).pipe(
          Effect.map((response) =>
            embeddingResponse(
              response as {
                readonly data?: ReadonlyArray<ReadonlyArray<number>>;
                readonly shape?: ReadonlyArray<number>;
              },
            ),
          ),
        ),
      models: (params) =>
        tryWorkersAiPromise(definition.binding, "models", () => ai.models(params)),
      gateway: (gatewayId) =>
        tryWorkersAiSync(definition.binding, "gateway", () => ai.gateway(gatewayId)),
      unsafeRaw: Effect.succeed(ai),
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

    return Object.assign(tag, {
      id,
      layer: makeLayer,
    }) as TagClass<Self, Id, ModelList>;
  };
