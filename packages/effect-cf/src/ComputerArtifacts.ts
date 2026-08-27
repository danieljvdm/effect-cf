import type {
  ArtifactClient as CloudflareComputerArtifactClient,
  ArtifactImportOptions as CloudflareComputerArtifactImportOptions,
  ArtifactImportSource as CloudflareComputerArtifactImportSource,
  ArtifactRepoSummary as CloudflareComputerArtifactRepoSummary,
  ArtifactScope as CloudflareComputerArtifactScope,
  ArtifactsCLIInput as CloudflareComputerArtifactsCliInput,
  ArtifactsCLIResult as CloudflareComputerArtifactsCliResult,
  RemoteAddFn as CloudflareComputerRemoteAdd,
} from "@cloudflare/computer/artifacts";
import { Effect, Predicate } from "effect";

import * as Artifacts from "./Artifacts";

/** External Git source accepted by a session-scoped repository import. */
export type ComputerArtifactImportSource = Readonly<CloudflareComputerArtifactImportSource>;

/** Target options accepted by a session-scoped repository import. */
export type ComputerArtifactImportOptions = Readonly<CloudflareComputerArtifactImportOptions>;

/** Repository metadata returned by a session-scoped list operation. */
export type ComputerArtifactRepoSummary = Readonly<CloudflareComputerArtifactRepoSummary>;

/** Token scope accepted by the upstream session facade. */
export type ComputerArtifactScope = CloudflareComputerArtifactScope;

/** Optional Git remote-registration seam accepted by the argv API. */
export type ComputerArtifactsRemoteAdd = CloudflareComputerRemoteAdd;

/** Input to the session-scoped `artifacts` argv API. */
export type ComputerArtifactsCliInput = CloudflareComputerArtifactsCliInput;

/** Result from the session-scoped `artifacts` argv API. */
export type ComputerArtifactsCliResult = Readonly<CloudflareComputerArtifactsCliResult>;

/** Options used when wrapping a session-scoped Artifacts client. */
export interface ComputerArtifactsClientOptions {
  readonly binding?: string;
}

interface MutableArtifactsErrorDetails {
  code?: Artifacts.ArtifactsOperationError["code"];
  numericCode?: number;
}

/**
 * Effect-native facade over `@cloudflare/computer/artifacts`.
 *
 * Repository names are local to {@link sessionId}. Prefixing and filtering are
 * intentionally delegated to the upstream `createArtifact` implementation so
 * this client and the worker-shell `artifacts` command always use the same
 * namespace convention.
 */
export interface ComputerArtifactsClient {
  readonly sessionId: string;
  readonly create: (
    name: Artifacts.RepoName,
    options?: Artifacts.ArtifactsCreateOptions,
  ) => Effect.Effect<Artifacts.ArtifactsCreateRepoResult, Artifacts.ArtifactsOperationError>;
  readonly get: (
    name: Artifacts.RepoName,
  ) => Effect.Effect<Artifacts.ArtifactsRepoInfo, Artifacts.ArtifactsOperationError>;
  readonly list: Effect.Effect<
    ReadonlyArray<ComputerArtifactRepoSummary>,
    Artifacts.ArtifactsOperationError
  >;
  readonly import: (
    name: Artifacts.RepoName,
    source: ComputerArtifactImportSource,
    options?: ComputerArtifactImportOptions,
  ) => Effect.Effect<Artifacts.ArtifactsCreateRepoResult, Artifacts.ArtifactsOperationError>;
  readonly delete: (
    name: Artifacts.RepoName,
  ) => Effect.Effect<boolean, Artifacts.ArtifactsOperationError>;
  readonly createToken: (
    name: Artifacts.RepoName,
    scope?: ComputerArtifactScope,
    ttl?: number,
  ) => Effect.Effect<Artifacts.ArtifactsCreateTokenResult, Artifacts.ArtifactsOperationError>;
  readonly listTokens: (
    name: Artifacts.RepoName,
  ) => Effect.Effect<Artifacts.ArtifactsTokenListResult, Artifacts.ArtifactsOperationError>;
  readonly getToken: (
    name: Artifacts.RepoName,
    id: string,
  ) => Effect.Effect<Artifacts.ArtifactsTokenInfo, Artifacts.ArtifactsOperationError>;
  readonly revokeToken: (
    name: Artifacts.RepoName,
    tokenOrId: string,
  ) => Effect.Effect<boolean, Artifacts.ArtifactsOperationError>;
  readonly cli: (
    input: ComputerArtifactsCliInput,
  ) => Effect.Effect<ComputerArtifactsCliResult, Artifacts.ArtifactsOperationError>;
  readonly rawUnsafe: Effect.Effect<CloudflareComputerArtifactClient>;
}

const artifactsErrorDetails = (
  cause: unknown,
): Pick<Artifacts.ArtifactsOperationError, "code" | "numericCode"> => {
  if (!Predicate.isObject(cause)) {
    return {};
  }

  const code = Predicate.hasProperty(cause, "code") ? cause.code : undefined;
  const numericCode = Predicate.hasProperty(cause, "numericCode") ? cause.numericCode : undefined;
  const details: MutableArtifactsErrorDetails = {};

  if (Predicate.isString(code)) details.code = code;
  if (Predicate.isNumber(numericCode)) details.numericCode = numericCode;

  return details;
};

const operationError = (binding: string, operation: Artifacts.ArtifactsOperation, cause: unknown) =>
  new Artifacts.ArtifactsOperationError({
    binding,
    operation,
    cause,
    ...artifactsErrorDetails(cause),
  });

const tryOperation = <A>(
  binding: string,
  operation: Artifacts.ArtifactsOperation,
  evaluate: () => Promise<A>,
) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => operationError(binding, operation, cause),
  });

const spanOptions = (
  binding: string,
  sessionId: string,
  operation: Artifacts.ArtifactsOperation,
) => ({ attributes: { binding, sessionId, operation } });

export const fromClient = (
  client: CloudflareComputerArtifactClient,
  options: ComputerArtifactsClientOptions = {},
): ComputerArtifactsClient => {
  const binding = options.binding ?? "ARTIFACTS";
  const { sessionId } = client;

  return {
    sessionId,
    create: Effect.fn(
      "ComputerArtifacts.create",
      spanOptions(binding, sessionId, "create"),
    )(function* (name: Artifacts.RepoName, createOptions?: Artifacts.ArtifactsCreateOptions) {
      yield* Effect.annotateCurrentSpan("repo", name);

      return yield* tryOperation(binding, "create", () => client.create(name, createOptions));
    }),
    get: Effect.fn(
      "ComputerArtifacts.get",
      spanOptions(binding, sessionId, "get"),
    )(function* (name: Artifacts.RepoName) {
      yield* Effect.annotateCurrentSpan("repo", name);

      return yield* tryOperation(binding, "get", () => client.get(name));
    }),
    list: tryOperation(binding, "list", () => client.list()).pipe(
      Effect.withSpan("ComputerArtifacts.list", spanOptions(binding, sessionId, "list")),
    ),
    import: Effect.fn(
      "ComputerArtifacts.import",
      spanOptions(binding, sessionId, "import"),
    )(function* (
      name: Artifacts.RepoName,
      source: ComputerArtifactImportSource,
      importOptions?: ComputerArtifactImportOptions,
    ) {
      yield* Effect.annotateCurrentSpan("repo", name);

      return yield* tryOperation(binding, "import", () =>
        client.import(name, source, importOptions),
      );
    }),
    delete: Effect.fn(
      "ComputerArtifacts.delete",
      spanOptions(binding, sessionId, "delete"),
    )(function* (name: Artifacts.RepoName) {
      yield* Effect.annotateCurrentSpan("repo", name);

      return yield* tryOperation(binding, "delete", () => client.delete(name));
    }),
    createToken: Effect.fn(
      "ComputerArtifacts.createToken",
      spanOptions(binding, sessionId, "createToken"),
    )(function* (name: Artifacts.RepoName, scope?: ComputerArtifactScope, ttl?: number) {
      yield* Effect.annotateCurrentSpan("repo", name);

      return yield* tryOperation(binding, "createToken", () =>
        client.createToken(name, scope, ttl),
      );
    }),
    listTokens: Effect.fn(
      "ComputerArtifacts.listTokens",
      spanOptions(binding, sessionId, "listTokens"),
    )(function* (name: Artifacts.RepoName) {
      yield* Effect.annotateCurrentSpan("repo", name);

      return yield* tryOperation(binding, "listTokens", () => client.listTokens(name));
    }),
    getToken: Effect.fn(
      "ComputerArtifacts.getToken",
      spanOptions(binding, sessionId, "getToken"),
    )(function* (name: Artifacts.RepoName, id: string) {
      yield* Effect.annotateCurrentSpan({ repo: name, tokenId: id });

      return yield* tryOperation(binding, "getToken", () => client.getToken(name, id));
    }),
    revokeToken: Effect.fn(
      "ComputerArtifacts.revokeToken",
      spanOptions(binding, sessionId, "revokeToken"),
    )(function* (name: Artifacts.RepoName, tokenOrId: string) {
      yield* Effect.annotateCurrentSpan("repo", name);

      return yield* tryOperation(binding, "revokeToken", () => client.revokeToken(name, tokenOrId));
    }),
    cli: Effect.fn(
      "ComputerArtifacts.cli",
      spanOptions(binding, sessionId, "cli"),
    )(function* (input: ComputerArtifactsCliInput) {
      yield* Effect.annotateCurrentSpan("argv", input.argv.join(" "));

      return yield* tryOperation(binding, "cli", () => client.cli(input));
    }),
    rawUnsafe: Effect.succeed(client),
  };
};

/**
 * Creates an Effect-native session client directly from a Worker Artifacts
 * binding. `@cloudflare/computer` is loaded only when this Effect runs, keeping
 * the optional peer out of applications that do not use this integration.
 */
export const makeClient = Effect.fn("ComputerArtifacts.makeClient")(function* (
  bindingValue: Artifacts.ArtifactsBinding,
  sessionId: string,
  options: ComputerArtifactsClientOptions = {},
) {
  const binding = options.binding ?? "ARTIFACTS";
  const computerArtifacts = yield* Effect.tryPromise({
    try: () => import("@cloudflare/computer/artifacts"),
    catch: (cause) => operationError(binding, "createClient", cause),
  });
  const client = yield* Effect.try({
    try: () =>
      // SAFETY: both packages describe the same Cloudflare Artifacts binding runtime object.
      computerArtifacts.createArtifact(
        bindingValue as Artifacts.ArtifactsBinding &
          Parameters<typeof computerArtifacts.createArtifact>[0],
        sessionId,
      ),
    catch: (cause) => operationError(binding, "createClient", cause),
  });

  return fromClient(client, { binding });
});
