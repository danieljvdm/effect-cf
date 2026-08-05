# Deterministic Effect Atom lifecycle testing

Test cache policy below React first with `AtomRegistry.make()`. Add a React integration test only for provider placement, hook behavior, a browser-only SSR boundary, or hydration.

Use fake timers, a request counter, controllable Effects, and explicit mounts:

```ts
const registry = AtomRegistry.make({ defaultIdleTTL: 1_000 });
const unmount = registry.mount(queryAtom);
const first = registry.get(queryAtom);

// Advance the Effect scheduler/microtasks as required by the installed version.
// Assert with AsyncResult predicates and request counts.

unmount();
```

Avoid wall-clock sleeps. Flush Effect work with the repository's established `Effect.yieldNow`/test-clock pattern and advance the test runner's fake timers.

Prefer the installed test APIs over invented helpers or matchers. The upstream Effect tests use `assert(AsyncResult.isSuccess(result))`, `Effect.runPromise(Effect.yieldNow)`, `vitest.advanceTimersByTimeAsync(...)`, and the cleanup returned by `registry.mount(atom)`.

## Required scenarios

### Remount reuse

1. Mount and resolve the query; assert request count `1`.
2. Unmount, advance less than idle TTL, remount the same atom identity.
3. Assert the cached success is immediately available and no request occurs while still fresh.

### Stale refresh

1. Resolve once through an SWR wrapper.
2. Advance past `staleTime` but not idle TTL.
3. Remount or emit the injected focus signal.
4. Assert the previous success stays available with `waiting: true`, then a second success arrives and request count becomes `2`.
5. Also prove a fresh mount/focus does not request.

### TTL eviction

1. Resolve and unmount.
2. Advance to just before TTL; assert reuse.
3. Advance to/after TTL and flush disposal; remount.
4. Assert `Initial`/waiting behavior and a new request.

### Polling cleanup

1. Mount the `Atom.withRefresh` wrapper and resolve once.
2. Advance one interval; assert one forced refresh.
3. Unmount and advance several intervals.
4. Assert the counter does not change. This catches leaked timers or accidental `keepAlive`.

### Mutation invalidation

1. Mount list and detail queries with explicit keys.
2. Run a successful mutation with matching keys; assert only the intended queries refresh.
3. Run a failed mutation; assert no invalidation.
4. Assert cleanup removes invalidation handlers after query disposal.

### Aggregate stability

Mount a route atom that uses `AsyncResult.all`, resolve every input, unmount, and remount inside the retention window. Assert the aggregate never returns to `Initial`. Then let one input expire and prove the aggregate reset is caused by that input, not the retained queries.

For runtime/layer tests, seed `runtime.layer` through `RegistryProvider initialValues` with a deterministic test layer. This replaces network services without changing the production atom graph.
