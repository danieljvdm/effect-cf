import { Context, Data, Effect, type Layer } from "effect";
import type { AiGateway as CloudflareAiGateway } from "@cloudflare/workers-types";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";
import { isWorkersAiBinding, type WorkersAiBinding } from "./WorkersAi";

const expectedAiGatewayBinding = "Workers AI binding with gateway()";

/** Error raised when an AI Gateway operation fails. */
export class AiGatewayOperationError extends Data.TaggedError("AiGatewayOperationError")<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** Typed AI Gateway client definition. */
export interface AiGatewayDefinition {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
  /** Gateway id/name passed to `env.AI.gateway(id)`. */
  readonly gatewayId: string;
  /** Optional account id used by the HTTP-only helper. */
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
  readonly unsafeRaw: Effect.Effect<AiGatewayBinding, AiGatewayOperationError>;
  readonly definition: AiGatewayDefinition;
}

declare const AiGatewayServiceTypeId: unique symbol;

/** Nominal service marker for AI Gateway services created with {@link make}. */
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
  evaluate: () => Promise<A>,
): Effect.Effect<A, AiGatewayOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => aiGatewayError(binding, operation, cause),
  });

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

export const isAiGatewayBinding = (value: unknown): value is WorkersAiBinding =>
  isWorkersAiBinding(value);

export const makeClient = (definition: AiGatewayDefinition, gateway: AiGatewayBinding) =>
  ({
    definition,
    run: (data, options) =>
      tryAiGatewayPromise(definition.binding, "run", () =>
        gateway.run(
          (Array.isArray(data) ? [...data] : data) as
            | AiGatewayUniversalRequest
            | Array<AiGatewayUniversalRequest>,
          options,
        ),
      ),
    getUrl: (provider) =>
      tryAiGatewayPromise(definition.binding, "getUrl", () => gateway.getUrl(provider)),
    fetch: (options) =>
      Effect.gen(function* () {
        const baseUrl = yield* tryAiGatewayPromise(definition.binding, "getUrl", () =>
          gateway.getUrl(options.provider),
        );
        return yield* tryAiGatewayPromise(definition.binding, "fetch", () =>
          fetch(providerUrl(baseUrl, options.path).href, options.init),
        );
      }),
    patchLog: (logId, data) =>
      tryAiGatewayPromise(definition.binding, "patchLog", () => gateway.patchLog(logId, data)),
    getLog: (logId) =>
      tryAiGatewayPromise(definition.binding, "getLog", () => gateway.getLog(logId)),
    unsafeRaw: Effect.succeed(gateway),
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
    unsafeRaw: gateway,
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
      return options?.extraHeaders as HeadersInit | undefined;
    }

    return Object.fromEntries(
      Object.entries(options.extraHeaders).map(([key, value]) => [key, String(value)]),
    );
  };

  return {
    definition: clientDefinition,
    run: (data, options) =>
      tryAiGatewayPromise(binding, "run", () =>
        request(gatewayUrl(definition), {
          method: "POST",
          body: JSON.stringify(data),
          headers: new Headers({
            "content-type": "application/json",
            ...Object.fromEntries(new Headers(extraHeaders(options)).entries()),
          }),
          signal: options?.signal,
        }),
      ),
    getUrl,
    fetch: (options) =>
      getUrl(options.provider).pipe(
        Effect.flatMap((baseUrl) =>
          tryAiGatewayPromise(binding, "fetch", () =>
            request(providerUrl(baseUrl, options.path).href, options.init),
          ),
        ),
      ),
    patchLog: (logId, data) =>
      tryAiGatewayPromise(binding, "patchLog", () =>
        request(providerUrl(gatewayUrl(definition), `logs/${logId}`).href, {
          method: "PATCH",
          body: JSON.stringify(data),
          headers: { "content-type": "application/json" },
        }).then(() => undefined),
      ),
    getLog: (logId) =>
      tryAiGatewayPromise(binding, "getLog", async () => {
        const response = await request(providerUrl(gatewayUrl(definition), `logs/${logId}`).href);
        return (await response.json()) as AiGatewayLog;
      }),
    unsafeRaw: Effect.fail(
      aiGatewayError(
        binding,
        "unsafeRaw",
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

    return Object.assign(tag, {
      id,
      layer: makeLayer,
    }) as TagClass<Self, Id>;
  };
