# DurableObjectAlarm Feedback

Reference feedback for `packages/effect-cf/src/DurableObjectAlarm.ts`.

## Findings, Ordered By Severity

1. **High: failed logical handlers can leave due rows stranded after Cloudflare's finite alarm retries are exhausted.**

   `processDueAlarms` only calls `reconcileAlarm()` after the entire loop succeeds. If `handle(event)` fails, the row remains due, but the function exits before reconciliation. That preserves the row, which is good, but the package currently relies on Cloudflare platform retries. Cloudflare documents at-least-once alarm execution, but retries are exponential backoff with up to 6 retries; after that, a due row can remain in SQLite with no future platform wake-up unless another request later schedules/reconciles. This is the most important publishing risk. See `DurableObjectAlarm.ts:344-379`. Cloudflare's retry limit and alarm handler semantics are documented here. ([Cloudflare Docs][1])

2. **High: due-row acknowledgement can clobber replacement schedules for the same `{tag, id}`.**

   `processDueAlarms` selects due rows, then runs an arbitrary user `handle(event)`, then deletes or updates by `storage_id` only. If the handler performs non-storage I/O, another RPC/fetch can interleave and call `scheduleAlarm` with the same `{tag, id}`. The original processing path can then delete or update the newly scheduled replacement because the acknowledgement query only checks `storage_id`, not the originally observed `run_at`, payload, or a version column. This is especially risky for repeating alarms, where the `UPDATE ... SET run_at = acknowledgedAt + repeatEvery` can overwrite a deliberate reschedule. See `DurableObjectAlarm.ts:344-374` and `scheduleAlarm` at `DurableObjectAlarm.ts:323-341`. Cloudflare notes that non-storage I/O permits interleaving and recommends optimistic/check-and-set patterns around that boundary. ([Cloudflare Docs][2])

3. **High: SQL row writes and platform alarm reconciliation are not composed atomically.**

   `scheduleAlarm` persists the row, then separately calls `reconcileAlarm`; if `setAlarm` fails, the logical alarm is durable but may never wake the object. `cancelAlarm` is less dangerous because a stale platform alarm can fire and discover no rows, but `scheduleAlarm` failure after the SQL write is a real "stored but not armed" state. See `DurableObjectAlarm.ts:297-341`. Cloudflare's SQLite storage docs say operations are transactional/strongly consistent, and the SQLite transaction APIs can include SQL; for SQLite-backed objects, direct `ctx.storage` operations inside a transaction are considered part of the transaction. ([Cloudflare Docs][3])

4. **High: current due processing creates global head-of-line blocking across unrelated logical alarms.**

   The processing loop stops on the first handler failure. This is probably the wrong default for a logical alarm scheduler because many alarms are independent interval or maintenance jobs. A single poison row can prevent unrelated due rows, such as heartbeats, cleanup, or presence expiry, from running. Ordered blocking should be an explicit mode, not the default. See `DurableObjectAlarm.ts:356-379`.

5. **Medium: due processing is unbounded.**

   `processDueAlarms` loads all due rows with no `LIMIT`, then processes them sequentially. A dormant object or a bug that accumulates many rows could make one alarm invocation too long, increase memory use, and delay reconciliation. A `batchSize`/`limit` option plus immediate reschedule when more rows remain would make the scheduler safer for production. See `DurableObjectAlarm.ts:348-357`.

6. **Medium: public error types are narrower than the actual failure modes.**

   `scheduleAlarm` advertises only `StorageOperationError`, but `decodeAlarmRef(input)` and `toRepeatEveryMillis(input.repeatEvery)` can throw synchronously; invalid `repeatEvery` is currently an untyped defect, not a typed Effect error. `processDueAlarms` similarly can defect if stored payload decoding fails. See `DurableObjectAlarm.ts:95-100`, `DurableObjectAlarm.ts:225-235`, and `DurableObjectAlarm.ts:216-243`.

7. **Medium: corrupted or migrated rows are treated as defects.**

   `decodeStoredPayload` and `DateTime.makeUnsafe(row.run_at)` are used when creating the event. Because rows are durable and schema evolution is likely, malformed payloads or bad timestamps should probably surface as a typed scheduler/storage decode error or be handled by an explicit repair policy, not as an unexpected defect. See `DurableObjectAlarm.ts:216-243`.

8. **Medium: the acknowledgement-after-handler semantics are correct for at-least-once, but duplicate side effects remain unavoidable and under-documented.**

   Deleting before the handler would lose work if the handler fails, so the current "handle first, then delete/update" ordering is the right default. The tradeoff is that if the handler succeeds but the acknowledgement write fails, the logical event will run again. Cloudflare explicitly recommends idempotent alarm handlers because alarms may fire more than once. ([Cloudflare Docs][2]) The service docs mention retry safety, but should state the duplicate-after-success case explicitly.

9. **Medium/Low: schema initialization is lazy rather than part of Durable Object initialization/migration.**

   `ensureTable` runs on each public method. That is safe enough with `CREATE TABLE IF NOT EXISTS`, but it is not a general migration strategy. Cloudflare recommends `blockConcurrencyWhile()` for constructor-time migrations/initialization to prevent races during initialization; for this package, a future schema migration will need more than lazy `CREATE IF NOT EXISTS`. ([Cloudflare Docs][2])

10. **Low: the index should probably be `(run_at, storage_id)`.**

    The primary query orders by `run_at ASC, storage_id ASC`, but the schema only indexes `run_at`. SQLite can still work, but a covering/composite index better matches the reconciliation and due-processing order. See `DurableObjectAlarm.ts:6-16` and `DurableObjectAlarm.ts:297-303`.

11. **Positive: the basic one-platform-alarm design matches Cloudflare's recommended pattern.**

    Cloudflare documents that each Durable Object can have only one alarm, and recommends storing many logical events in storage, processing due events in `alarm()`, then rescheduling to the next due event. The package's persisted logical rows plus earliest-row reconciliation are aligned with that model. ([Cloudflare Docs][1])

12. **Positive: the reusable service preserves the project's runtime-boundary constraint.**

    `DurableObjectAlarm.layer` returns Effect services and does not create its own runtime. `DurableObject.make` owns the `ManagedRuntime` and routes lifecycle handlers through `[RunSymbol]`, which is the right boundary for automatic alarm integration too.

## API/Design Recommendations

1. **Add isolated logical failure handling before publishing automatic integration.**

   Domain handler failures should usually be isolated to the failed logical alarm. Storage failures during acknowledgement or reconciliation are more fundamental and can still fail the platform alarm handler. Consider an option such as:

   ```ts
   DurableObjectAlarm.processDueAlarms(handler, {
     mode: "isolated",
     retryFailedAfter: "30 seconds",
     onFailure: ({ event, cause }) => Effect.logError("logical alarm failed", { event, cause }),
   });
   ```

   Provide opt-in strict mode for queue-like workflows where order is meaningful:

   ```ts
   DurableObjectAlarm.processDueAlarms(handler, {
     mode: "ordered",
   });
   ```

   The important part is that the helper returns an `Effect`; `DurableObject.make` still calls `[RunSymbol]`. No helper should call `Effect.runPromise`.

2. **Use compare-and-set or a row version for acknowledgement.**

   Acknowledgement should be conditional on the row still being the same logical occurrence that was selected. At minimum, delete/update with `WHERE storage_id = ? AND run_at = ?`; better is a `version`/`generation` column that increments on replacement. This prevents a long-running handler from deleting or rescheduling a newer replacement for the same `{tag, id}`.

3. **Consider a claim state if `processDueAlarms` can be called outside the platform `alarm()` lifecycle.**

   Cloudflare guarantees only one `alarm()` handler at a time per object, but the service method is public and can be called from RPC/fetch. If that is allowed, two callers can select the same due row. A `processing_at`, `lease_until`, or `attempt_id` column would make duplicate processing less likely and more observable.

4. **Add batching controls.**

   Expose something like:

   ```ts
   processDueAlarms(handler, { limit: 100 });
   ```

   If more due rows remain, reconcile to `now` or the earliest remaining due row so the object wakes again. This keeps a single alarm event from becoming an unbounded batch processor.

5. **Keep `DurableObjectAlarm` reusable, but add an entrypoint-owned integration option.**

   A direct `DurableObject.make` shape could be:

   ```ts
   DurableObject.make(layer, {
     rpc,
     fetch,
     alarms: DurableObjectAlarm.processDue((event) =>
       Effect.gen(function* () {
         // typed/domain routing
       }),
     ),
     alarm: (alarmInfo) =>
       Effect.gen(function* () {
         // optional raw platform alarm hook
       }),
   });
   ```

   Internally, `DurableObject.make` would compose `options.alarms` and `options.alarm` into one Effect and run it once through `[RunSymbol]`. The reusable `DurableObjectAlarm` helper only builds an Effect; it does not own a runtime.

6. **Be explicit about composition with user-provided `options.alarm`.**

   When automatic logical alarms are enabled, the raw `options.alarm` should be treated as a lifecycle hook, not another owner of `storage.setAlarm`. Default to: process logical alarms first, then run the user hook; failure of either fails the platform alarm unless an `onFailure` policy reschedules and returns. Also document that code using the logical scheduler must not independently call `setAlarm`/`deleteAlarm` unless it opts into a raw single-platform-alarm mode.

7. **Make `DurableObjectDefinition.make(...).make` inherit the same ergonomics.**

   This should be straightforward because `DurableObjectDefinition.Options` already extends the direct `DurableObjectOptions` minus `rpc`, and its `make` forwards `...options` to `DurableObjectEntrypoint.make`. The alarm option should live in the direct options type so definition-based objects get it automatically.

8. **Offer typed logical alarm definitions as a separate helper.**

   A shape like this would fit the package's code-owned-schema style:

   ```ts
   const RoomAlarms = DurableObjectAlarm.define({
     heartbeat: S.Null,
     reconnectGrace: S.Struct({
       connectionId: S.String,
       userId: S.String,
     }),
   });

   DurableObject.make(Layer.mergeAll(RoomLayer, DurableObjectAlarm.layer), {
     alarms: RoomAlarms.handlers({
       heartbeat: ({ id, scheduledAt }) => Heartbeat.handle(id, scheduledAt),
       reconnectGrace: ({ payload }) => Connections.expire(payload.connectionId),
     }),
   });
   ```

   The typed wrapper can still store rows through the existing `{tag, id, payload}` scheduler. It just centralizes tag names, payload schemas, and handler routing.

9. **Add typed scheduler errors.**

   Consider `InvalidAlarmRefError`, `InvalidRepeatEveryError`, and `StoredAlarmDecodeError` rather than defects for user input and durable decode failures. Defects are still fine for truly impossible internal invariants.

10. **Keep the namespace export, but consider convenience aliases.**

    `export * as DurableObjectAlarm from "./DurableObjectAlarm"` is consistent with the package's current export style. The awkward part is consumers writing `DurableObjectAlarm.DurableObjectAlarm`; optional named re-exports or examples can reduce confusion without changing the namespace style.

## Suggested Tests

1. **Scheduling/reconciliation basics**
   - First schedule creates the table, inserts one row, and sets the platform alarm to `run_at`.
   - Scheduling a later alarm does not move the platform alarm later if an earlier one exists.
   - Scheduling an earlier alarm moves the platform alarm earlier.
   - Scheduling the same `{tag, id}` replaces `run_at`, `repeat_every_ms`, and payload.

2. **Cancellation**
   - Cancelling a missing alarm is a no-op.
   - Cancelling the earliest row reconciles to the next earliest row.
   - Cancelling the only row calls `deleteAlarm`.
   - Cancelling during a handler does not let the handler resurrect or clobber a newly scheduled replacement.

3. **Due processing**
   - Due rows are processed in `run_at, storage_id` order.
   - One-shot rows are deleted only after handler success.
   - Repeating rows are advanced to `acknowledgedAt + repeatEvery`.
   - Rows that become due while a long handler is running are not lost and are reconciled afterward.
   - `processDueAlarms` with no due rows still reconciles correctly.

4. **Failure semantics**
   - Handler failure leaves the failed row due.
   - Handler failure before the loop ends does not delete/update that row.
   - Handler success followed by acknowledgement storage failure is documented/tested as possible duplicate delivery.
   - A failure policy test proves the automatic integration reschedules before Cloudflare's finite retry window can strand work.

5. **Race/replace semantics**
   - While a selected row is being handled, replacing the same `{tag, id}` with a future `runAt` must not be deleted by the old one-shot acknowledgement.
   - While a selected repeating row is being handled, replacing it must not be overwritten by the old repeat update.
   - Two explicit `processDueAlarms` calls cannot process the same row twice if the API allows non-platform invocation.

6. **Batching**
   - With `limit: N`, only N due rows are processed.
   - If due rows remain, the platform alarm is set to immediate/earliest remaining.
   - A large due set does not require loading all rows into memory.

7. **Input/schema**
   - Invalid `tag`/`id` fails as a typed error.
   - Zero, negative, infinite, or unparsable `repeatEvery` fails as a typed error.
   - JSON payload round-trips.
   - Non-JSON payloads are rejected.
   - Corrupted stored payloads produce a typed decode/storage error or follow the configured repair policy.

8. **Durable Object integration**
   - `DurableObject.make(..., { alarms })` invokes logical processing through the existing `[RunSymbol]` runtime.
   - It composes with `options.alarm` in the documented order.
   - A failure in either composed hook follows the documented platform retry/reschedule behavior.
   - No helper service creates a separate `ManagedRuntime` or calls `Effect.runPromise`.
   - `DurableObjectDefinition.make(...).make(..., { alarms })` forwards the option and preserves RPC argument/result typing.

9. **Current package coverage gap**
   - I do not see a selected `DurableObjectAlarm.test.ts`; the shown tests cover storage wrappers, state wrappers, RPC/namespace typing, and entrypoint behavior, but not this scheduler's correctness matrix.

## Open Questions Or Assumptions

1. **Should logical handlers be required to be idempotent, or should the scheduler provide stronger claiming/deduplication?**

   Cloudflare alarms are at-least-once, so idempotency should be required either way, but the package can still prevent obvious replacement clobbers.

2. **Should a failed logical alarm block later due alarms?**

   Current behavior says yes. That may be desirable for strict order, but many schedulers prefer "process all due rows, retain failed rows, then report aggregate failure."

3. **Is `DurableObjectAlarm` intended to be the sole owner of the platform alarm whenever its layer is present, or only when automatic integration is enabled?**

   The docs already warn that another scheduler can clobber `setAlarm`; the automatic API should make this ownership model explicit.

4. **Should automatic integration provide indefinite retry by default?**

   Recommendation: yes, at least for the ergonomic `alarms` option, because otherwise durable rows can outlive Cloudflare's platform retry window.

5. **Should the package support fixed-cadence repeating alarms, or only delay-after-success?**

   The current `acknowledgedAt + repeatEvery` behavior is sound and well documented, but some consumers may expect catch-up or fixed cadence. Keep the current behavior, but name it clearly or make cadence explicit.

[1]: https://developers.cloudflare.com/durable-objects/api/alarms/ "Alarms - Cloudflare Durable Objects docs"
[2]: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ "Rules of Durable Objects - Cloudflare Durable Objects docs"
[3]: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ "SQLite-backed Durable Object Storage - Cloudflare Durable Objects docs"
