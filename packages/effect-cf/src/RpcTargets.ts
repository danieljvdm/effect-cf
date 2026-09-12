import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import type * as Scope from "effect/Scope";
import * as Option from "effect/Option";

import { CurrentTargets, type Targets } from "./internal/RpcTargets";

/** A native RPC target could not be constructed. */
export class RpcTargetError extends Data.TaggedError("RpcTargetError")<{
  readonly cause: unknown;
}> {}

/**
 * Reuse a native RPC target within the current invocation. Native Durable Object
 * stubs capture the calling request's channel when created. Recreating a stub
 * after a callback can extend that callback's call chain until Cloudflare's
 * subrequest depth limit is reached, even when an alarm owns the work.
 *
 * The owner and address must identify one target and its construction options.
 * Outside an effect-cf invocation (or withScope), each lookup constructs a target.
 */
export const get = <A extends object, Owner extends object>(
  owner: Owner,
  address: string,
  create: () => A,
) =>
  Effect.flatMap(Effect.serviceOption(CurrentTargets), (targets) =>
    Effect.try({
      try: () => (Option.isSome(targets) ? targets.value.get(owner, address, create) : create()),
      catch: (cause) => new RpcTargetError({ cause }),
    }),
  );

/** Discard a failed native target so a subsequent call can acquire a fresh channel. */
export const invalidate = <Target extends object>(target: Target): Effect.Effect<void> =>
  Effect.map(Effect.serviceOption(CurrentTargets), (targets) => {
    if (Option.isSome(targets)) targets.value.invalidate(target);
  });

/**
 * Own RPC targets in the current Scope, including a transferred response stream,
 * never across incoming requests or durable retries. effect-cf entrypoints install this boundary automatically.
 */
export const withScope = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Scope.Scope> =>
  Effect.gen(function* () {
    let active = true;
    let owners = new WeakMap<object, Map<string, object>>();
    let addresses = new WeakMap<object, { entries: Map<string, object>; address: string }>();
    const targets: Targets = {
      get: <T extends object, Owner extends object>(
        owner: Owner,
        address: string,
        create: () => T,
      ): T => {
        if (!active) return create();
        let entries = owners.get(owner);

        if (entries === undefined) {
          entries = new Map();
          owners.set(owner, entries);
        }
        const existing = entries.get(address);

        if (existing !== undefined) {
          // SAFETY: the caller's owner/address identifies the same native target type.
          return existing as T;
        }
        const target = create();

        entries.set(address, target);
        addresses.set(target, { entries, address });

        return target;
      },
      invalidate: (target) => {
        const entry = addresses.get(target);

        if (entry?.entries.get(entry.address) === target) entry.entries.delete(entry.address);
        addresses.delete(target);
      },
    };

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        active = false;
        owners = new WeakMap();
        addresses = new WeakMap();
      }),
    );

    return yield* effect.pipe(Effect.provideService(CurrentTargets, targets));
  });
