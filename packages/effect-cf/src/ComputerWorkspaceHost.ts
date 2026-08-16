import { createGitClient, type GitClientFactory } from "@cloudflare/computer/git";
import {
  type DurableObjectStorageLike,
  type WithWorkspaceCtor,
  type WorkspaceHandle,
  type WorkspaceObserver,
  type WorkspaceOptions,
  type WorkspaceRegisteredBackend,
  type WorkspaceRetryPendingSyncResult,
  type WorkspaceSpan,
  type WorkspaceAttributes,
  type WorkspaceAttributeValue,
  type SyncRetryIntent,
  type SyncRetryOptions,
  type SyncRetryScheduler,
  withWorkspace,
} from "@cloudflare/computer";
import {
  WorkerShellBackend,
  type ShellModuleGroup,
  type WorkerShellBackendOptions,
  type WorkerShellLoader,
  type WorkspaceEgressPolicy,
} from "@cloudflare/computer/backends/worker-shell";

import type * as Artifacts from "./Artifacts";
import * as HostRegistry from "./internal/ComputerWorkspaceHostRegistry";

/**
 * The worker-shell backend resolves this exact export through
 * `ctx.exports.WorkspaceServiceProxy`. Every Worker that configures
 * {@link withComputerWorkspace} with `shell` must re-export it from its main
 * module.
 */
export { WorkspaceServiceProxy } from "@cloudflare/computer";

export type {
  ShellModuleGroup,
  SyncRetryIntent,
  SyncRetryOptions,
  SyncRetryScheduler,
  WorkspaceAttributeValue,
  WorkspaceAttributes,
  WorkspaceEgressPolicy,
  WorkspaceObserver,
  WorkspaceRetryPendingSyncResult,
  WorkspaceSpan,
};

/** The value of a `worker_loaders` binding. */
export type DynamicWorkerLoader = WorkerShellLoader;

/** Default author and committer identity for workspace Git operations. */
export interface ComputerWorkspaceGitIdentity {
  readonly name: string;
  readonly email: string;
}

/** Session-scoped Artifacts configuration passed through to `Workspace`. */
export interface ComputerWorkspaceArtifactsOptions {
  readonly binding: Artifacts.ArtifactsBinding;
  /**
   * Session prefix for repository names. When omitted, `sessionId` from the
   * enclosing host configuration is used.
   */
  readonly sessionId?: string;
}

/**
 * Worker-shell backend options with the loopback workspace wiring named in
 * Durable Object terms.
 */
export interface ComputerWorkspaceShellOptions extends Omit<
  WorkerShellBackendOptions,
  "source" | "loader" | "workspace" | "ctx" | "egress"
> {
  readonly loader: DynamicWorkerLoader;
  /** Durable Object namespace binding that points back to the wrapped class. */
  readonly hostBinding: string;
  /** Current Durable Object id, normally `ctx.id.toString()`. */
  readonly hostId: string;
  /** Current Durable Object execution context, normally `ctx`. */
  readonly executionContext: unknown;
  /** Dynamic Worker egress policy. Defaults to `{ mode: "none" }`. */
  readonly egress?: WorkspaceEgressPolicy;
}

/** Configuration accepted by {@link withComputerWorkspace}. */
export interface ComputerWorkspaceHostConfig {
  /** Native SQLite-backed Durable Object storage (`ctx.storage`). */
  readonly storage: globalThis.DurableObjectStorage | DurableObjectStorageLike;
  /** Stable workspace id used by mounts and as the default Artifacts session. */
  readonly sessionId?: string;
  readonly gitIdentity?: ComputerWorkspaceGitIdentity;
  /** Override the default `createGitClient()` factory. */
  readonly git?: GitClientFactory;
  /** Additional container, Worker JavaScript, shell, or custom backends. */
  readonly backends?: ReadonlyArray<WorkspaceRegisteredBackend>;
  /** Convenience wiring for one Worker Shell backend. */
  readonly shell?: ComputerWorkspaceShellOptions;
  readonly mounts?: WorkspaceOptions["mounts"];
  readonly observer?: WorkspaceOptions["observer"];
  readonly retryScheduler?: WorkspaceOptions["retryScheduler"];
  readonly retry?: WorkspaceOptions["retry"];
  readonly assets?: WorkspaceOptions["assets"];
  readonly artifacts?: ComputerWorkspaceArtifactsOptions;
  readonly now?: WorkspaceOptions["now"];
  readonly useThink?: WorkspaceOptions["useThink"];
}

const toWorkspaceOptions = (config: ComputerWorkspaceHostConfig): WorkspaceOptions => {
  const backends = [...(config.backends ?? [])];

  if (config.shell !== undefined) {
    const { egress, executionContext, hostBinding, hostId, loader, ...shellOptions } = config.shell;

    backends.push(
      new WorkerShellBackend({
        ...shellOptions,
        loader,
        workspace: { binding: hostBinding, id: hostId },
        ctx: executionContext,
        egress: egress ?? { mode: "none" },
      }),
    );
  }

  // SAFETY: Cloudflare's native DurableObjectStorage implements the narrower storage methods used
  // by Computer; the union also accepts Computer's structural test/storage contract directly.
  const options: WorkspaceOptions = {
    storage: config.storage as DurableObjectStorageLike,
    git: config.git ?? createGitClient(),
  };

  if (config.gitIdentity !== undefined) options.defaultGitIdentity = config.gitIdentity;
  if (backends.length !== 0) options.backends = backends;
  if (config.sessionId !== undefined) options.sessionId = config.sessionId;
  if (config.mounts !== undefined) options.mounts = config.mounts;
  if (config.observer !== undefined) options.observer = config.observer;
  if (config.retryScheduler !== undefined) options.retryScheduler = config.retryScheduler;
  if (config.retry !== undefined) options.retry = config.retry;
  if (config.assets !== undefined) options.assets = config.assets;

  if (config.artifacts !== undefined) {
    const erasedArtifactsBinding: unknown = config.artifacts.binding;
    // SAFETY: the local binding intentionally models the same Cloudflare Artifacts RPC surface;
    // its readonly result arrays are valid runtime inputs to Computer, whose dependency declaration
    // unnecessarily requires mutable arrays.
    const artifactsBinding = erasedArtifactsBinding as NonNullable<
      WorkspaceOptions["artifacts"]
    >["binding"];
    const artifacts: NonNullable<WorkspaceOptions["artifacts"]> = {
      binding: artifactsBinding,
    };

    if (config.artifacts.sessionId !== undefined) {
      artifacts.sessionId = config.artifacts.sessionId;
    }

    options.artifacts = artifacts;
  }

  if (config.now !== undefined) options.now = config.now;
  if (config.useThink !== undefined) options.useThink = config.useThink;

  return options;
};

// Cloudflare constructs Durable Objects with `(state, env)`. Keeping the
// remaining tuple open preserves arbitrary Effect-backed base constructors.
type DurableObjectConstructor = new (...args: Array<any>) => object;

const HostArguments = Symbol("effect-cf/ComputerWorkspaceHost/arguments");

interface CapturedHostArguments {
  readonly state: globalThis.DurableObjectState;
  readonly env: unknown;
}

interface HostArgumentsInstance {
  readonly [HostArguments]: CapturedHostArguments;
}

/**
 * Wraps a Durable Object class with one SQLite-backed Cloudflare Computer
 * workspace and registers that local workspace for {@link ComputerWorkspace}
 * to acquire through its Effect layer.
 *
 * The class must use a `new_sqlite_classes` migration. If `shell` is present,
 * its Worker must also configure a `worker_loaders` binding, enable the
 * `experimental` compatibility flag, and export `WorkspaceServiceProxy`.
 */
export const withComputerWorkspace = <TBase extends DurableObjectConstructor>(
  Base: TBase,
  config: (
    self: InstanceType<TBase>,
    state: globalThis.DurableObjectState,
    env: ConstructorParameters<TBase>[1],
  ) => ComputerWorkspaceHostConfig,
): WithWorkspaceCtor<TBase> => {
  const CapturedBase = class extends Base {
    readonly [HostArguments]: CapturedHostArguments;

    constructor(...args: Array<any>) {
      super(...args);
      // SAFETY: Cloudflare constructs Durable Objects with DurableObjectState as constructor
      // argument zero; the open base tuple retains arbitrary trailing constructor arguments.
      this[HostArguments] = {
        state: args[0] as globalThis.DurableObjectState,
        env: args[1],
      };
    }
  };

  const workspaceConstructor: unknown = withWorkspace(CapturedBase, (self) => {
    // SAFETY: CapturedBase initializes this private symbol for every constructed instance before
    // withWorkspace evaluates its options callback.
    const { env, state } = (self as HostArgumentsInstance)[HostArguments];

    return toWorkspaceOptions(
      // SAFETY: CapturedBase is an identity subclass of Base, so its instance retains Base's full
      // public instance contract. The captured environment is constructor argument one.
      config(self as InstanceType<TBase>, state, env as ConstructorParameters<TBase>[1]),
    );
  });
  // SAFETY: withWorkspace returns a constructable identity subclass; this local constructor view
  // intentionally hides its generic intersection so TypeScript can extend it.
  const WithWorkspace = workspaceConstructor as DurableObjectConstructor;

  class WithComputerWorkspace extends WithWorkspace {
    constructor(...args: Array<any>) {
      super(...args);
      // SAFETY: Cloudflare supplies DurableObjectState at constructor argument zero, and
      // withWorkspace adds the WorkspaceHandle methods implemented by this instance.
      HostRegistry.register(args[0] as globalThis.DurableObjectState, this as WorkspaceHandle);
    }
  }

  const erasedConstructor: unknown = WithComputerWorkspace;

  // SAFETY: WithComputerWorkspace only adds registration to the constructor produced by
  // withWorkspace, preserving Base's constructor and instance members plus the workspace host.
  return erasedConstructor as WithWorkspaceCtor<TBase>;
};
