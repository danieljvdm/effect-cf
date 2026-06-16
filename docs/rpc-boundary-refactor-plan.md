# RPC Boundary Refactor Plan

## Summary

This repo has already moved the Worker entrypoint implementation from `Entry.ts` to `Worker.ts`, and the current branch already contains the Cloudflare RPC provider utilities in `packages/cloudflare/src/Rpc.ts`. The implementation should therefore be a narrow cleanup of the dynamic boundaries that remain in the current package shape:

- Keep the public APIs for `Worker.make`, `WorkerDefinition.make`, `DurableObject.make`, `DurableObjectDefinition.make`, `DurableObjectNamespace.Service`, `ServiceBinding.Service`, `rpc`, `call`, and `scopedCall`.
- Keep runtime execution inside Worker and Durable Object entrypoint classes only.
- Preserve native Cloudflare RPC result semantics: `rpc` returns the raw Cloudflare RPC result inside an `Effect`; `call` resolves it; `scopedCall` resolves it inside an Effect scope.
- Move repeated dynamic access and unavoidable assertions into small internal helpers.
- Add focused type and runtime tests for the current package test layout.

## Current Repo Shape

The relevant package files are:

- `packages/cloudflare/src/Worker.ts`, replacing the old `Entry.ts` from the original plan.
- `packages/cloudflare/src/DurableObject.ts`.
- `packages/cloudflare/src/DurableObjectDefinition.ts`.
- `packages/cloudflare/src/WorkerDefinition.ts`.
- `packages/cloudflare/src/DurableObjectNamespace.ts`.
- `packages/cloudflare/src/ServiceBinding.ts`.
- `packages/cloudflare/src/Binding.ts`.
- `packages/cloudflare/src/Rpc.ts`, which already provides `Provider`, `Result`, `resolve`, and `scoped`.

The current branch already has related edits in several of these files. New work must patch on top of those edits rather than reverting them.

## Implementation Steps

1. Refactor `Binding.ts` with a private `getBinding` helper that performs the dynamic env property lookup, reports `BindingNotFoundError` for missing or `undefined` bindings, reports `BindingValidationError` for invalid bindings, and returns the validator-narrowed resource without a final resource assertion.

2. Add `packages/cloudflare/src/internal/RpcInvocation.ts` with shared method key, argument, success, and Cloudflare return utility types plus `lookupRpcMethod` and `invokeRpcMethod`. The helper should validate that the target is object-like or function-like and that the selected property is callable before performing the single contained function assertion.

3. Update `DurableObjectNamespace.ts` to use `RpcInvocation.invokeRpcMethod`. Keep the existing `fetch`, `rpc`, `call`, and `scopedCall` behavior. Rename the namespace validator to `isDurableObjectNamespaceClient` and validate the namespace methods currently exposed by the wrapper.

4. Update `ServiceBinding.ts` to use the same RPC invocation helper and remove the redundant fetcher cast.

5. Update `DurableObjectDefinition.ts` and `WorkerDefinition.ts` so `make` accepts `MethodsShape & RpcDefinition.NoReservedMethods<...>`, preserving the original method shape and removing `as SelfDefinition`.

6. Update `DurableObjectDefinition.HandlerEffect` and `WorkerDefinition.HandlerEffect` to use the same handler effect aliases as the corresponding `Handlers` maps.

7. Add `packages/cloudflare/src/internal/Entrypoint.ts` with two contained helpers:
   - `provideEntrypointServices` for the `Layer.provideMerge` assertion that Effect's current layer typing does not prove locally.
   - `defineEntrypointRpcMethods` for dynamic prototype RPC attachment and direct-factory reserved-name validation.

8. Update `DurableObject.ts` and `Worker.ts` to use the entrypoint helpers. Direct factory reserved names should be rejected before prototype attachment. `ManagedRuntime.make` and `runPromise` remain only in the entrypoint classes.

9. Extend `packages/cloudflare/tests/index.test.ts` with focused type and runtime coverage for:
   - Durable Object definition API/server API inference.
   - namespace `rpc`, `call`, and `scopedCall` inference.
   - missing and invalid bindings.
   - missing, non-callable, thrown, rejected, successful, raw, and scoped RPC calls through Durable Object namespaces and service bindings where practical.
   - direct Durable Object reserved method rejection.

10. Validate with Vite+:
    - `vp check` in `packages/cloudflare`.
    - `vp test` in `packages/cloudflare`.
    - Root `vp check` if package validation passes.

## Notes

- Worker projects use `@cloudflare/workers-types` directly instead of generated Wrangler type files.
- No schema validation is added at RPC call boundaries in this refactor.
- If stronger Durable Object namespace validation conflicts with test doubles, update the doubles to match the public wrapper surface instead of weakening type inference.
