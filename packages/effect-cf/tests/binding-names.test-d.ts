import { expectTypeOf } from "vitest";
import { Effect, Layer, Schema } from "effect";

import {
  Binding,
  D1,
  DurableObject,
  Kv,
  Queue,
  R2,
  ServiceBinding,
  Worker,
  WorkerEnvironment,
  Workflow,
} from "../src/index";
import * as Sandbox from "../src/Sandbox";

// Binding names come from the ambient `Cloudflare.Env` declared in `tests/env.d.ts`.

expectTypeOf<Binding.Key<R2Bucket>>().toEqualTypeOf<"TEST_BUCKET" | "ARTIFACT_BUCKET">();
expectTypeOf<Binding.Key<D1Database>>().toEqualTypeOf<"TEST_DB">();
expectTypeOf<Binding.Name<R2Bucket>>().toEqualTypeOf<
  "TEST_BUCKET" | "ARTIFACT_BUCKET" | Binding.Unchecked
>();

class Uploads extends R2.Tag<Uploads>()("Uploads") {}

Uploads.layer({ binding: "TEST_BUCKET" });
// @ts-expect-error misspelled binding names are rejected.
Uploads.layer({ binding: "TEST_BUKET" });
// @ts-expect-error KV namespaces cannot back an R2 layer.
Uploads.layer({ binding: "TEST_KV" });
Uploads.layer({ binding: Binding.unchecked("RUNTIME_ONLY_BUCKET") });

declare const computedName: string;
// @ts-expect-error computed names must opt out explicitly.
Uploads.layer({ binding: computedName });
Uploads.layer({ binding: Binding.unchecked(computedName) });

class Sessions extends Kv.Tag<Sessions>()("Sessions", {
  key: Schema.String,
  value: Schema.String,
}) {}

Sessions.layer({ binding: "SESSION_KV" });
// @ts-expect-error R2 buckets cannot back a KV layer.
Sessions.layer({ binding: "TEST_BUCKET" });

export const Database = D1.make("Database", { binding: "TEST_DB" });
// @ts-expect-error D1 definitions check their binding name as well.
export const WrongDatabase = D1.make("Database", { binding: "TEST_KV" });

class Counters extends DurableObject.Tag<Counters>()("Counters", {
  get: DurableObject.method({ success: Schema.Number }),
}) {}

Counters.layer({ binding: "TEST_COUNTER_DO" });
Counters.layer({ binding: "COUNTER_DURABLE_OBJECTS" });
// @ts-expect-error service bindings cannot back a Durable Object layer.
Counters.layer({ binding: "API_WORKER" });

// Same-worker Durable Objects can come from `ctx.exports`, checked against
// `Cloudflare.GlobalProps["durableNamespaces"]`.
expectTypeOf<Binding.DurableNamespaceKey>().toEqualTypeOf<
  | "TestComputerWorkspaceDurableObject"
  | "TestCounterDurableObject"
  | "TestInitializationDurableObject"
  | "TestInitializationControl"
  | "TestTracingDurableObject"
  | "TestHibernationRpcDurableObject"
>();

Counters.layer({ exportName: "TestCounterDurableObject" });
Counters.layer({ exportName: Binding.unchecked("RuntimeDurableObject") });
// @ts-expect-error only exports declared as durable namespaces are accepted.
Counters.layer({ exportName: "TestWorkerEntrypoint" });
// @ts-expect-error a layer reads either an env binding or an export, not both.
Counters.layer({ binding: "TEST_COUNTER_DO", exportName: "TestCounterDurableObject" });

class Api extends Worker.Tag<Api>()("Api", {
  ping: Worker.method({ success: Schema.String }),
}) {}

Api.layer({ binding: "API_WORKER" });
// @ts-expect-error Durable Object namespaces cannot back a service binding layer.
Api.layer({ binding: "TEST_COUNTER_DO" });

export const FetchOnly = ServiceBinding.Service<Api>()("FetchOnly", {
  binding: "FETCH_ONLY_WORKER",
});
// @ts-expect-error module-level service definitions check their binding name.
export const WrongFetchOnly = ServiceBinding.Service<Api>()("FetchOnly", { binding: "TEST_DB" });

export const previewRouting = Effect.gen(function* () {
  yield* Sandbox.proxyToSandbox(new Request("https://example.com"), { binding: "SANDBOX" });
  // @ts-expect-error preview routing reads a Durable Object namespace binding.
  yield* Sandbox.proxyToSandbox(new Request("https://example.com"), { binding: "TEST_BUCKET" });
});

// Queue bindings also check the encoded message against the declared body.
// `AVATAR_QUEUE` is an untyped `Queue`, like `wrangler types` output; `TYPED_JOBS`
// carries a body type, like `cf workers types` output.

class Jobs extends Queue.Tag<Jobs>()("Jobs", {
  message: Schema.Struct({ userId: Schema.String, attempts: Schema.Int }),
}) {}

class Orders extends Queue.Tag<Orders>()("Orders", {
  message: Schema.Struct({ orderId: Schema.String }),
}) {}

expectTypeOf<Binding.QueueKey<{ readonly orderId: string }>>().toEqualTypeOf<"AVATAR_QUEUE">();

Jobs.layer({ binding: "TYPED_JOBS" });
Jobs.layer({ binding: "AVATAR_QUEUE" });
Orders.layer({ binding: "AVATAR_QUEUE" });
// @ts-expect-error the queue body declared in Env does not accept this message schema.
Orders.layer({ binding: "TYPED_JOBS" });
// @ts-expect-error KV namespaces cannot back a queue layer.
Jobs.layer({ binding: "TEST_KV" });

// `TEST_WORKFLOW` declares `Workflow<{ readonly value: string }>`.

class ValueWorkflow extends Workflow.Tag<ValueWorkflow>()("ValueWorkflow", {
  payload: Schema.Struct({ value: Schema.String }),
  result: Schema.String,
}) {}

class CountWorkflow extends Workflow.Tag<CountWorkflow>()("CountWorkflow", {
  payload: Schema.Struct({ count: Schema.Number }),
  result: Schema.String,
}) {}

ValueWorkflow.layer({ binding: "TEST_WORKFLOW" });
CountWorkflow.layer({ binding: "REPORT_WORKFLOW" });
// @ts-expect-error the workflow payload declared in Env does not accept this schema.
CountWorkflow.layer({ binding: "TEST_WORKFLOW" });

// Checked and unchecked names produce the same layer.
expectTypeOf(Uploads.layer({ binding: "TEST_BUCKET" })).toEqualTypeOf(
  Uploads.layer({ binding: Binding.unchecked("TEST_BUCKET") }),
);
expectTypeOf(Uploads.layer({ binding: "TEST_BUCKET" })).toEqualTypeOf<
  Layer.Layer<
    Uploads,
    Binding.BindingNotFoundError | Binding.BindingValidationError,
    WorkerEnvironment
  >
>();
