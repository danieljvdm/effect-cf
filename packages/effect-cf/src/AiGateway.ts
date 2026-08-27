import { Context, Data, Effect, type Layer, Schema as S } from "effect";
import type { AiGateway as CloudflareAiGateway } from "@cloudflare/workers-types";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";
import { isWorkersAiBinding, type WorkersAiBinding } from "./WorkersAi";
import * as ErrorMessage from "./internal/ErrorMessage";

const expectedAiGatewayBinding = "Workers AI binding with gateway()";

export class AiGatewayOperationError extends Data.TaggedError("AiGatewayOperationError")<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `AI Gateway ${this.operation} failed for binding "${this.binding}": ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

export interface AiGatewayDefinition {
  readonly binding: string;
  readonly gatewayId: string;
  readonly accountId?: string;
}

export type AiGatewayBinding = CloudflareAiGateway;
type AiGatewayRunData = Parameters<AiGatewayBinding["run"]>[0];
export type AiGatewayPatchLog = Parameters<AiGatewayBinding["patchLog"]>[1];
export type AiGatewayLog = Awaited<ReturnType<AiGatewayBinding["getLog"]>>;
export type AiGatewayProvider = NonNullable<Parameters<AiGatewayBinding["getUrl"]>[0]>;
export type AiGatewayUniversalRequest = Exclude<AiGatewayRunData, ReadonlyArray<unknown>>;
export type AiGatewayHeaders = NonNullable<AiGatewayUniversalRequest["headers"]>;
export type AiGatewayRunOptions = Parameters<CloudflareAiGateway["run"]>[1];
type AiGatewayBindingCandidate = Parameters<typeof isWorkersAiBinding>[0];

const AiGatewayMetadata = S.Record(S.String, S.Union([S.String, S.Number, S.Boolean, S.Null]));
const AiGatewayHttpMetadata = S.Union([AiGatewayMetadata, S.fromJsonString(AiGatewayMetadata)]);
const AiGatewayLogResponse = S.Struct({
  success: S.Literal(true),
  result: S.Struct({
    id: S.String,
    provider: S.String,
    model: S.String,
    model_type: S.optional(S.String),
    path: S.String,
    duration: S.Number,
    request_type: S.optional(S.String),
    request_content_type: S.optional(S.String),
    status_code: S.Number,
    response_content_type: S.optional(S.String),
    success: S.Boolean,
    cached: S.Boolean,
    tokens_in: S.optional(S.Number),
    tokens_out: S.optional(S.Number),
    metadata: S.optional(AiGatewayHttpMetadata),
    step: S.optional(S.Number),
    cost: S.optional(S.Number),
    custom_cost: S.optional(S.Boolean),
    request_size: S.Number,
    request_head: S.optional(S.String),
    request_head_complete: S.Boolean,
    response_size: S.Number,
    response_head: S.optional(S.String),
    response_head_complete: S.Boolean,
    created_at: S.DateFromString,
  }),
});
const AiGatewayPatchLogResponse = S.Struct({
  success: S.Literal(true),
  result: S.Unknown,
});
const decodeAiGatewayLogResponse = S.decodeUnknownPromise(AiGatewayLogResponse);
const decodeAiGatewayPatchLogResponse = S.decodeUnknownPromise(AiGatewayPatchLogResponse);

export interface AiGatewayFetchOptions {
  readonly provider?: AiGatewayProvider;
  readonly path?: string;
  readonly init?: RequestInit;
}

export interface AiGatewayClient {
  readonly run: (
    data: AiGatewayUniversalRequest | ReadonlyArray<AiGatewayUniversalRequest>,
    options?: AiGatewayRunOptions,
  ) => Effect.Effect<Response, AiGatewayOperationError>;
  readonly getUrl: (provider?: AiGatewayProvider) => Effect.Effect<string, AiGatewayOperationError>;
  readonly fetch: (
    options: AiGatewayFetchOptions,
  ) => Effect.Effect<Response, AiGatewayOperationError>;
  readonly patchLog: (
    logId: string,
    data: AiGatewayPatchLog,
  ) => Effect.Effect<void, AiGatewayOperationError>;
  readonly getLog: (logId: string) => Effect.Effect<AiGatewayLog, AiGatewayOperationError>;
  readonly rawUnsafe: Effect.Effect<AiGatewayBinding, AiGatewayOperationError>;
  readonly definition: AiGatewayDefinition;
}

declare const AiGatewayServiceTypeId: unique symbol;

export interface AiGatewayService<Id extends string> {
  readonly [AiGatewayServiceTypeId]: {
    readonly id: Id;
  };
}

export type LayerOptions = {
  readonly binding: string;
  readonly gatewayId: string;
  readonly accountId?: string;
};

export interface TagClass<Self, Id extends string> extends Context.ServiceClass<
  Self,
  Id,
  AiGatewayClient
> {
  readonly id: Id;
  readonly layer: (
    options: LayerOptions,
  ) => Layer.Layer<
    Self,
    Binding.BindingNotFoundError | Binding.BindingValidationError | AiGatewayOperationError,
    WorkerEnvironment
  >;
}

const aiGatewayError = (binding: string, operation: string, cause: unknown) =>
  new AiGatewayOperationError({ binding, operation, cause });

const tryAiGatewayPromise = <A>(
  binding: string,
  operation: string,
  evaluate: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, AiGatewayOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => aiGatewayError(binding, operation, cause),
  });

const mergeAbortSignals = (
  userSignal: AbortSignal | null | undefined,
  signal: AbortSignal,
): AbortSignal =>
  userSignal === null || userSignal === undefined ? signal : AbortSignal.any([userSignal, signal]);

const tryAiGatewaySync = <A>(
  binding: string,
  operation: string,
  evaluate: () => A,
): Effect.Effect<A, AiGatewayOperationError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) => aiGatewayError(binding, operation, cause),
  });

const providerUrl = (baseUrl: string, path = "") => {
  const url = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const normalizedPath = path.replace(/^\/+/, "");

  return normalizedPath === "" ? url : new URL(normalizedPath, url);
};

const gatewayUrl = (definition: { readonly accountId: string; readonly gatewayId: string }) =>
  `https://gateway.ai.cloudflare.com/v1/${definition.accountId}/${definition.gatewayId}/`;

const ensureSuccessfulResponse = (response: Response): void => {
  if (!response.ok) {
    throw new Error(`AI Gateway HTTP request failed with status ${response.status}`);
  }
};

export const isAiGatewayBinding = (value: AiGatewayBindingCandidate): value is WorkersAiBinding =>
  isWorkersAiBinding(value);

export const makeClient = (definition: AiGatewayDefinition, gateway: AiGatewayBinding) =>
  ({
    definition,
    run: Effect.fn("AiGateway.run")(
      (
        data: AiGatewayUniversalRequest | ReadonlyArray<AiGatewayUniversalRequest>,
        options?: AiGatewayRunOptions,
      ) =>
        tryAiGatewayPromise(definition.binding, "run", () =>
          gateway.run(
            // SAFETY: spreading the readonly batch produces the mutable array accepted by the binding.
            (Array.isArray(data) ? [...data] : data) as
              | AiGatewayUniversalRequest
              | Array<AiGatewayUniversalRequest>,
            options,
          ),
        ),
    ),
    getUrl: Effect.fn("AiGateway.getUrl")((provider?: AiGatewayProvider) =>
      tryAiGatewayPromise(definition.binding, "getUrl", () => gateway.getUrl(provider)),
    ),
    fetch: Effect.fn("AiGateway.fetch")(function* (options: AiGatewayFetchOptions) {
      const baseUrl = yield* tryAiGatewayPromise(definition.binding, "getUrl", () =>
        gateway.getUrl(options.provider),
      );

      return yield* tryAiGatewayPromise(definition.binding, "fetch", (signal) =>
        fetch(providerUrl(baseUrl, options.path).href, {
          ...options.init,
          signal: mergeAbortSignals(options.init?.signal, signal),
        }),
      );
    }),
    patchLog: Effect.fn("AiGateway.patchLog")((logId: string, data: AiGatewayPatchLog) =>
      tryAiGatewayPromise(definition.binding, "patchLog", () => gateway.patchLog(logId, data)),
    ),
    getLog: Effect.fn("AiGateway.getLog")((logId: string) =>
      tryAiGatewayPromise(definition.binding, "getLog", () => gateway.getLog(logId)),
    ),
    rawUnsafe: Effect.succeed(gateway),
  }) satisfies AiGatewayClient;

export const makeClientFromAi = (
  definition: AiGatewayDefinition,
  ai: WorkersAiBinding,
): AiGatewayClient => {
  const gateway = tryAiGatewaySync(definition.binding, "gateway", () =>
    ai.gateway(definition.gatewayId),
  );

  const withGateway = <A>(
    operation: (gateway: AiGatewayBinding) => Effect.Effect<A, AiGatewayOperationError>,
  ) => gateway.pipe(Effect.flatMap(operation));

  return {
    definition,
    run: (data, options) => withGateway((raw) => makeClient(definition, raw).run(data, options)),
    getUrl: (provider) => withGateway((raw) => makeClient(definition, raw).getUrl(provider)),
    fetch: (options) => withGateway((raw) => makeClient(definition, raw).fetch(options)),
    patchLog: (logId, data) =>
      withGateway((raw) => makeClient(definition, raw).patchLog(logId, data)),
    getLog: (logId) => withGateway((raw) => makeClient(definition, raw).getLog(logId)),
    rawUnsafe: gateway,
  };
};

export const makeHttpClient = (
  definition: Omit<AiGatewayDefinition, "binding"> & {
    readonly accountId: string;
    readonly binding?: string;
  },
  request: typeof fetch = fetch,
): AiGatewayClient => {
  const binding = definition.binding ?? "AI_GATEWAY";
  const clientDefinition: AiGatewayDefinition = {
    binding,
    gatewayId: definition.gatewayId,
    accountId: definition.accountId,
  };

  const getUrl = (provider?: AiGatewayProvider) =>
    Effect.succeed(
      provider === undefined
        ? gatewayUrl(definition)
        : providerUrl(gatewayUrl(definition), provider).href.replace(/\/$/, ""),
    );
  const extraHeaders = (options?: AiGatewayRunOptions): HeadersInit | undefined => {
    if (
      options?.extraHeaders === undefined ||
      Array.isArray(options.extraHeaders) ||
      options.extraHeaders instanceof Headers
    ) {
      // SAFETY: the preceding branches retain only HeadersInit-compatible header containers.
      return options?.extraHeaders as HeadersInit | undefined;
    }

    return Object.fromEntries(
      Object.entries(options.extraHeaders).map(([key, value]) => [key, String(value)]),
    );
  };

  return {
    definition: clientDefinition,
    run: Effect.fn("AiGateway.run")(
      (
        data: AiGatewayUniversalRequest | ReadonlyArray<AiGatewayUniversalRequest>,
        options?: AiGatewayRunOptions,
      ) =>
        tryAiGatewayPromise(binding, "run", (signal) =>
          request(gatewayUrl(definition), {
            method: "POST",
            body: JSON.stringify(data),
            headers: new Headers({
              "content-type": "application/json",
              ...Object.fromEntries(new Headers(extraHeaders(options)).entries()),
            }),
            signal: mergeAbortSignals(options?.signal, signal),
          }),
        ),
    ),
    getUrl,
    fetch: Effect.fn("AiGateway.fetch")((options: AiGatewayFetchOptions) =>
      getUrl(options.provider).pipe(
        Effect.flatMap((baseUrl) =>
          tryAiGatewayPromise(binding, "fetch", (signal) =>
            request(providerUrl(baseUrl, options.path).href, {
              ...options.init,
              signal: mergeAbortSignals(options.init?.signal, signal),
            }),
          ),
        ),
      ),
    ),
    patchLog: Effect.fn("AiGateway.patchLog")((logId: string, data: AiGatewayPatchLog) =>
      tryAiGatewayPromise(binding, "patchLog", async (signal) => {
        const response = await request(providerUrl(gatewayUrl(definition), `logs/${logId}`).href, {
          method: "PATCH",
          body: JSON.stringify(data),
          headers: { "content-type": "application/json" },
          signal,
        });

        ensureSuccessfulResponse(response);
        await decodeAiGatewayPatchLogResponse(await response.json());
      }),
    ),
    getLog: Effect.fn("AiGateway.getLog")((logId: string) =>
      tryAiGatewayPromise(binding, "getLog", async (signal) => {
        const response = await request(providerUrl(gatewayUrl(definition), `logs/${logId}`).href, {
          signal,
        });

        ensureSuccessfulResponse(response);
        const payload = await decodeAiGatewayLogResponse(await response.json());

        return payload.result;
      }),
    ),
    rawUnsafe: Effect.fail(
      aiGatewayError(
        binding,
        "rawUnsafe",
        new TypeError("HTTP AI Gateway clients have no raw binding"),
      ),
    ),
  };
};

export const layer = <Self>(
  tag: Context.Service<Self, AiGatewayClient>,
  definition: AiGatewayDefinition,
) =>
  Binding.layer(
    tag,
    definition.binding,
    isAiGatewayBinding,
    (ai) => makeClientFromAi(definition, ai),
    { expected: expectedAiGatewayBinding },
  );

export const make = <Id extends string>(id: Id) => Tag<AiGatewayService<Id>>()<Id>(id);

export const Tag =
  <Self>() =>
  <Id extends string>(id: Id) => {
    const tag = Context.Service<Self, AiGatewayClient>()(id);

    const makeLayer = (definition: LayerOptions) => layer(tag, definition);

    // SAFETY: these are exactly the members required by TagClass, attached to the matching service tag.
    return Object.assign(tag, {
      id,
      layer: makeLayer,
    }) as TagClass<Self, Id>;
  };
