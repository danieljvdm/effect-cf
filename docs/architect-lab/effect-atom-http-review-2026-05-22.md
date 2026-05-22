# Architect Lab Effect Atom and HTTP Review - 2026-05-22

This document records the external review feedback for the Architect Lab client/API refactor at commit `9b9900e` and tracks the follow-up cleanup work.

## Implementation Checklist

- [x] Replace duplicated API Worker HTTP routes with `HttpApiBuilder` handlers for `ArchitectHttpApi`, keeping the WebSocket route as a Worker/Durable Object boundary.
- [x] Replace the web client's local React/Atom hook layer with `@effect/atom-react`.
- [x] Reduce global `Atom.keepAlive` usage to atoms that are intentionally app-lifetime state.
- [x] Derive UI process state from Atom async results where practical instead of dedicated status-string atoms.
- [x] Remove unused `reactivityKeys` until matching query atoms exist, or add real query atoms.
- [x] Move remaining low-risk cleanup into domain exports/helpers.
- [x] Run `vp check`, `vp test`, and the Architect Lab web client build.

## Implementation Notes

- API JSON routes now use `HttpApiBuilder.group(ArchitectHttpApi, "api", ...)` and `HttpApiBuilder.layer(ArchitectHttpApi)`. The `/api/rooms/:roomId/ws` route remains a manual Worker/Durable Object WebSocket handoff.
- The web client now wraps the app in `RegistryProvider` from `@effect/atom-react` and imports `useAtomValue` / `useAtomSet` from that package.
- `creating`, read-model sync status, and fake-AI status are derived from the relevant Atom action `AsyncResult` values in the UI.
- Request mutation atoms and room/editor/selection/resource-count atoms no longer use blanket `Atom.keepAlive`; app-lifetime atoms remain intentionally kept alive.
- Placeholder mutation `reactivityKeys` were removed because no corresponding query atoms exist yet.
- Canvas mount/change/unmount orchestration now flows through atom commands in `room-canvas-atoms.ts`.
- The unused domain `makeFakeAiPromptResult` sync helper was removed, and the root domain package now re-exports the shared HTTP API definitions.

## Review Feedback

According to the uploaded Architect Lab snapshot from May 22, 2026: the `9b9900e` refactor is **materially better**, but I would **not call it fully idiomatic yet**. The biggest improvement is that the browser client no longer appears to issue raw `fetch` calls for JSON API work: it imports the shared `ArchitectHttpApi`, builds an `AtomHttpApi.Service`, and supplies `FetchHttpClient.layer`, which is the right Effect HTTP client boundary rather than app-level `fetch`. `FetchHttpClient` still delegates to `globalThis.fetch` internally, but that is the Effect HTTP implementation layer, not the anti-pattern the user objected to.

## Verdict

**Pass with reservations.** The client API transport is now much closer to the intended model: `/domain` owns `ArchitectHttpApi`, and the web client consumes it through `AtomHttpApi` plus `FetchHttpClient`. The remaining anti-patterns are mostly:

1. The **API Worker still bypasses `HttpApiBuilder`** and hand-rolls HTTP routes.
2. The **React Atom integration is hand-rolled** instead of using the local `@effect/atom-react` bindings.
3. The **client still manages UI/process state manually** with status atoms and callback plumbing instead of leaning on `AsyncResult`, query atoms, scoped atoms, and atom lifecycle.
4. Several direct platform operations remain, but most are acceptable boundary calls rather than the original "raw browser fetch for API" problem.

## Findings

### High - API Worker defines `ArchitectHttpApi` but does not implement it with `HttpApiBuilder`

`examples/architect-lab/packages/domain/src/http-api.ts:34-68` correctly defines the shared `ArchitectHttpApi` endpoints, including `createRoom`, `saveReadModel`, `publishReadModel`, `submitAiPrompt`, `getPublishedReadModel`, and `roomHealth`. That part is good and matches the expectation that `/domain` owns the contract.

However, `examples/architect-lab/workers/api/src/index.ts:178-249` re-implements those same endpoints with `HttpRouter.add`, manual `schemaPathParams`, manual `schemaBodyJson`, manual response statuses, and `jsonResponse`. Then `routeFetch` calls `HttpRouter.toHttpEffect(ApiRoutes)` and catches all route errors into a generic `404` at `index.ts:264-268`. This leaves a real drift risk: the domain `HttpApi` can change while the server implementation silently diverges.

The local Effect source explicitly has the cleaner path: `HttpApiBuilder.layer(api)` registers an `HttpApi` with an `HttpRouter`, and `HttpApiBuilder.group(api, groupName, handlers => ...)` implements endpoints with `handlers.handle(...)`, with validation that unhandled endpoints are reported at the type level. See `repos/effect-smol/packages/effect/src/unstable/httpapi/HttpApiBuilder.ts:52-94`, `107-142`, and `172-210`.

**Recommendation:** keep the manual WebSocket escape hatch for `/api/rooms/:roomId/ws`, but move normal HTTP endpoints to `HttpApiBuilder.group(ArchitectHttpApi, "api", ...)` and `HttpApiBuilder.layer(ArchitectHttpApi)`. That would make the domain contract authoritative on both client and server.

### High - Web client hand-rolls React Atom integration instead of using `@effect/atom-react`

`examples/architect-lab/workers/web/src/client/state.ts:14` creates a module-global `AtomRegistry.make()`. Lines `29-39` implement local `useAtomValue` and `useAtomSet` around `useSyncExternalStore`, and line `37` mounts atoms only in the setter hook. That duplicates a subset of the local Effect React bindings and misses important behavior.

The local `@effect/atom-react` source already provides a richer implementation: `RegistryProvider` creates/disposes a registry with scheduling and `defaultIdleTTL`; `useAtomValue` uses `Atom.getServerValue`; `useAtomSet` mounts atoms through context; and the package also exports hydration, suspense, and scoped atom helpers. See `repos/effect-smol/packages/atom/react/src/RegistryContext.ts:23-54`, `Hooks.ts:20-49`, `Hooks.ts:80-134`, and `ScopedAtom.ts`.

This is the most obvious remaining client-side anti-pattern. The app is using Effect atoms, but it is not using the idiomatic React adapter that exists in `repos/effect-smol`.

**Recommendation:** add/use `@effect/atom-react`, wrap `main.tsx` with `RegistryProvider`, import `useAtomValue` / `useAtomSet` / `useAtomSuspense` from that package, and remove the module-global registry and local hook layer from `state.ts`.

### Medium - Overuse of `Atom.keepAlive` makes room/editor state effectively global forever

`state.ts:16-27` marks every app atom as `Atom.keepAlive`, including `editorAtom`, `selectedResourceAtom`, `resourceCountsAtom`, status atoms, prompt atoms, and running flags. `client/api.ts:22-28` also keeps all request mutation atoms alive, and the wrapper function atoms at `api.ts:30-47`, `54-74`, and `81-106` are kept alive too.

Some app-level state being long-lived is fine in a single-page demo. But keeping `Editor | null`, selected resource, per-room counts, and request atoms alive globally is not a clean room lifecycle. The local Atom/Registry sources support lifecycle more deliberately: `AtomRegistry.make` accepts `defaultIdleTTL`, `RegistryProvider` supplies a default idle TTL, and `AtomHttpApi.query` supports `timeToLive` and `keepAlive` only where explicitly needed.

**Recommendation:** keep only truly global atoms alive, such as maybe the persisted label and current room id. Treat editor/selection/resource counts as scoped room state, ideally through `ScopedAtom` or a room-scoped provider. Let request atoms mount through `useAtomSet` / `useAtomValue` instead of keeping every mutation wrapper permanently alive.

### Medium - Mutation status is manually modeled instead of derived from `AsyncResult`

`client/api.ts` wraps `AtomHttpApi` mutations in additional `ArchitectClient.runtime.fn` atoms and then manually writes `creatingAtom`, `readModelStatusAtom`, `aiRunningAtom`, and `aiStatusAtom`. For example, `saveSemanticReadModelAtom` sets `"saving"`, then `"saved"` or `"error"` at `api.ts:61-70`; `submitAiPromptAtom` sets `"Queueing fake AI job"`, updates a summary, and toggles `aiRunningAtom` at `api.ts:88-102`.

This works, but it is less Effect-native than deriving UI state from the `AsyncResult` that an `AtomResultFn` already exposes. It also loses useful error detail. The local `AtomHttpApi` implementation creates mutation atoms as `AtomResultFn`s and `FnContext.setResult` is explicitly typed to return an `Effect<A, E>` from an `AsyncResult`-producing writable atom. See `AtomHttpApi.ts:35-72`, `194-224`, and `Atom.ts:920-932`.

There is also a subtle error-channel issue: `AtomHttpApi` dies on `SchemaError` or `HttpClientError` in `catchErrors` (`AtomHttpApi.ts:190-192`). The local `Effect.catch` calls in `api.ts:68-70` and `99-102` will not necessarily convert all transport/schema defects into friendly status text. That means network/schema failures may not map cleanly into `"error"` / `"AI prompt failed"`.

**Recommendation:** expose the mutation atoms' `AsyncResult` to the UI and derive labels like "saving", "saved", "failed", and "running" from that state. Where an event handler needs a promise-like API, prefer the official `useAtomSet(atom, { mode: "promiseExit" })` behavior from `@effect/atom-react` rather than shadow status atoms.

### Medium - `reactivityKeys` are passed, but there are no corresponding client query atoms

`saveSemanticReadModelAtom` invalidates `["read-model", roomId]`, and `submitAiPromptAtom` invalidates `["ai-prompt", roomId]` via `reactivityKeys` at `client/api.ts:63-67` and `94-98`. That is not wrong, because `AtomHttpApi` mutations call `Reactivity.mutation` when `reactivityKeys` are present.

The issue is that the web client currently does not appear to define `ArchitectClient.query("api", "getReadModel", ...)`, `roomHealth`, or `getPublishedReadModel` atoms that use matching reactivity keys. Without query atoms, invalidation is mostly ceremonial. The local AtomHttpApi tests show the intended query path: a query atom forwards params/query through the typed HttpApi client, becomes serializable when a `serializationKey` is supplied, and participates in hydration/dehydration.

**Recommendation:** if the UI is meant to be reactive to API read models, add query atoms for `getReadModel`, `roomHealth`, and published reads with stable `serializationKey`s and matching `reactivityKeys`. Then make mutations invalidate those keys. If there is no query consumer yet, remove the keys until they have an actual lifecycle.

### Medium - Tldraw/React boundary still pushes state through React refs, timers, and callbacks

`room-canvas.tsx` is still a React-managed integration boundary: it uses `useRef` for cleanup, computes a websocket URL with `useMemo`, stores a `setTimeout` debounce, listens to `mountedEditor.store.listen`, and calls `onEditorReady`, `onSelectionChange`, and `onReadModelChange` callbacks back up into `App`. See `examples/architect-lab/workers/web/src/client/room-canvas.tsx:27-87`.

This is acceptable in the narrow sense that tldraw itself is React/hook-based, and `useSync` is a tldraw boundary. But it is still non-ideal for the Effect-native goal. The app then stores the `Editor` in an atom (`state.ts:19`) and has `App` translate canvas changes into mutation calls through callback props (`app.tsx:137-154`). That keeps significant orchestration in React component code rather than in atoms/effects.

**Recommendation:** keep the tldraw hook boundary in React, but move debounce/save orchestration into an Effect/Atom command or scoped room atom. A cleaner shape would be: room-scoped atoms own editor/session state, a debounced save atom owns the read-model sync, and React components only bind event callbacks to atom setters.

### Low / acceptable - Remaining direct `fetch` calls are mostly platform-boundary calls, not the original browser API anti-pattern

There are direct/typed fetches in the Workers layer:

- `workers/web/src/index.ts:32-39` forwards API/WebSocket traffic through `ApiWorker.fetch`.
- `workers/web/src/index.ts:42` calls `env.ASSETS.fetch(...)` for static assets.
- `workers/api/src/index.ts:255-261` forwards the WebSocket upgrade to the room Durable Object via `RoomDurableObject.fetch`.

These are not the same problem as a React client doing raw `fetch("/api/...")`. They are Cloudflare Worker/service-binding/static-asset boundaries. The `ASSETS.fetch` call is especially reasonable. The DO WebSocket handoff is also understandable because WebSocket upgrades are transport-level.

**Recommendation:** leave these boundary fetches unless `effect-cf` grows a cleaner WebSocket/static-assets abstraction. Focus the cleanup on normal JSON HTTP routes and client state.

### Low - No direct `runPromise` in the reviewed web client/API path; one `runSync` helper remains in domain

I did not find a direct `Effect.runPromise` in the selected Architect Lab web client/API code. There is a synchronous helper in `examples/architect-lab/packages/domain/src/ai.ts:234-235`:

```ts
export const makeFakeAiPromptResult = (job: AiJob): AiPromptResult =>
  Effect.runSync(generateFakeAiPromptResult(job));
```

The API Worker uses the effectful `generateFakeAiPromptResult(job)` path, not this helper, so this is not currently a runtime-boundary violation. Still, it is a footgun in the shared domain package because it normalizes direct runtime execution in a place that otherwise exports Effect values.

**Recommendation:** keep the effectful function as the public API and either remove the sync helper or confine it to tests/fixtures.

### Low - Domain package boundary is mostly right, but root exports are incomplete

Putting `ArchitectHttpApi` in `examples/architect-lab/packages/domain/src/http-api.ts` is the right direction. The package exports the subpath `@architect-lab/domain/http-api`, and the web client imports from it. That satisfies the shared-domain expectation.

The minor non-ideal part is `domain/src/index.ts`, which only exports runtime definitions and does not re-export `ArchitectHttpApi`. This is not a correctness issue because the package subpath is present, but it makes the root domain import look less like the authoritative API surface.

**Recommendation:** either re-export `ArchitectHttpApi` from the domain root or keep the subpath intentionally documented as the API-contract entrypoint.

## What Is Idiomatic Now

The `client/api.ts:17-20` pattern is broadly correct:

```ts
const ArchitectClient = AtomHttpApi.Service()("ArchitectClient", {
  api: ArchitectHttpApi,
  httpClient: FetchHttpClient.layer,
});
```

That matches the local `AtomHttpApi.Service` constructor, which accepts an `HttpApi`, an `HttpClient` layer/function, optional transforms, base URL, and runtime factory. It also matches the Effect HTTP model where `FetchHttpClient.layer` provides an `HttpClient` abstraction over `globalThis.fetch`.

The domain-level `ArchitectHttpApi` definition is also a real improvement: it uses `HttpApi`, `HttpApiGroup`, `HttpApiEndpoint`, and `HttpApiSchema.status(...)` for status-bearing success/error schemas.

## Recommended Cleanup Order

1. **Replace API Worker `HttpRouter.add` route duplication with `HttpApiBuilder.group/layer`.** Keep only the WebSocket route outside the `HttpApi`.
2. **Adopt `@effect/atom-react` in the web client.** Remove local `atomRegistry`, `useAtomValue`, and `useAtomSet`.
3. **Derive UI status from `AsyncResult` instead of status-string atoms.**
4. **Scope room/editor atoms.** Avoid global `keepAlive` for `Editor`, selection, resource counts, and per-room request state.
5. **Add real query atoms or remove placeholder `reactivityKeys`.**
6. **Remove or quarantine the `Effect.runSync` fake-AI helper.**

Net: the refactor fixed the most visible browser API transport issue, but the client still has enough hand-rolled React/Atom lifecycle and manual status orchestration that the frustration about "antipatterns everywhere" is still partly valid. The server side is the clearest remaining mismatch: defining `ArchitectHttpApi` in `/domain` but not using it to implement routes is exactly the kind of ad hoc API routing the refactor was supposed to eliminate.
