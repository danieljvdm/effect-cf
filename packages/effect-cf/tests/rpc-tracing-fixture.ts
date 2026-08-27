import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

import { DurableObject, RpcTracing, Worker } from "../src/index";

// Capture the actual OTLP request bodies without an external collector.
export const capturedOtlpLayer = (bodies: Array<string>) =>
  OtlpTracer.layer({
    url: "https://collector.test/v1/traces",
    resource: { serviceName: "native-rpc-test" },
  }).pipe(
    Layer.provide(OtlpSerialization.layerJson),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            if (request.body._tag !== "Uint8Array") {
              throw new Error("Expected a serialized OTLP request body");
            }

            bodies.push(new TextDecoder().decode(request.body.body));

            return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
          }),
        ),
      ),
    ),
  );

class CapturedOtlp extends Context.Service<CapturedOtlp, Array<string>>()(
  "effect-cf/test/RpcTracing/CapturedOtlp",
) {}

const eventLayer = Layer.unwrap(Effect.map(CapturedOtlp, capturedOtlpLayer));
const drain = () => Effect.map(CapturedOtlp, (bodies) => bodies.splice(0));

export class TraceObject extends DurableObject.Tag<TraceObject>()("TraceObject", {
  read: DurableObject.method({ args: [Schema.FiniteFromString], success: Schema.FiniteFromString }),
  drain: DurableObject.method({ success: Schema.Array(Schema.String) }),
}) {}

const ObjectLive = TraceObject.make(
  Layer.sync(CapturedOtlp, () => []),
  {
    eventLayer,
    rpcTracing: { service: "TRACE_OBJECTS" },
    rpc: {
      read: (value) => Effect.succeed(value + 1),
      drain,
    },
  },
);

export class TestTracingDurableObject extends ObjectLive {
  override [DurableObject.RunSymbol]<A, E>(
    effect: Effect.Effect<A, E, Effect.Services<DurableObject.DurableObjectHandler<CapturedOtlp>>>,
    options: DurableObject.RunOptions = {},
  ): Promise<A> {
    return super[DurableObject.RunSymbol](
      options.rpc === undefined ? effect : RpcTracing.withRpcServerSpan(effect, options.rpc),
      options,
    );
  }
}

export class TraceWorker extends Worker.Tag<TraceWorker>()("TraceWorker", {
  read: Worker.method({ args: [Schema.FiniteFromString], success: Schema.FiniteFromString }),
  reject: Worker.method({
    args: [Schema.String.check(Schema.makeFilter((value: string) => `Rejected input: ${value}`))],
    success: Schema.Finite,
  }),
  drain: Worker.method({ success: Schema.Array(Schema.String) }),
}) {}

// WorkerEntrypoint instances are per invocation; keep only exported test bodies across them.
const workerBodies: Array<string> = [];
const workerLayer = Layer.mergeAll(
  Layer.succeed(CapturedOtlp, workerBodies),
  TraceObject.layer({ binding: "TRACE_OBJECTS", rpcTracing: true }),
);
const WorkerLive = TraceWorker.make<
  Layer.Success<typeof workerLayer>,
  Layer.Error<typeof workerLayer>,
  Layer.Success<typeof eventLayer>
>(workerLayer, {
  eventLayer,
  rpcTracing: { service: "TRACE_WORKER" },
  rpc: {
    read: (value) =>
      Effect.gen(function* () {
        const objects = yield* TraceObject;

        return yield* objects.byName("native-tracing").read(value);
      }),
    reject: () => Effect.succeed(0),
    drain,
  },
});

export class TestTracingWorker extends WorkerLive {
  override [Worker.RunSymbol]<A, E>(
    effect: Effect.Effect<
      A,
      E,
      Effect.Services<Worker.WorkerRpcHandler<CapturedOtlp | TraceObject>>
    >,
    options: Worker.RunOptions = {},
  ): Promise<A> {
    return super[Worker.RunSymbol](
      options.rpc === undefined ? effect : RpcTracing.withRpcServerSpan(effect, options.rpc),
      options,
    );
  }
}
