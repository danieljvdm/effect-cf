import type {
  ArtifactsCreateTokenResult as CloudflareArtifactsCreateTokenResult,
  ArtifactsErrorCode as CloudflareArtifactsErrorCode,
  ArtifactsRepoInfo as CloudflareArtifactsRepoInfo,
  ArtifactsTokenInfo as CloudflareArtifactsTokenInfo,
  ArtifactsTokenListResult as CloudflareArtifactsTokenListResult,
} from "@cloudflare/workers-types";
import { Context, Data, Effect, type Layer } from "effect";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";
import * as ErrorMessage from "./internal/ErrorMessage";

const expectedArtifactsBinding =
  "Artifacts binding with create(), get(), import(), list(), and delete()";

const expectedArtifactsRepo =
  "Artifacts repo handle with createToken(), listTokens(), revokeToken(), fork(), log(), readCommit(), and readTree()";

/** Artifacts operation represented by {@link ArtifactsOperationError}. */
export type ArtifactsOperation =
  | "create"
  | "get"
  | "import"
  | "list"
  | "delete"
  | "createToken"
  | "listTokens"
  | "revokeToken"
  | "fork"
  | "log"
  | "readCommit"
  | "readTree";

/** Documented string error codes returned by Cloudflare Artifacts. */
export const artifactsErrorCodes = [
  "ALREADY_EXISTS",
  "NOT_FOUND",
  "IMPORT_IN_PROGRESS",
  "FORK_IN_PROGRESS",
  "INVALID_INPUT",
  "INVALID_REPO_NAME",
  "INVALID_TTL",
  "INVALID_URL",
  "REMOTE_AUTH_REQUIRED",
  "UPSTREAM_UNAVAILABLE",
  "MEMORY_LIMIT",
  "INTERNAL_ERROR",
] as const satisfies ReadonlyArray<CloudflareArtifactsErrorCode>;

/** Documented numeric error codes returned by Cloudflare Artifacts. */
export const artifactsErrorNumericCodes = {
  ALREADY_EXISTS: 10201,
  NOT_FOUND: 10200,
  IMPORT_IN_PROGRESS: 10302,
  FORK_IN_PROGRESS: 10303,
  INVALID_INPUT: 10100,
  INVALID_REPO_NAME: 10101,
  INVALID_TTL: 10103,
  INVALID_URL: 10104,
  REMOTE_AUTH_REQUIRED: 10106,
  UPSTREAM_UNAVAILABLE: 10401,
  MEMORY_LIMIT: 10402,
  INTERNAL_ERROR: 10400,
} as const satisfies Readonly<Record<CloudflareArtifactsErrorCode, number>>;

/** A documented Cloudflare Artifacts string error code. */
export type ArtifactsErrorCode = CloudflareArtifactsErrorCode;

/** Error raised when a Cloudflare Artifacts operation fails. */
export class ArtifactsOperationError extends Data.TaggedError("ArtifactsOperationError")<{
  readonly binding: string;
  readonly operation: ArtifactsOperation;
  readonly cause: unknown;
  /** Cloudflare string error code, when retained by the runtime. */
  readonly code?: ArtifactsErrorCode | (string & {});
  /** Cloudflare REST-compatible numeric error code, when retained by the runtime. */
  readonly numericCode?: number;
}> {
  override get message(): string {
    const code = this.code === undefined ? "" : ` (${this.code})`;

    return `Artifacts ${this.operation} failed for binding "${this.binding}"${code}: ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

/** Typed Cloudflare Artifacts binding definition. */
export interface ArtifactsDefinition {
  /** Binding name from an `artifacts` entry in `wrangler.jsonc`. */
  readonly binding: string;
}

/** Repository name containing alphanumeric characters, dots, hyphens, or underscores. */
export type RepoName = string;

/** Cursor used by repository list pagination. */
export type Cursor = string;

/** Scope granted to a repository token. */
export type ArtifactsTokenScope = "read" | "write";

/** Lifecycle state of a repository token. */
export type ArtifactsTokenState = "active" | "expired" | "revoked";

/** Lifecycle state included with repositories returned by `list()`. */
export type ArtifactsRepoStatus = "ready" | "importing" | "forking";

/** Stable repository metadata returned by Cloudflare Artifacts. */
export type ArtifactsRepoInfo = CloudflareArtifactsRepoInfo;

/** Result of creating, importing, or forking a repository. */
export interface ArtifactsCreateRepoResult {
  readonly id: string;
  readonly name: RepoName;
  readonly description: string | null;
  readonly defaultBranch: string;
  readonly remote: string;
  /** Initial plaintext Git token. The token itself encodes its expiry. */
  readonly token: string;
}

/** Repository metadata returned by `list()`. */
export interface ArtifactsRepoListEntry extends ArtifactsRepoInfo {
  readonly status: ArtifactsRepoStatus;
}

/** Cursor-paginated repository list result. */
export interface ArtifactsRepoListResult {
  readonly repos: ReadonlyArray<ArtifactsRepoListEntry>;
  readonly total: number;
  readonly cursor?: Cursor;
}

/** Result of creating a repository token. */
export type ArtifactsCreateTokenResult = CloudflareArtifactsCreateTokenResult;

/** Repository token metadata, excluding its plaintext secret. */
export type ArtifactsTokenInfo = CloudflareArtifactsTokenInfo;

/** Repository token list result. */
export type ArtifactsTokenListResult = CloudflareArtifactsTokenListResult;

/**
 * Commit history returned by `log()`.
 *
 * Cloudflare currently documents this generated type by name but does not
 * publish its fields in the binding reference or Workers type declarations.
 */
export interface ArtifactsLogResult {
  readonly [field: string]: unknown;
}

/**
 * Parsed Git commit returned by `readCommit()`.
 *
 * Cloudflare currently documents this generated type by name but does not
 * publish its fields in the binding reference or Workers type declarations.
 */
export interface ArtifactsCommit {
  readonly [field: string]: unknown;
}

/**
 * Parsed Git tree returned by `readTree()`.
 *
 * Cloudflare currently documents this generated type by name but does not
 * publish its fields in the binding reference or Workers type declarations.
 */
export interface ArtifactsTree {
  readonly [field: string]: unknown;
}

/** Options for `Artifacts.create()`. */
export interface ArtifactsCreateOptions {
  /** Prevent pushes to the repository. */
  readonly readOnly?: boolean;
  readonly description?: string;
  /** Initial default branch name. */
  readonly setDefaultBranch?: string;
}

/** Options for cursor-paginating `Artifacts.list()`. */
export interface ArtifactsListOptions {
  /** Page size from 1 through 200. Defaults to 50. */
  readonly limit?: number;
  /** Cursor returned by a previous list result. */
  readonly cursor?: Cursor;
}

/** External Git source used by `Artifacts.import()`. */
export interface ArtifactsImportSource {
  /** Full HTTPS URL of the Git repository. */
  readonly url: string;
  /** Source branch. Defaults to the remote's default branch. */
  readonly branch?: string;
  /** Shallow clone depth. */
  readonly depth?: number;
}

/** Options for the target of `Artifacts.import()`. */
export interface ArtifactsImportTargetOptions {
  readonly description?: string;
  readonly readOnly?: boolean;
}

/** Target repository used by `Artifacts.import()`. */
export interface ArtifactsImportTarget {
  readonly name: RepoName;
  readonly opts?: ArtifactsImportTargetOptions;
}

/** Parameters for `Artifacts.import()`. */
export interface ArtifactsImportParams {
  readonly source: ArtifactsImportSource;
  readonly target: ArtifactsImportTarget;
}

/** Options for `ArtifactsRepoClient.fork()`. */
export interface ArtifactsForkOptions {
  readonly description?: string;
  readonly readOnly?: boolean;
  /** Only copy the default branch. Defaults to `true`. */
  readonly defaultBranchOnly?: boolean;
}

/** Options for `ArtifactsRepoClient.log()`. */
export interface ArtifactsLogOptions {
  /** Branch, tag, or commit hash. */
  readonly ref?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/** Runtime repository handle, including methods absent from current shipped Workers types. */
export interface ArtifactsRepoBinding extends ArtifactsRepoInfo {
  /**
   * Create a Git token for the repository.
   *
   * Scope defaults to `"write"`. TTL is measured in seconds, defaults to
   * 86,400, and must be between 60 and 31,536,000.
   */
  readonly createToken: (
    scope?: ArtifactsTokenScope,
    ttl?: number,
  ) => Promise<ArtifactsCreateTokenResult>;
  readonly listTokens: () => Promise<ArtifactsTokenListResult>;
  readonly revokeToken: (tokenOrId: string) => Promise<boolean>;
  readonly fork: (
    name: RepoName,
    options?: ArtifactsForkOptions,
  ) => Promise<ArtifactsCreateRepoResult>;
  readonly log: (options?: ArtifactsLogOptions) => Promise<ArtifactsLogResult>;
  readonly readCommit: (hash: string) => Promise<ArtifactsCommit>;
  readonly readTree: (hash: string) => Promise<ArtifactsTree>;
}

/** Cloudflare Artifacts namespace binding. */
export interface ArtifactsBinding {
  readonly create: (
    name: RepoName,
    options?: ArtifactsCreateOptions,
  ) => Promise<ArtifactsCreateRepoResult>;
  readonly get: (name: RepoName) => Promise<ArtifactsRepoBinding>;
  readonly import: (params: ArtifactsImportParams) => Promise<ArtifactsCreateRepoResult>;
  readonly list: (options?: ArtifactsListOptions) => Promise<ArtifactsRepoListResult>;
  readonly delete: (name: RepoName) => Promise<boolean>;
}

/** Effect wrapper around a repository handle returned by `Artifacts.get()`. */
export interface ArtifactsRepoClient extends ArtifactsRepoInfo {
  /**
   * Create a Git token for the repository.
   *
   * Scope defaults to `"write"`. TTL is measured in seconds, defaults to
   * 86,400, and must be between 60 and 31,536,000.
   */
  readonly createToken: (
    scope?: ArtifactsTokenScope,
    ttl?: number,
  ) => Effect.Effect<ArtifactsCreateTokenResult, ArtifactsOperationError>;
  readonly listTokens: Effect.Effect<ArtifactsTokenListResult, ArtifactsOperationError>;
  readonly revokeToken: (tokenOrId: string) => Effect.Effect<boolean, ArtifactsOperationError>;
  readonly fork: (
    name: RepoName,
    options?: ArtifactsForkOptions,
  ) => Effect.Effect<ArtifactsCreateRepoResult, ArtifactsOperationError>;
  readonly log: (
    options?: ArtifactsLogOptions,
  ) => Effect.Effect<ArtifactsLogResult, ArtifactsOperationError>;
  readonly readCommit: (hash: string) => Effect.Effect<ArtifactsCommit, ArtifactsOperationError>;
  readonly readTree: (hash: string) => Effect.Effect<ArtifactsTree, ArtifactsOperationError>;
  readonly raw: ArtifactsRepoBinding;
}

/** Effect wrapper around a Cloudflare Artifacts namespace binding. */
export interface ArtifactsClient {
  readonly create: (
    name: RepoName,
    options?: ArtifactsCreateOptions,
  ) => Effect.Effect<ArtifactsCreateRepoResult, ArtifactsOperationError>;
  readonly get: (name: RepoName) => Effect.Effect<ArtifactsRepoClient, ArtifactsOperationError>;
  readonly import: (
    params: ArtifactsImportParams,
  ) => Effect.Effect<ArtifactsCreateRepoResult, ArtifactsOperationError>;
  readonly list: (
    options?: ArtifactsListOptions,
  ) => Effect.Effect<ArtifactsRepoListResult, ArtifactsOperationError>;
  readonly delete: (name: RepoName) => Effect.Effect<boolean, ArtifactsOperationError>;
  readonly rawUnsafe: Effect.Effect<ArtifactsBinding>;
  readonly definition: ArtifactsDefinition;
}

declare const ArtifactsServiceTypeId: unique symbol;

/** Nominal service marker for Artifacts services created with {@link make}. */
export interface ArtifactsService<Id extends string> {
  readonly [ArtifactsServiceTypeId]: {
    readonly id: Id;
  };
}

export type LayerOptions = {
  readonly binding: string;
};

export interface TagClass<Self, Id extends string> extends Context.ServiceClass<
  Self,
  Id,
  ArtifactsClient
> {
  readonly id: Id;
  readonly layer: (
    options: LayerOptions,
  ) => Layer.Layer<
    Self,
    Binding.BindingNotFoundError | Binding.BindingValidationError,
    WorkerEnvironment
  >;
}

const artifactsErrorDetails = (
  cause: unknown,
): Pick<ArtifactsOperationError, "code" | "numericCode"> => {
  if (typeof cause !== "object" || cause === null) {
    return {};
  }

  const code = Reflect.get(cause, "code");
  const numericCode = Reflect.get(cause, "numericCode");

  return {
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof numericCode === "number" ? { numericCode } : {}),
  };
};

const artifactsError = (binding: string, operation: ArtifactsOperation, cause: unknown) =>
  new ArtifactsOperationError({
    binding,
    operation,
    cause,
    ...artifactsErrorDetails(cause),
  });

const tryArtifactsPromise = <A>(
  binding: string,
  operation: ArtifactsOperation,
  evaluate: () => Promise<A>,
): Effect.Effect<A, ArtifactsOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => artifactsError(binding, operation, cause),
  });

const spanOptions = (binding: string, operation: ArtifactsOperation) => ({
  attributes: { binding, operation },
});

const hasFunction = (value: object, key: string): boolean =>
  typeof Reflect.get(value, key) === "function";

/** Tests whether a value exposes the complete documented Artifacts repo handle API. */
export const isArtifactsRepoBinding = (value: unknown): value is ArtifactsRepoBinding =>
  typeof value === "object" &&
  value !== null &&
  hasFunction(value, "createToken") &&
  hasFunction(value, "listTokens") &&
  hasFunction(value, "revokeToken") &&
  hasFunction(value, "fork") &&
  hasFunction(value, "log") &&
  hasFunction(value, "readCommit") &&
  hasFunction(value, "readTree");

/** Tests whether a value exposes the complete documented Artifacts namespace API. */
export const isArtifactsBinding = (value: unknown): value is ArtifactsBinding =>
  typeof value === "object" &&
  value !== null &&
  hasFunction(value, "create") &&
  hasFunction(value, "get") &&
  hasFunction(value, "import") &&
  hasFunction(value, "list") &&
  hasFunction(value, "delete");

const wrapRepo = (binding: string, repo: ArtifactsRepoBinding): ArtifactsRepoClient => ({
  id: repo.id,
  name: repo.name,
  description: repo.description,
  defaultBranch: repo.defaultBranch,
  createdAt: repo.createdAt,
  updatedAt: repo.updatedAt,
  lastPushAt: repo.lastPushAt,
  source: repo.source,
  readOnly: repo.readOnly,
  remote: repo.remote,
  createToken: Effect.fn(
    "Artifacts.createToken",
    spanOptions(binding, "createToken"),
  )((scope?: ArtifactsTokenScope, ttl?: number) =>
    tryArtifactsPromise(binding, "createToken", () => repo.createToken(scope, ttl)),
  ),
  listTokens: tryArtifactsPromise(binding, "listTokens", () => repo.listTokens()).pipe(
    Effect.withSpan("Artifacts.listTokens", spanOptions(binding, "listTokens")),
  ),
  revokeToken: Effect.fn(
    "Artifacts.revokeToken",
    spanOptions(binding, "revokeToken"),
  )((tokenOrId: string) =>
    tryArtifactsPromise(binding, "revokeToken", () => repo.revokeToken(tokenOrId)),
  ),
  fork: Effect.fn(
    "Artifacts.fork",
    spanOptions(binding, "fork"),
  )((name: RepoName, options?: ArtifactsForkOptions) =>
    tryArtifactsPromise(binding, "fork", () => repo.fork(name, options)),
  ),
  log: Effect.fn(
    "Artifacts.log",
    spanOptions(binding, "log"),
  )((options?: ArtifactsLogOptions) =>
    tryArtifactsPromise(binding, "log", () => repo.log(options)),
  ),
  readCommit: Effect.fn(
    "Artifacts.readCommit",
    spanOptions(binding, "readCommit"),
  )((hash: string) => tryArtifactsPromise(binding, "readCommit", () => repo.readCommit(hash))),
  readTree: Effect.fn(
    "Artifacts.readTree",
    spanOptions(binding, "readTree"),
  )((hash: string) => tryArtifactsPromise(binding, "readTree", () => repo.readTree(hash))),
  raw: repo,
});

export const makeClient =
  (definition: ArtifactsDefinition) =>
  (artifacts: ArtifactsBinding): ArtifactsClient => ({
    definition,
    create: Effect.fn(
      "Artifacts.create",
      spanOptions(definition.binding, "create"),
    )((name: RepoName, options?: ArtifactsCreateOptions) =>
      tryArtifactsPromise(definition.binding, "create", () => artifacts.create(name, options)),
    ),
    get: Effect.fn(
      "Artifacts.get",
      spanOptions(definition.binding, "get"),
    )((name: RepoName) =>
      tryArtifactsPromise(definition.binding, "get", () => artifacts.get(name)).pipe(
        Effect.flatMap((repo) =>
          isArtifactsRepoBinding(repo)
            ? Effect.succeed(wrapRepo(definition.binding, repo))
            : Effect.fail(
                artifactsError(
                  definition.binding,
                  "get",
                  new TypeError(`Expected ${expectedArtifactsRepo}`),
                ),
              ),
        ),
      ),
    ),
    import: Effect.fn(
      "Artifacts.import",
      spanOptions(definition.binding, "import"),
    )((params: ArtifactsImportParams) =>
      tryArtifactsPromise(definition.binding, "import", () => artifacts.import(params)),
    ),
    list: Effect.fn(
      "Artifacts.list",
      spanOptions(definition.binding, "list"),
    )((options?: ArtifactsListOptions) =>
      tryArtifactsPromise(definition.binding, "list", () => artifacts.list(options)),
    ),
    delete: Effect.fn(
      "Artifacts.delete",
      spanOptions(definition.binding, "delete"),
    )((name: RepoName) =>
      tryArtifactsPromise(definition.binding, "delete", () => artifacts.delete(name)),
    ),
    rawUnsafe: Effect.succeed(artifacts),
  });

export const layer = <Self>(
  tag: Context.Service<Self, ArtifactsClient>,
  definition: ArtifactsDefinition,
) =>
  Binding.layer(tag, definition.binding, isArtifactsBinding, makeClient(definition), {
    expected: expectedArtifactsBinding,
  });

export const make = <Id extends string>(id: Id) => Tag<ArtifactsService<Id>>()<Id>(id);

export const Tag =
  <Self>() =>
  <Id extends string>(id: Id) => {
    const tag = Context.Service<Self, ArtifactsClient>()(id);

    const makeLayer = (definition: LayerOptions) => layer(tag, definition);

    return Object.assign(tag, {
      id,
      layer: makeLayer,
    }) as TagClass<Self, Id>;
  };
