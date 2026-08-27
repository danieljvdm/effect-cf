import type {
  ExecSyncResult as CloudflareExecSyncResult,
  RuntimeExecOptions as CloudflareRuntimeExecOptions,
  RuntimeGetOptions as CloudflareRuntimeGetOptions,
  RuntimeKillOptions as CloudflareRuntimeKillOptions,
  ShellValue as CloudflareShellValue,
  SkippedEntry as CloudflareSkippedEntry,
  ThinkWorkspaceCompatibility as CloudflareThinkWorkspaceCompatibility,
  WorkspaceClient as CloudflareWorkspaceClient,
  WorkspaceRuntimeEvent as CloudflareWorkspaceRuntimeEvent,
  WorkspaceRuntimeExecHandle as CloudflareWorkspaceRuntimeExecHandle,
  WorkspaceRuntimeResult as CloudflareWorkspaceRuntimeResult,
  WorkspaceRuntimeValue as CloudflareWorkspaceRuntimeValue,
} from "@cloudflare/computer";
import type { ArtifactClient as CloudflareComputerArtifactClient } from "@cloudflare/computer/artifacts";
import type {
  AssetsClient as CloudflareComputerAssetsClient,
  ShareOptions as CloudflareComputerShareOptions,
} from "@cloudflare/computer/assets";
import type {
  CommitView as CloudflareCommitView,
  GitClient as CloudflareGitClient,
  GitCloneOptions as CloudflareGitCloneOptions,
  GitCommitOptions as CloudflareGitCommitOptions,
  GitDiffOptions as CloudflareGitDiffOptions,
  GitFetchOptions as CloudflareGitFetchOptions,
  GitLogOptions as CloudflareGitLogOptions,
  GitUpdateRefOptions as CloudflareGitUpdateRefOptions,
} from "@cloudflare/computer/git";
import { Context, Effect, Layer, Predicate, Schema, type Scope, Stream } from "effect";

import * as ComputerArtifacts from "./ComputerArtifacts";
import { DurableObjectState } from "./DurableObjectState";
import * as HostRegistry from "./internal/ComputerWorkspaceHostRegistry";

type CloudflareWorkspaceFilesystem = CloudflareWorkspaceClient["fs"];
type CloudflareReadFileOptions = Parameters<CloudflareWorkspaceFilesystem["readFile"]>[1];
type CloudflareReaddirOptions = Parameters<CloudflareWorkspaceFilesystem["readdir"]>[1];
type CloudflareFindOptions = Parameters<CloudflareWorkspaceFilesystem["find"]>[2];
type CloudflareGrepOptions = Parameters<CloudflareWorkspaceFilesystem["grep"]>[2];
type CloudflareRmOptions = Parameters<CloudflareWorkspaceFilesystem["rm"]>[1];
type CloudflareMkdirOptions = Parameters<CloudflareWorkspaceFilesystem["mkdir"]>[1];
type CloudflareWriteFileContent = Parameters<CloudflareWorkspaceFilesystem["writeFile"]>[1];
type CloudflareWriteFileOptions = Parameters<CloudflareWorkspaceFilesystem["writeFile"]>[2];
type CloudflareWorkspaceDirentResult = Awaited<
  ReturnType<CloudflareWorkspaceFilesystem["readdir"]>
>[number];
type CloudflareWorkspaceStatResult = Awaited<ReturnType<CloudflareWorkspaceFilesystem["stat"]>>;
type CloudflareWorkspaceFoundEntry = Awaited<
  ReturnType<CloudflareWorkspaceFilesystem["find"]>
>[number];
type CloudflareWorkspaceGrepMatch = Awaited<
  ReturnType<CloudflareWorkspaceFilesystem["grep"]>
>[number];

/**
 * Workspace errors use `Schema.TaggedError`, unlike most local binding errors,
 * because workspace operations commonly sit behind Durable Object RPC methods.
 * The schema form preserves the operation-family tags across that boundary.
 */
export class WorkspaceFsError extends Schema.TaggedError<WorkspaceFsError>()("WorkspaceFsError", {
  operation: Schema.String,
  path: Schema.String,
  message: Schema.String,
  code: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect({ includeStack: true })),
}) {}

/** Schema-serializable error for a workspace Git operation. */
export class WorkspaceGitError extends Schema.TaggedError<WorkspaceGitError>()(
  "WorkspaceGitError",
  {
    operation: Schema.String,
    message: Schema.String,
    code: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect({ includeStack: true })),
  },
) {}

/** Schema-serializable error for a workspace runtime operation. */
export class WorkspaceExecError extends Schema.TaggedError<WorkspaceExecError>()(
  "WorkspaceExecError",
  {
    operation: Schema.String,
    message: Schema.String,
    code: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect({ includeStack: true })),
  },
) {}

/** Schema-serializable error for a workspace Assets operation. */
export class WorkspaceAssetsError extends Schema.TaggedError<WorkspaceAssetsError>()(
  "WorkspaceAssetsError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
    code: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect({ includeStack: true })),
  },
) {}

export type WorkspaceReadFileOptions = Omit<CloudflareReadFileOptions, "encoding">;
export type ReadTextFileOptions = WorkspaceReadFileOptions;
export type ListDirectoryOptions = CloudflareReaddirOptions;
export type WorkspaceDirectoryEntry = CloudflareWorkspaceDirentResult;
export type WorkspaceEntryStat = CloudflareWorkspaceStatResult;
export type WorkspaceFindOptions = CloudflareFindOptions;
export type WorkspaceFoundEntry = CloudflareWorkspaceFoundEntry;
export type WorkspaceGrepOptions = CloudflareGrepOptions;
export type WorkspaceGrepMatch = CloudflareWorkspaceGrepMatch;
export type RemovePathOptions = CloudflareRmOptions;
export type WorkspaceMkdirOptions = CloudflareMkdirOptions;
export type WorkspaceWriteFileContent = CloudflareWriteFileContent;
export type WorkspaceWriteFileOptions = CloudflareWriteFileOptions;

/** Explicit read mode. Text remains the default for consumer-port compatibility. */
export type WorkspaceReadEncoding = "utf8" | "stream";

export interface WorkspaceReadFile {
  (
    path: string,
    options?: WorkspaceReadFileOptions & { readonly encoding?: "utf8" },
  ): Effect.Effect<string, WorkspaceFsError>;
  (
    path: string,
    options: WorkspaceReadFileOptions & { readonly encoding: "stream" },
  ): Effect.Effect<ReadableStream<Uint8Array>, WorkspaceFsError>;
}

export interface ComputerWorkspaceFilesystem {
  readonly readFile: WorkspaceReadFile;
  readonly stat: (path: string) => Effect.Effect<WorkspaceEntryStat, WorkspaceFsError>;
  readonly lstat: (path: string) => Effect.Effect<WorkspaceEntryStat, WorkspaceFsError>;
  readonly exists: (path: string) => Effect.Effect<boolean, WorkspaceFsError>;
  readonly readlink: (path: string) => Effect.Effect<string, WorkspaceFsError>;
  readonly readdir: (
    path: string,
    options?: ListDirectoryOptions,
  ) => Effect.Effect<ReadonlyArray<WorkspaceDirectoryEntry>, WorkspaceFsError>;
  readonly find: (
    directory: string,
    pattern?: string,
    options?: WorkspaceFindOptions,
  ) => Effect.Effect<ReadonlyArray<WorkspaceFoundEntry>, WorkspaceFsError>;
  readonly ls: (prefix: string) => Effect.Effect<ReadonlyArray<string>, WorkspaceFsError>;
  readonly grep: (
    pattern: string,
    path: string,
    options?: WorkspaceGrepOptions,
  ) => Effect.Effect<ReadonlyArray<WorkspaceGrepMatch>, WorkspaceFsError>;
  readonly writeFile: (
    path: string,
    content: WorkspaceWriteFileContent,
    options?: WorkspaceWriteFileOptions,
  ) => Effect.Effect<void, WorkspaceFsError>;
  readonly mkdir: (
    path: string,
    options?: WorkspaceMkdirOptions,
  ) => Effect.Effect<void, WorkspaceFsError>;
  readonly rm: (path: string, options?: RemovePathOptions) => Effect.Effect<void, WorkspaceFsError>;
  readonly chmod: (path: string, mode: number) => Effect.Effect<void, WorkspaceFsError>;
  readonly symlink: (target: string, path: string) => Effect.Effect<void, WorkspaceFsError>;
}

export type WorkspaceGitCloneOptions = CloudflareGitCloneOptions;
export type WorkspaceGitFetchOptions = CloudflareGitFetchOptions;
export type WorkspaceGitFetchResult = Awaited<ReturnType<CloudflareGitClient["fetch"]>>;
export type WorkspaceGitCheckoutOptions = Parameters<CloudflareGitClient["checkout"]>[0];
export type WorkspaceGitUpdateRefOptions = CloudflareGitUpdateRefOptions;
export type WorkspaceGitDiffOptions = CloudflareGitDiffOptions;
export type WorkspaceGitCommitOptions = CloudflareGitCommitOptions;

export interface WorkspaceGitLogOptions extends Omit<CloudflareGitLogOptions, "depth"> {
  readonly depth?: number;
  /** Consumer-port compatibility alias for `depth`. */
  readonly maxCount?: number;
}

export type WorkspaceGitPerson = CloudflareCommitView["author"] & {
  /** Consumer-port compatibility alias for `timestamp`. */
  readonly timestampSeconds: number;
};

export interface WorkspaceGitCommit {
  readonly oid: string;
  readonly message: string;
  readonly tree: string;
  readonly parent: ReadonlyArray<string>;
  /** Consumer-port compatibility alias for `parent`. */
  readonly parents: ReadonlyArray<string>;
  readonly author: WorkspaceGitPerson;
  readonly committer: WorkspaceGitPerson;
}

type EffectGitMethod<Method> = Method extends (...args: infer Args) => Promise<infer Success>
  ? (...args: Args) => Effect.Effect<Success, WorkspaceGitError>
  : never;

type EffectGitClient = {
  readonly [Name in keyof CloudflareGitClient]: EffectGitMethod<CloudflareGitClient[Name]>;
};

/** Complete Effect wrapper of the `@cloudflare/computer/git` client. */
export type ComputerWorkspaceGit = Omit<EffectGitClient, "log" | "revParse"> & {
  readonly log: (
    options?: WorkspaceGitLogOptions,
  ) => Effect.Effect<ReadonlyArray<WorkspaceGitCommit>, WorkspaceGitError>;
  readonly revParse: {
    (ref: string): Effect.Effect<string, WorkspaceGitError>;
    (
      options: Parameters<CloudflareGitClient["revParse"]>[0],
    ): Effect.Effect<string, WorkspaceGitError>;
  };
};

export type WorkspaceExecSignal = NonNullable<CloudflareRuntimeKillOptions["signal"]>;
export type WorkspaceRuntimeValue = CloudflareWorkspaceRuntimeValue;
export type WorkspaceExecEncoding = "utf8" | "binary";
export type WorkspaceExecSyncResult = CloudflareExecSyncResult;
export type WorkspaceExecSkippedEntry = CloudflareSkippedEntry;

type CloudflareEncoding<Encoding extends WorkspaceExecEncoding> = Encoding extends "utf8"
  ? "utf8"
  : undefined;

export type WorkspaceExecChunk<Encoding extends WorkspaceExecEncoding> = Encoding extends "utf8"
  ? string
  : Uint8Array;

export type WorkspaceExecOptions<Encoding extends WorkspaceExecEncoding = "utf8"> = Omit<
  CloudflareRuntimeExecOptions,
  "encoding" | "timeoutMs"
> & {
  readonly encoding?: Encoding;
  readonly timeoutMs?: number;
  /** Consumer-port compatibility alias for `timeoutMs`. */
  readonly timeoutMillis?: number;
};

export type WorkspaceGetExecOptions<Encoding extends WorkspaceExecEncoding = "utf8"> = Omit<
  CloudflareRuntimeGetOptions,
  "encoding"
> & {
  readonly encoding?: Encoding;
};

export type WorkspaceExecEvent<Encoding extends WorkspaceExecEncoding = "utf8"> =
  | ({
      readonly _tag: "Stdout";
      readonly id: string;
      readonly sequence: number;
      readonly chunk: WorkspaceExecChunk<Encoding>;
    } & (Encoding extends "utf8" ? { readonly text: string } : { readonly bytes: Uint8Array }))
  | ({
      readonly _tag: "Stderr";
      readonly id: string;
      readonly sequence: number;
      readonly chunk: WorkspaceExecChunk<Encoding>;
    } & (Encoding extends "utf8" ? { readonly text: string } : { readonly bytes: Uint8Array }))
  | {
      readonly _tag: "Exit";
      readonly id: string;
      readonly sequence: number;
      readonly exitCode: number;
      readonly value?: WorkspaceRuntimeValue;
    };

export interface WorkspaceExecResult<Encoding extends WorkspaceExecEncoding = "utf8"> {
  readonly status: CloudflareWorkspaceRuntimeResult<CloudflareEncoding<Encoding>>["status"];
  readonly exitCode: number;
  readonly stdout: WorkspaceExecChunk<Encoding>;
  readonly stderr: WorkspaceExecChunk<Encoding>;
  readonly value?: WorkspaceRuntimeValue;
  readonly pushed: number;
  readonly pulled: number;
  readonly skipped: ReadonlyArray<WorkspaceExecSkippedEntry>;
  readonly sync: WorkspaceExecSyncResult;
}

export interface WorkspaceExecRun<Encoding extends WorkspaceExecEncoding = "utf8"> {
  readonly id: string;
  readonly backend: string;
  /**
   * Live output. Like the upstream handle, `events` and `result` are mutually
   * exclusive consumers of a run.
   */
  readonly events: Stream.Stream<WorkspaceExecEvent<Encoding>, WorkspaceExecError>;
  readonly result: Effect.Effect<WorkspaceExecResult<Encoding>, WorkspaceExecError>;
  readonly kill: (signal?: WorkspaceExecSignal) => Effect.Effect<void, WorkspaceExecError>;
}

export interface WorkspaceExec {
  (
    strings: TemplateStringsArray,
    ...values: Array<CloudflareShellValue>
  ): Effect.Effect<WorkspaceExecRun<"utf8">, WorkspaceExecError, Scope.Scope>;
  (
    command: string,
    options?: WorkspaceExecOptions<"utf8">,
  ): Effect.Effect<WorkspaceExecRun<"utf8">, WorkspaceExecError, Scope.Scope>;
  (
    command: string,
    options: WorkspaceExecOptions<"binary">,
  ): Effect.Effect<WorkspaceExecRun<"binary">, WorkspaceExecError, Scope.Scope>;
}

export interface WorkspaceGetExec {
  (
    id: string,
    options?: WorkspaceGetExecOptions<"utf8">,
  ): Effect.Effect<WorkspaceExecRun<"utf8">, WorkspaceExecError, Scope.Scope>;
  (
    id: string,
    options: WorkspaceGetExecOptions<"binary">,
  ): Effect.Effect<WorkspaceExecRun<"binary">, WorkspaceExecError, Scope.Scope>;
}

export interface WorkspaceExecCollect {
  (
    strings: TemplateStringsArray,
    ...values: Array<CloudflareShellValue>
  ): Effect.Effect<WorkspaceExecResult<"utf8">, WorkspaceExecError>;
  (
    command: string,
    options?: WorkspaceExecOptions<"utf8">,
  ): Effect.Effect<WorkspaceExecResult<"utf8">, WorkspaceExecError>;
  (
    command: string,
    options: WorkspaceExecOptions<"binary">,
  ): Effect.Effect<WorkspaceExecResult<"binary">, WorkspaceExecError>;
}

export interface ComputerWorkspaceRuntime {
  readonly exec: WorkspaceExec;
  readonly execCollect: WorkspaceExecCollect;
  readonly getExec: WorkspaceGetExec;
  readonly killExec: (
    id: string,
    options?: CloudflareRuntimeKillOptions,
  ) => Effect.Effect<void, WorkspaceExecError>;
  readonly disposeExec: (
    id: string,
    options?: { readonly backend?: string },
  ) => Effect.Effect<void, WorkspaceExecError>;
}

export interface ComputerWorkspaceAssets {
  readonly share: (
    path: string,
    options: CloudflareComputerShareOptions,
  ) => Effect.Effect<string, WorkspaceAssetsError>;
}

type EffectThinkMethod<Method> = Method extends (...args: infer Args) => Promise<infer Success>
  ? (...args: Args) => Effect.Effect<Success, WorkspaceFsError>
  : never;

/** Effect wrapper of the optional Think compatibility surface. */
export type ComputerWorkspaceThink = {
  readonly [Name in keyof CloudflareThinkWorkspaceCompatibility]: EffectThinkMethod<
    CloudflareThinkWorkspaceCompatibility[Name]
  >;
};

export interface ComputerWorkspaceService {
  readonly fs: ComputerWorkspaceFilesystem;
  readonly git: ComputerWorkspaceGit;
  readonly runtime: ComputerWorkspaceRuntime;
  readonly artifacts: ComputerArtifacts.ComputerArtifactsClient;
  readonly assets: ComputerWorkspaceAssets | undefined;
  readonly think: ComputerWorkspaceThink | undefined;

  readonly readFile: WorkspaceReadFile;
  readonly stat: ComputerWorkspaceFilesystem["stat"];
  readonly lstat: ComputerWorkspaceFilesystem["lstat"];
  readonly exists: ComputerWorkspaceFilesystem["exists"];
  readonly readlink: ComputerWorkspaceFilesystem["readlink"];
  readonly readdir: ComputerWorkspaceFilesystem["readdir"];
  readonly listDirectory: ComputerWorkspaceFilesystem["readdir"];
  readonly find: ComputerWorkspaceFilesystem["find"];
  readonly ls: ComputerWorkspaceFilesystem["ls"];
  readonly grep: ComputerWorkspaceFilesystem["grep"];
  readonly writeFile: ComputerWorkspaceFilesystem["writeFile"];
  readonly mkdir: ComputerWorkspaceFilesystem["mkdir"];
  readonly rm: ComputerWorkspaceFilesystem["rm"];
  readonly removePath: ComputerWorkspaceFilesystem["rm"];
  readonly chmod: ComputerWorkspaceFilesystem["chmod"];
  readonly symlink: ComputerWorkspaceFilesystem["symlink"];

  readonly exec: WorkspaceExec;
  readonly execCollect: WorkspaceExecCollect;
  readonly getExec: WorkspaceGetExec;
  readonly killExec: ComputerWorkspaceRuntime["killExec"];
  readonly disposeExec: ComputerWorkspaceRuntime["disposeExec"];
}

export type { ComputerWorkspaceService as "ComputerWorkspaceShape" };

interface WorkspaceFsErrorProperties {
  operation: string;
  path: string;
  message: string;
  cause: unknown;
  code?: string;
}

interface WorkspaceOperationErrorProperties {
  operation: string;
  message: string;
  cause: unknown;
  code?: string;
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const errorCode = (cause: unknown): string | undefined => {
  if (Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code)) {
    return cause.code;
  }

  return undefined;
};

const fsError = (operation: string, path: string, cause: unknown) => {
  const properties: WorkspaceFsErrorProperties = {
    operation,
    path,
    message: errorMessage(cause),
    cause,
  };
  const code = errorCode(cause);

  if (code !== undefined) {
    properties.code = code;
  }

  return WorkspaceFsError.make(properties);
};

const gitError = (operation: string, cause: unknown) => {
  const properties: WorkspaceOperationErrorProperties = {
    operation,
    message: errorMessage(cause),
    cause,
  };
  const code = errorCode(cause);

  if (code !== undefined) {
    properties.code = code;
  }

  return WorkspaceGitError.make(properties);
};

const execError = (operation: string, cause: unknown) => {
  const properties: WorkspaceOperationErrorProperties = {
    operation,
    message: errorMessage(cause),
    cause,
  };
  const code = errorCode(cause);

  if (code !== undefined) {
    properties.code = code;
  }

  return WorkspaceExecError.make(properties);
};

const assetsError = (operation: string, path: string, cause: unknown) => {
  const properties: WorkspaceFsErrorProperties = {
    operation,
    path,
    message: errorMessage(cause),
    cause,
  };
  const code = errorCode(cause);

  if (code !== undefined) {
    properties.code = code;
  }

  return WorkspaceAssetsError.make(properties);
};

const tryFs = <A>(operation: string, path: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => fsError(operation, path, cause),
  });

const isNotFound = (error: WorkspaceFsError): boolean =>
  error.code === "ENOENT" || /ENOENT|no such/i.test(error.message);

const makeFilesystem = (fsClient: CloudflareWorkspaceFilesystem): ComputerWorkspaceFilesystem => {
  const readFileImplementation = Effect.fn("ComputerWorkspace.fs.readFile", {
    attributes: { family: "fs", operation: "readFile" },
  })(function* (
    path: string,
    options: WorkspaceReadFileOptions & { readonly encoding?: WorkspaceReadEncoding } = {},
  ) {
    yield* Effect.annotateCurrentSpan("path", path);

    const { encoding = "utf8", ...readOptions } = options;

    if (encoding === "stream") {
      return yield* tryFs("readFile", path, () => fsClient.readFile(path, readOptions));
    }

    return yield* tryFs("readFile", path, () =>
      fsClient.readFile(path, { ...readOptions, encoding: "utf8" }),
    );
  });

  // SAFETY: the implementation branches on the declared encoding discriminant and returns the
  // corresponding Cloudflare read result for both overloads.
  const readFile = readFileImplementation as WorkspaceReadFile;

  const stat = Effect.fn("ComputerWorkspace.fs.stat", {
    attributes: { family: "fs", operation: "stat" },
  })(function* (path: string) {
    yield* Effect.annotateCurrentSpan("path", path);

    return yield* tryFs("stat", path, () => fsClient.stat(path));
  });

  const lstat = Effect.fn("ComputerWorkspace.fs.lstat", {
    attributes: { family: "fs", operation: "lstat" },
  })(function* (path: string) {
    yield* Effect.annotateCurrentSpan("path", path);

    return yield* tryFs("lstat", path, () => fsClient.lstat(path));
  });

  const exists = Effect.fn("ComputerWorkspace.fs.exists", {
    attributes: { family: "fs", operation: "exists" },
  })(function* (path: string) {
    yield* Effect.annotateCurrentSpan("path", path);

    return yield* stat(path).pipe(
      Effect.as(true),
      Effect.catch((error) => (isNotFound(error) ? Effect.succeed(false) : Effect.fail(error))),
    );
  });

  const readlink = Effect.fn("ComputerWorkspace.fs.readlink", {
    attributes: { family: "fs", operation: "readlink" },
  })(function* (path: string) {
    yield* Effect.annotateCurrentSpan("path", path);

    return yield* tryFs("readlink", path, () => fsClient.readlink(path));
  });

  const readdir = Effect.fn("ComputerWorkspace.fs.readdir", {
    attributes: { family: "fs", operation: "readdir" },
  })(function* (path: string, options?: ListDirectoryOptions) {
    yield* Effect.annotateCurrentSpan("path", path);

    return yield* tryFs("readdir", path, () => fsClient.readdir(path, options));
  });

  const find = Effect.fn("ComputerWorkspace.fs.find", {
    attributes: { family: "fs", operation: "find" },
  })(function* (directory: string, pattern?: string, options?: WorkspaceFindOptions) {
    yield* Effect.annotateCurrentSpan({ path: directory, pattern });

    return yield* tryFs("find", directory, () => fsClient.find(directory, pattern, options));
  });

  const ls = Effect.fn("ComputerWorkspace.fs.ls", {
    attributes: { family: "fs", operation: "ls" },
  })(function* (prefix: string) {
    yield* Effect.annotateCurrentSpan("path", prefix);

    return yield* tryFs("ls", prefix, () => fsClient.ls(prefix));
  });

  const grep = Effect.fn("ComputerWorkspace.fs.grep", {
    attributes: { family: "fs", operation: "grep" },
  })(function* (pattern: string, path: string, options?: WorkspaceGrepOptions) {
    yield* Effect.annotateCurrentSpan({ path, pattern });

    return yield* tryFs("grep", path, () => fsClient.grep(pattern, path, options));
  });

  const writeFile = Effect.fn("ComputerWorkspace.fs.writeFile", {
    attributes: { family: "fs", operation: "writeFile" },
  })(function* (
    path: string,
    content: WorkspaceWriteFileContent,
    options?: WorkspaceWriteFileOptions,
  ) {
    yield* Effect.annotateCurrentSpan("path", path);
    yield* tryFs("writeFile", path, () => fsClient.writeFile(path, content, options));
  });

  const mkdir = Effect.fn("ComputerWorkspace.fs.mkdir", {
    attributes: { family: "fs", operation: "mkdir" },
  })(function* (path: string, options?: WorkspaceMkdirOptions) {
    yield* Effect.annotateCurrentSpan("path", path);
    yield* tryFs("mkdir", path, () => fsClient.mkdir(path, options));
  });

  const rm = Effect.fn("ComputerWorkspace.fs.rm", {
    attributes: { family: "fs", operation: "rm" },
  })(function* (path: string, options?: RemovePathOptions) {
    yield* Effect.annotateCurrentSpan("path", path);
    yield* tryFs("rm", path, () => fsClient.rm(path, options));
  });

  const chmod = Effect.fn("ComputerWorkspace.fs.chmod", {
    attributes: { family: "fs", operation: "chmod" },
  })(function* (path: string, mode: number) {
    yield* Effect.annotateCurrentSpan({ path, mode });
    yield* tryFs("chmod", path, () => fsClient.chmod(path, mode));
  });

  const symlink = Effect.fn("ComputerWorkspace.fs.symlink", {
    attributes: { family: "fs", operation: "symlink" },
  })(function* (target: string, path: string) {
    yield* Effect.annotateCurrentSpan({ path, target });
    yield* tryFs("symlink", path, () => fsClient.symlink(target, path));
  });

  return {
    readFile,
    stat,
    lstat,
    exists,
    readlink,
    readdir,
    find,
    ls,
    grep,
    writeFile,
    mkdir,
    rm,
    chmod,
    symlink,
  };
};

const gitPerson = (person: CloudflareCommitView["author"]): WorkspaceGitPerson => ({
  ...person,
  timestampSeconds: person.timestamp,
});

const gitCommit = (
  commit: Awaited<ReturnType<CloudflareGitClient["show"]>>,
): WorkspaceGitCommit => ({
  oid: commit.oid,
  message: commit.message,
  tree: commit.tree,
  parent: commit.parent,
  parents: commit.parent,
  author: gitPerson(commit.author),
  committer: gitPerson(commit.committer),
});

const makeGit = (gitClient: CloudflareGitClient): ComputerWorkspaceGit => {
  const method = <Args extends Array<unknown>, Success>(
    operation: string,
    evaluate: (...args: Args) => Promise<Success>,
  ) =>
    Effect.fn(`ComputerWorkspace.git.${operation}`, {
      attributes: { family: "git", operation },
    })(function* (...args: Args) {
      return yield* Effect.tryPromise({
        try: () => evaluate(...args),
        catch: (cause) => gitError(operation, cause),
      });
    });

  const log = Effect.fn("ComputerWorkspace.git.log", {
    attributes: { family: "git", operation: "log" },
  })(function* (options?: WorkspaceGitLogOptions) {
    const { maxCount, ...upstreamOptions } = options ?? {};
    const logOptions: CloudflareGitLogOptions = { ...upstreamOptions };

    if (logOptions.depth === undefined && maxCount !== undefined) {
      logOptions.depth = maxCount;
    }

    const commits = yield* Effect.tryPromise({
      try: () => gitClient.log(logOptions),
      catch: (cause) => gitError("log", cause),
    });

    return commits.map(gitCommit);
  });

  const revParseImplementation = Effect.fn("ComputerWorkspace.git.revParse", {
    attributes: { family: "git", operation: "revParse" },
  })(function* (input: string | Parameters<CloudflareGitClient["revParse"]>[0]) {
    const options = Predicate.isString(input) ? { ref: input } : input;

    return yield* Effect.tryPromise({
      try: () => gitClient.revParse(options),
      catch: (cause) => gitError("revParse", cause),
    });
  });

  // SAFETY: the implementation normalizes the string overload to the exact options object accepted
  // by Cloudflare and forwards the options overload unchanged.
  const revParse = revParseImplementation as ComputerWorkspaceGit["revParse"];

  return {
    clone: method("clone", (options: CloudflareGitCloneOptions) => gitClient.clone(options)),
    diff: method("diff", (options?: CloudflareGitDiffOptions) => gitClient.diff(options)),
    diffSummary: method("diffSummary", (options?: CloudflareGitDiffOptions) =>
      gitClient.diffSummary(options),
    ),
    init: method("init", (options) => gitClient.init(options)),
    status: method("status", (options) => gitClient.status(options)),
    add: method("add", (options) => gitClient.add(options)),
    rm: method("rm", (options) => gitClient.rm(options)),
    commit: method("commit", (options: CloudflareGitCommitOptions) => gitClient.commit(options)),
    log,
    show: method("show", (options) => gitClient.show(options)),
    revParse,
    repoRoot: method("repoRoot", (options) => gitClient.repoRoot(options)),
    currentBranch: method("currentBranch", (options) => gitClient.currentBranch(options)),
    lsFiles: method("lsFiles", (options) => gitClient.lsFiles(options)),
    lsTree: method("lsTree", (options) => gitClient.lsTree(options)),
    branch: method("branch", (options) => gitClient.branch(options)),
    branchDelete: method("branchDelete", (options) => gitClient.branchDelete(options)),
    branchList: method("branchList", (options) => gitClient.branchList(options)),
    tag: method("tag", (options) => gitClient.tag(options)),
    tagDelete: method("tagDelete", (options) => gitClient.tagDelete(options)),
    tagList: method("tagList", (options) => gitClient.tagList(options)),
    checkout: method("checkout", (options) => gitClient.checkout(options)),
    fetch: method("fetch", (options?: CloudflareGitFetchOptions) => gitClient.fetch(options)),
    push: method("push", (options) => gitClient.push(options)),
    pull: method("pull", (options) => gitClient.pull(options)),
    merge: method("merge", (options) => gitClient.merge(options)),
    remoteAdd: method("remoteAdd", (options) => gitClient.remoteAdd(options)),
    remoteRemove: method("remoteRemove", (options) => gitClient.remoteRemove(options)),
    remoteList: method("remoteList", (options) => gitClient.remoteList(options)),
    hashObject: method("hashObject", (options) => gitClient.hashObject(options)),
    catFile: method("catFile", (options) => gitClient.catFile(options)),
    updateRef: method("updateRef", (options: CloudflareGitUpdateRefOptions) =>
      gitClient.updateRef(options),
    ),
    configGet: method("configGet", (options) => gitClient.configGet(options)),
    configSet: method("configSet", (options) => gitClient.configSet(options)),
    stashPush: method("stashPush", (options) => gitClient.stashPush(options)),
    stashList: method("stashList", (options) => gitClient.stashList(options)),
    stashPop: method("stashPop", (options) => gitClient.stashPop(options)),
    reset: method("reset", (options) => gitClient.reset(options)),
    clean: method("clean", (options) => gitClient.clean(options)),
    cli: method("cli", (input) => gitClient.cli(input)),
  } satisfies ComputerWorkspaceGit;
};

const runtimeExecOptions = <Encoding extends WorkspaceExecEncoding>(
  options?: WorkspaceExecOptions<Encoding>,
): CloudflareRuntimeExecOptions => {
  const { encoding = "utf8", timeoutMillis, timeoutMs, ...rest } = options ?? {};

  const runtimeOptions: CloudflareRuntimeExecOptions = { ...rest };

  if (encoding === "utf8") {
    runtimeOptions.encoding = "utf8";
  }

  const selectedTimeout = timeoutMs ?? timeoutMillis;

  if (selectedTimeout !== undefined) {
    runtimeOptions.timeoutMs = selectedTimeout;
  }

  return runtimeOptions;
};

const runtimeGetOptions = <Encoding extends WorkspaceExecEncoding>(
  options?: WorkspaceGetExecOptions<Encoding>,
): CloudflareRuntimeGetOptions => {
  const { encoding = "utf8", ...rest } = options ?? {};

  const runtimeOptions: CloudflareRuntimeGetOptions = { ...rest };

  if (encoding === "utf8") {
    runtimeOptions.encoding = "utf8";
  }

  return runtimeOptions;
};

const wrapRuntimeResult = <Encoding extends WorkspaceExecEncoding>(
  result: CloudflareWorkspaceRuntimeResult<CloudflareEncoding<Encoding>>,
): WorkspaceExecResult<Encoding> => {
  // SAFETY: Cloudflare's result encoding generic determines stdout and stderr in the same way as
  // WorkspaceExecChunk; CloudflareEncoding maps the public "binary" name to upstream undefined.
  const stdout = result.stdout as WorkspaceExecChunk<Encoding>;
  // SAFETY: the same encoding invariant applies independently to stderr.
  const stderr = result.stderr as WorkspaceExecChunk<Encoding>;
  const wrapped = {
    status: result.status,
    exitCode: result.exitCode,
    stdout,
    stderr,
    pushed: result.pushed,
    pulled: result.pulled,
    skipped: result.skipped,
    sync: result.sync,
  };

  return result.value === undefined ? wrapped : { ...wrapped, value: result.value };
};

type AnyWorkspaceExecEvent = WorkspaceExecEvent<"utf8"> | WorkspaceExecEvent<"binary">;

const wrapRuntimeEvent = (
  event: CloudflareWorkspaceRuntimeEvent<"utf8" | undefined>,
): AnyWorkspaceExecEvent => {
  switch (event.name) {
    case "stdout": {
      const chunk = event.value;

      return Predicate.isString(chunk)
        ? { _tag: "Stdout", id: event.id, sequence: event.seq, chunk, text: chunk }
        : {
            _tag: "Stdout",
            id: event.id,
            sequence: event.seq,
            chunk,
            bytes: chunk,
          };
    }
    case "stderr": {
      const chunk = event.value;

      return Predicate.isString(chunk)
        ? { _tag: "Stderr", id: event.id, sequence: event.seq, chunk, text: chunk }
        : {
            _tag: "Stderr",
            id: event.id,
            sequence: event.seq,
            chunk,
            bytes: chunk,
          };
    }
    case "exit":
      const exitEvent = {
        _tag: "Exit" as const,
        id: event.id,
        sequence: event.seq,
        exitCode: event.code,
      };

      return event.result === undefined ? exitEvent : { ...exitEvent, value: event.result };
  }
};

const wrapRun = <Encoding extends WorkspaceExecEncoding>(
  handle: CloudflareWorkspaceRuntimeExecHandle<CloudflareEncoding<Encoding>>,
): WorkspaceExecRun<Encoding> => {
  // SAFETY: wrapRuntimeEvent preserves Cloudflare's encoding-specific event arm; this adapter
  // restores the correlation hidden when the implementation handles both upstream encodings.
  const mapRuntimeEvent = wrapRuntimeEvent as (
    event: CloudflareWorkspaceRuntimeEvent<CloudflareEncoding<Encoding>>,
  ) => WorkspaceExecEvent<Encoding>;
  const events = Stream.fromReadableStream<
    CloudflareWorkspaceRuntimeEvent<CloudflareEncoding<Encoding>>,
    WorkspaceExecError
  >({
    evaluate: () => handle,
    onError: (cause) => execError("events", cause),
  }).pipe(Stream.map(mapRuntimeEvent));

  const result = Effect.tryPromise({
    try: () => handle.result(),
    catch: (cause) => execError("result", cause),
  }).pipe(Effect.map(wrapRuntimeResult<Encoding>));

  const kill = Effect.fn("ComputerWorkspace.runtime.run.kill", {
    attributes: { family: "runtime", operation: "run.kill", runId: handle.id },
  })(function* (signal?: WorkspaceExecSignal) {
    yield* Effect.tryPromise({
      try: () => handle.kill(signal),
      catch: (cause) => execError("run.kill", cause),
    });
  });

  return { id: handle.id, backend: handle.backend, events, result, kill };
};

const releaseRun = (handle: CloudflareWorkspaceRuntimeExecHandle<"utf8" | undefined>) =>
  Effect.sync(() => handle[Symbol.dispose]());

const makeRuntime = (client: CloudflareWorkspaceClient): ComputerWorkspaceRuntime => {
  const execImplementation = Effect.fn("ComputerWorkspace.runtime.exec", {
    attributes: { family: "runtime", operation: "exec" },
  })(function* <Encoding extends WorkspaceExecEncoding = "utf8">(
    source: string | TemplateStringsArray,
    optionsOrValue?: WorkspaceExecOptions<Encoding> | CloudflareShellValue,
    ...remainingValues: Array<CloudflareShellValue>
  ) {
    // SAFETY: the WorkspaceExec overload associates string sources with an options object; template
    // invocations associate the second argument with a shell interpolation value.
    const options = Predicate.isString(source)
      ? (optionsOrValue as WorkspaceExecOptions<Encoding> | undefined)
      : undefined;

    yield* Effect.annotateCurrentSpan({ backend: options?.backend, runId: options?.id });
    const handle = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => {
          if (Predicate.isString(source)) {
            return client.runtime.exec(source, runtimeExecOptions(options));
          }

          const values =
            optionsOrValue === undefined
              ? remainingValues
              : [
                  // SAFETY: this branch is reachable only for the tagged-template overload, whose
                  // second argument is the first Cloudflare shell interpolation value.
                  optionsOrValue as CloudflareShellValue,
                  ...remainingValues,
                ];

          return client.runtime.exec(source, ...values);
        },
        catch: (cause) => execError("exec", cause),
      }),
      releaseRun,
    );

    // SAFETY: runtimeExecOptions carries Encoding to Cloudflare's corresponding handle overload.
    return wrapRun<Encoding>(
      handle as CloudflareWorkspaceRuntimeExecHandle<CloudflareEncoding<Encoding>>,
    );
  });
  // SAFETY: execImplementation implements each overload by preserving the source/encoding
  // relationship and delegates tagged-template inputs to Cloudflare's tagged-template overload.
  const exec = execImplementation as WorkspaceExec;

  const getExecImplementation = Effect.fn("ComputerWorkspace.runtime.getExec", {
    attributes: { family: "runtime", operation: "getExec" },
  })(function* <Encoding extends WorkspaceExecEncoding = "utf8">(
    id: string,
    options?: WorkspaceGetExecOptions<Encoding>,
  ) {
    yield* Effect.annotateCurrentSpan({ backend: options?.backend, runId: id });
    const handle = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => client.runtime.getExec(id, runtimeGetOptions(options)),
        catch: (cause) => execError("getExec", cause),
      }),
      releaseRun,
    );

    // SAFETY: runtimeGetOptions carries Encoding to Cloudflare's corresponding handle overload.
    return wrapRun<Encoding>(
      handle as CloudflareWorkspaceRuntimeExecHandle<CloudflareEncoding<Encoding>>,
    );
  });
  // SAFETY: getExecImplementation preserves the option encoding and therefore satisfies each
  // WorkspaceGetExec overload.
  const getExec = getExecImplementation as WorkspaceGetExec;

  const killExec = Effect.fn("ComputerWorkspace.runtime.killExec", {
    attributes: { family: "runtime", operation: "killExec" },
  })(function* (id: string, options?: CloudflareRuntimeKillOptions) {
    yield* Effect.annotateCurrentSpan({ backend: options?.backend, runId: id });
    yield* Effect.tryPromise({
      try: () => client.runtime.killExec(id, options),
      catch: (cause) => execError("killExec", cause),
    });
  });

  const disposeExec = Effect.fn("ComputerWorkspace.runtime.disposeExec", {
    attributes: { family: "runtime", operation: "disposeExec" },
  })(function* (id: string, options?: { readonly backend?: string }) {
    yield* Effect.annotateCurrentSpan({ backend: options?.backend, runId: id });
    yield* Effect.tryPromise({
      try: () => client.runtime.disposeExec(id, options),
      catch: (cause) => execError("disposeExec", cause),
    });
  });

  const execCollectImplementation = Effect.fn("ComputerWorkspace.runtime.execCollect", {
    attributes: { family: "runtime", operation: "execCollect" },
  })(function* <Encoding extends WorkspaceExecEncoding = "utf8">(
    source: string | TemplateStringsArray,
    optionsOrValue?: WorkspaceExecOptions<Encoding> | CloudflareShellValue,
    ...remainingValues: Array<CloudflareShellValue>
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const run = yield* execImplementation(source, optionsOrValue, ...remainingValues);

        return yield* run.result;
      }),
    );
  });
  // SAFETY: execCollectImplementation delegates to the checked exec overload implementation and
  // returns the result associated with that same encoding.
  const execCollect = execCollectImplementation as WorkspaceExecCollect;

  return { exec, execCollect, getExec, killExec, disposeExec };
};

const makeAssets = (
  client: CloudflareComputerAssetsClient | undefined,
): ComputerWorkspaceAssets | undefined =>
  client === undefined
    ? undefined
    : {
        share: Effect.fn("ComputerWorkspace.assets.share", {
          attributes: { family: "assets", operation: "share" },
        })(function* (path: string, options: CloudflareComputerShareOptions) {
          yield* Effect.annotateCurrentSpan("path", path);

          return yield* Effect.tryPromise({
            try: () => client.share(path, options),
            catch: (cause) => assetsError("share", path, cause),
          });
        }),
      };

const makeThink = (client: CloudflareWorkspaceClient): ComputerWorkspaceThink | undefined => {
  if (
    client.readFile === undefined ||
    client.readFileBytes === undefined ||
    client.writeFile === undefined ||
    client.readDir === undefined ||
    client.rm === undefined ||
    client.glob === undefined ||
    client.mkdir === undefined ||
    client.stat === undefined
  ) {
    return undefined;
  }

  const method = <Args extends Array<unknown>, Success>(
    operation: string,
    pathOf: (...args: Args) => string,
    evaluate: (...args: Args) => Promise<Success>,
  ) =>
    Effect.fn(`ComputerWorkspace.think.${operation}`, {
      attributes: { family: "think", operation },
    })(function* (...args: Args) {
      const path = pathOf(...args);

      yield* Effect.annotateCurrentSpan("path", path);

      return yield* tryFs(`think.${operation}`, path, () => evaluate(...args));
    });

  const readFile = client.readFile.bind(client);
  const readFileBytes = client.readFileBytes.bind(client);
  const writeFile = client.writeFile.bind(client);
  const readDir = client.readDir.bind(client);
  const rm = client.rm.bind(client);
  const glob = client.glob.bind(client);
  const mkdir = client.mkdir.bind(client);
  const stat = client.stat.bind(client);

  return {
    readFile: method(
      "readFile",
      (path: string) => path,
      (path: string) => readFile(path),
    ),
    readFileBytes: method(
      "readFileBytes",
      (path: string) => path,
      (path: string) => readFileBytes(path),
    ),
    writeFile: method(
      "writeFile",
      (path: string, _content: string) => path,
      (path: string, content: string) => writeFile(path, content),
    ),
    readDir: method(
      "readDir",
      (path: string, _options?: { readonly limit?: number; readonly offset?: number }) => path,
      (path: string, options?: { readonly limit?: number; readonly offset?: number }) =>
        readDir(path, options),
    ),
    rm: method(
      "rm",
      (path: string, _options?: { readonly recursive?: boolean; readonly force?: boolean }) => path,
      (path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }) =>
        rm(path, options),
    ),
    glob: method(
      "glob",
      (pattern: string) => pattern,
      (pattern: string) => glob(pattern),
    ),
    mkdir: method(
      "mkdir",
      (path: string, _options?: { readonly recursive?: boolean }) => path,
      (path: string, options?: { readonly recursive?: boolean }) => mkdir(path, options),
    ),
    stat: method(
      "stat",
      (path: string) => path,
      (path: string) => stat(path),
    ),
  } satisfies ComputerWorkspaceThink;
};

/**
 * Wraps a client whose lifetime is owned by the caller. Prefer
 * {@link ComputerWorkspace.layer} in Durable Objects so the parent client and
 * every runtime handle are disposed by Effect `Scope`.
 */
export const fromWorkspaceClient = (
  client: CloudflareWorkspaceClient,
): ComputerWorkspaceService => {
  const fs = makeFilesystem(client.fs);
  // SAFETY: @cloudflare/computer currently publishes these WorkspaceClient properties as `any`,
  // while its runtime exposes the concrete clients imported above.
  const git = makeGit(client.git as CloudflareGitClient);
  const runtime = makeRuntime(client);
  const artifacts = ComputerArtifacts.fromClient(
    // SAFETY: the upstream WorkspaceClient declaration erases this concrete artifact client to
    // `any`; Workspace always exposes its ArtifactClient here.
    client.artifacts as CloudflareComputerArtifactClient,
    { binding: "ComputerWorkspace.artifacts" },
  );
  // SAFETY: the upstream WorkspaceClient declaration erases this optional concrete assets client
  // to `any`; Workspace exposes AssetsClient | undefined here.
  const assets = makeAssets(client.assets as CloudflareComputerAssetsClient | undefined);
  const think = makeThink(client);

  return {
    fs,
    git,
    runtime,
    artifacts,
    assets,
    think,
    readFile: fs.readFile,
    stat: fs.stat,
    lstat: fs.lstat,
    exists: fs.exists,
    readlink: fs.readlink,
    readdir: fs.readdir,
    listDirectory: fs.readdir,
    find: fs.find,
    ls: fs.ls,
    grep: fs.grep,
    writeFile: fs.writeFile,
    mkdir: fs.mkdir,
    rm: fs.rm,
    removePath: fs.rm,
    chmod: fs.chmod,
    symlink: fs.symlink,
    exec: runtime.exec,
    execCollect: runtime.execCollect,
    getExec: runtime.getExec,
    killExec: runtime.killExec,
    disposeExec: runtime.disposeExec,
  };
};

export class ComputerWorkspace extends Context.Service<
  ComputerWorkspace,
  ComputerWorkspaceService
>()("effect-cf/ComputerWorkspace") {
  /**
   * Acquires the single workspace registered by `withComputerWorkspace` and
   * releases its RPC client when the layer scope closes.
   */
  static readonly layer: Layer.Layer<ComputerWorkspace, never, DurableObjectState> = Layer.effect(
    ComputerWorkspace,
    Effect.gen(function* () {
      const state = yield* DurableObjectState;
      const host = HostRegistry.lookup(state.raw);

      if (host === undefined) {
        return yield* Effect.die(
          "ComputerWorkspace.layer requires a Durable Object class built with withComputerWorkspace",
        );
      }

      const computer = yield* Effect.promise(() => import("@cloudflare/computer"));
      const client = yield* Effect.acquireRelease(
        Effect.promise(() => computer.getWorkspace(host)),
        (workspace) => Effect.sync(() => workspace[Symbol.dispose]()),
      );

      return ComputerWorkspace.of(fromWorkspaceClient(client));
    }),
  );
}
