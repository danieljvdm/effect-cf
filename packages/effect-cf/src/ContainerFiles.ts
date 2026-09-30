import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { ContainerError } from "./DurableObjectContainer";

export type FileContent =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | ReadableStream<Uint8Array>;
export type FileType =
  | "file"
  | "directory"
  | "symlink"
  | "blockDevice"
  | "characterDevice"
  | "fifo"
  | "socket";

export interface FileOperationOptions {
  readonly cwd?: string;
  readonly user?: string;
}

export interface MkdirOptions extends FileOperationOptions {
  readonly recursive?: boolean;
}

export interface RemoveOptions extends FileOperationOptions {
  readonly recursive?: boolean;
  readonly force?: boolean;
}

export interface FileStat {
  readonly type: FileType;
  readonly size: bigint;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly accessedAt: Date;
  readonly modifiedAt: Date;
  readonly changedAt: Date;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly type: FileType;
}

type WithSignal<A> = A & { readonly signal?: AbortSignal };

/** Structural contract of Sandbox SDK 1.x `Files`, without loading an SDK version. */
export interface FilesResource {
  readFile(path: string, options?: WithSignal<FileOperationOptions>): Promise<Response>;
  writeFile(
    path: string,
    content: FileContent,
    options?: WithSignal<FileOperationOptions>,
  ): Promise<void>;
  stat(path: string, options?: WithSignal<FileOperationOptions>): Promise<FileStat>;
  lstat(path: string, options?: WithSignal<FileOperationOptions>): Promise<FileStat>;
  readDirectory(
    path: string,
    options?: WithSignal<FileOperationOptions>,
  ): Promise<ReadonlyArray<DirectoryEntry>>;
  mkdir(path: string, options?: WithSignal<MkdirOptions>): Promise<void>;
  rename(
    source: string,
    destination: string,
    options?: WithSignal<FileOperationOptions>,
  ): Promise<void>;
  remove(path: string, options?: WithSignal<RemoveOptions>): Promise<void>;
}

export interface ContainerFiles {
  readonly raw: FilesResource;
  /** The caller consumes or cancels the response body. Late failures retain native SDK errors. */
  readonly readFile: (
    path: string,
    options?: FileOperationOptions,
  ) => Effect.Effect<Response, ContainerError>;
  /** Includes failures that arrive while reading the response body. */
  readonly readFileStream: (
    path: string,
    options?: FileOperationOptions,
  ) => Stream.Stream<Uint8Array, ContainerError>;
  readonly readFileString: (
    path: string,
    options?: FileOperationOptions,
  ) => Effect.Effect<string, ContainerError>;
  readonly writeFile: (
    path: string,
    content: FileContent,
    options?: FileOperationOptions,
  ) => Effect.Effect<void, ContainerError>;
  readonly stat: (
    path: string,
    options?: FileOperationOptions,
  ) => Effect.Effect<FileStat, ContainerError>;
  readonly lstat: (
    path: string,
    options?: FileOperationOptions,
  ) => Effect.Effect<FileStat, ContainerError>;
  readonly readDirectory: (
    path: string,
    options?: FileOperationOptions,
  ) => Effect.Effect<ReadonlyArray<DirectoryEntry>, ContainerError>;
  readonly mkdir: (path: string, options?: MkdirOptions) => Effect.Effect<void, ContainerError>;
  readonly rename: (
    source: string,
    destination: string,
    options?: FileOperationOptions,
  ) => Effect.Effect<void, ContainerError>;
  readonly remove: (path: string, options?: RemoveOptions) => Effect.Effect<void, ContainerError>;
}

const attempt = <A>(operation: string, evaluate: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new ContainerError({ operation: `files.${operation}`, cause }),
  });

/** Pass `new Files(container.raw)` from SDK 1.x. The image must supply its matching sandbox-shim. */
export const fromFiles = (files: FilesResource): ContainerFiles => {
  const readFile = (path: string, options?: FileOperationOptions) =>
    attempt("readFile", (signal) => files.readFile(path, { ...options, signal }));
  const readFileStream = (path: string, options?: FileOperationOptions) =>
    Stream.unwrap(
      Effect.map(readFile(path, options), (response) => {
        const body = response.body;

        return body === null
          ? Stream.empty
          : Stream.fromReadableStream({
              evaluate: () => body,
              onError: (cause) => new ContainerError({ operation: "files.readFile", cause }),
            });
      }),
    );

  return {
    raw: files,
    readFile,
    readFileStream,
    readFileString: (path, options) =>
      readFileStream(path, options).pipe(Stream.decodeText(), Stream.mkString),
    writeFile: (path, content, options) =>
      attempt("writeFile", (signal) => files.writeFile(path, content, { ...options, signal })),
    stat: (path, options) => attempt("stat", (signal) => files.stat(path, { ...options, signal })),
    lstat: (path, options) =>
      attempt("lstat", (signal) => files.lstat(path, { ...options, signal })),
    readDirectory: (path, options) =>
      attempt("readDirectory", (signal) => files.readDirectory(path, { ...options, signal })),
    mkdir: (path, options) =>
      attempt("mkdir", (signal) => files.mkdir(path, { ...options, signal })),
    rename: (source, destination, options) =>
      attempt("rename", (signal) => files.rename(source, destination, { ...options, signal })),
    remove: (path, options) =>
      attempt("remove", (signal) => files.remove(path, { ...options, signal })),
  };
};
