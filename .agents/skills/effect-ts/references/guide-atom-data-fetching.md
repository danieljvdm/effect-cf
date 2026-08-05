# Effect Atom Data Fetching

Model server data as stable atoms owned outside React renders. Give the application one intentional registry boundary and one compatible runtime factory; then choose cache retention, freshness, polling, and invalidation independently.

## Workflow

1. Inspect the installed `effect` and `@effect/atom-react` versions and their source before copying signatures. These APIs live under `effect/unstable/reactivity` and may move.
2. Locate every `RegistryProvider`, runtime factory, query atom, mutation atom, and route-level `AsyncResult.all`. Draw the ownership boundary before changing behavior.
3. Keep one `RegistryProvider` for the intended client application lifetime. Define the shared runtime factory, API service, query families, and mutation atoms at module scope rather than in components.
4. Choose each lifecycle control for its actual job:
   - idle `timeToLive`: retain an unused registry value before disposal;
   - `Atom.swr({ staleTime })`: decide when mount/focus revalidation is needed;
   - `Atom.withRefresh`: force periodic refresh while mounted.
5. Give queries stable identities and matching reactivity keys. Let successful mutations invalidate those keys rather than manually coordinating every consumer.
6. Keep browser-only signals behind an SSR-safe boundary. Decide explicitly whether initial data is client-only or hydrated from a request-scoped server registry.
7. Verify lifecycle behavior with fake time and request counters, not sleeps.

## Ownership rules

- Treat a query as shared read state: export one atom or `Atom.family` and let components subscribe.
- Treat an action as an event owned by the initiating UI or workflow: export the mutation atom, invoke it with `useAtomSet`, and observe its result only where useful.
- Never allocate a query atom in render. For parameterized queries, use a stable scalar or Effect `Hash`/`Equal` value as the family argument.
- Ensure every input to a route-level `AsyncResult.all` has stable atom identity and compatible retention. One newly allocated or immediately evicted input returns to `Initial` and makes the whole aggregate appear reset even when the other inputs remain cached.
- Do not describe manual refresh or polling as freshness caching. Refresh is forceful; `staleTime` only gates SWR's automatic mount/focus decisions.

## Completion check

Confirm one registry boundary, stable atom identity, deliberate TTL/staleness/polling values, matching query and mutation keys, SSR-safe browser access, and tests for every lifecycle behavior changed.
