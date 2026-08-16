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

  return {
    storage: config.storage as DurableObjectStorageLike,
    git: config.git ?? createGitClient(),
    ...(config.gitIdentity === undefined ? {} : { defaultGitIdentity: config.gitIdentity }),
    ...(backends.length === 0 ? {} : { backends }),
    ...(config.sessionId === undefined ? {} : { sessionId: config.sessionId }),
    ...(config.mounts === undefined ? {} : { mounts: config.mounts }),
    ...(config.observer === undefined ? {} : { observer: config.observer }),
    ...(config.retryScheduler === undefined ? {} : { retryScheduler: config.retryScheduler }),
    ...(config.retry === undefined ? {} : { retry: config.retry }),
    ...(config.assets === undefined ? {} : { assets: config.assets }),
    ...(config.artifacts === undefined
      ? {}
      : {
          artifacts: {
            binding: config.artifacts.binding as unknown as NonNullable<
              WorkspaceOptions["artifacts"]
            >["binding"],
            ...(config.artifacts.sessionId === undefined
              ? {}
              : { sessionId: config.artifacts.sessionId }),
          },
        }),
    ...(config.now === undefined ? {} : { now: config.now }),
    ...(config.useThink === undefined ? {} : { useThink: config.useThink }),
  };
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
  const CapturedBase = class extends (Base as DurableObjectConstructor) {
    readonly [HostArguments]: CapturedHostArguments;

    constructor(...args: Array<any>) {
      super(...args);
      this[HostArguments] = {
        state: args[0] as globalThis.DurableObjectState,
        env: args[1],
      };
    }
  };

  const WithWorkspace = withWorkspace(CapturedBase, (self) => {
    const { env, state } = (self as HostArgumentsInstance)[HostArguments];

    return toWorkspaceOptions(
      config(self as InstanceType<TBase>, state, env as ConstructorParameters<TBase>[1]),
    );
  }) as unknown as DurableObjectConstructor;

  class WithComputerWorkspace extends WithWorkspace {
    constructor(...args: Array<any>) {
      super(...args);
      HostRegistry.register(args[0] as globalThis.DurableObjectState, this as WorkspaceHandle);
    }
  }

  return WithComputerWorkspace as unknown as WithWorkspaceCtor<TBase>;
};
