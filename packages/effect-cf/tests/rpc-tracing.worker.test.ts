import { env, exports } from "cloudflare:workers";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema, Tracer } from "effect";

import { RpcDefinition, ServiceBinding, WorkerEnvironment } from "../src/index";
import { capturedOtlpLayer, TraceObject, TraceWorker } from "./rpc-tracing-fixture";

const OtlpSpan = Schema.Struct({
  name: Schema.String,
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.optional(Schema.String),
  kind: Schema.Int,
  status: Schema.Struct({ code: Schema.Int }),
  startTimeUnixNano: Schema.String,
  endTimeUnixNano: Schema.String,
  attributes: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      value: Schema.Struct({ stringValue: Schema.optional(Schema.String) }),
    }),
  ),
});
const OtlpPayload = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      scopeSpans: Schema.Array(Schema.Struct({ spans: Schema.Array(OtlpSpan) })),
    }),
  ),
});
const decodePayload = Schema.decodeUnknownSync(Schema.fromJsonString(OtlpPayload));
const spansIn = (bodies: ReadonlyArray<string>) =>
  bodies.flatMap((body) =>
    decodePayload(body).resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans),
    ),
  );

const worker = ServiceBinding.makeClient<
  { read(value: number): Promise<number>; drain(): Promise<ReadonlyArray<string>> },
  typeof TraceWorker
>({ binding: "TRACE_WORKER", definition: TraceWorker, rpcTracing: true })(
  exports.TestTracingWorker,
);
const objectLayer = TraceObject.layer({ binding: "TRACE_OBJECTS" }).pipe(
  Layer.provide(Layer.succeed(WorkerEnvironment, env)),
);

it.effect(
  "workerd exports a connected CLIENT/SERVER chain through Worker and Durable Object RPC",
  () =>
    Effect.gen(function* () {
      const clientBodies: Array<string> = [];
      const parent = Tracer.externalSpan({
        traceId: "1234567890abcdef1234567890abcdef",
        spanId: "1234567890abcdef",
        sampled: true,
      });
      const value = yield* worker
        .read(41)
        .pipe(Effect.withParentSpan(parent), Effect.provide(capturedOtlpLayer(clientBodies)));
      const workerBodies = yield* worker.drain();
      const objectBodies = yield* TraceObject.byName("native-tracing")
        .drain()
        .pipe(Effect.provide(objectLayer));
      const spans = spansIn([...clientBodies, ...workerBodies, ...objectBodies]).filter((span) =>
        span.name.endsWith("/read"),
      );

      expect(value).toBe(42);
      expect(spans.map(({ name, kind }) => ({ name, kind }))).toEqual([
        { name: "TRACE_WORKER/read", kind: 3 },
        { name: "TRACE_OBJECTS/read", kind: 3 },
        { name: "TRACE_WORKER/read", kind: 2 },
        { name: "TRACE_OBJECTS/read", kind: 2 },
      ]);
      const [workerClient, objectClient, workerServer, objectServer] = spans;

      expect(workerClient!.parentSpanId).toBe(parent.spanId);
      expect(workerServer!.parentSpanId).toBe(workerClient!.spanId);
      expect(objectClient!.parentSpanId).toBe(workerServer!.spanId);
      expect(objectServer!.parentSpanId).toBe(objectClient!.spanId);

      for (const span of spans) {
        expect(span.traceId).toBe(parent.traceId);
        expect(BigInt(span.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(span.startTimeUnixNano));
        expect(
          Object.fromEntries(span.attributes.map(({ key, value }) => [key, value.stringValue])),
        ).toEqual({
          "sentry.op": "rpc",
          "rpc.system.name": "cloudflare",
          "rpc.method": span.name,
          "server.address": span.name.split("/")[0],
        });
      }

      expect(JSON.stringify(spans)).not.toContain("native-tracing");
      expect(JSON.stringify(spans)).not.toContain("collector.test");
    }),
  // The first native call also loads the Worker and Durable Object modules in workerd.
  15_000,
);

it.effect("an unsampled live native parent stays unsampled across both receivers", () =>
  Effect.gen(function* () {
    const clientBodies: Array<string> = [];
    const parent = Tracer.externalSpan({
      traceId: "abcdef1234567890abcdef1234567890",
      spanId: "abcdef1234567890",
      sampled: false,
    });

    expect(
      yield* worker
        .read(9)
        .pipe(Effect.withParentSpan(parent), Effect.provide(capturedOtlpLayer(clientBodies))),
    ).toBe(10);

    const workerBodies = yield* worker.drain();
    const objectBodies = yield* TraceObject.byName("native-tracing")
      .drain()
      .pipe(Effect.provide(objectLayer));

    expect(
      spansIn([...clientBodies, ...workerBodies, ...objectBodies]).filter((span) =>
        span.name.endsWith("/read"),
      ),
    ).toEqual([]);
  }),
);

it.effect(
  "RPC spans preserve failures without exporting schema inputs or native error payloads",
  () =>
    Effect.gen(function* () {
      const clientBodies: Array<string> = [];
      const raw = ServiceBinding.makeClient<{
        reject(value: string): Promise<number>;
      }>({
        binding: "TRACE_WORKER",
        rpcTracing: true,
      })(exports.TestTracingWorker);
      const privateInput = "https://private.test/capability?credential=do-not-export";
      const error = yield* raw
        .call("reject", privateInput)
        .pipe(Effect.flip, Effect.provide(capturedOtlpLayer(clientBodies)));
      const workerBodies = yield* worker.drain();
      const bodies = [...clientBodies, ...workerBodies];
      const spans = spansIn(bodies).filter((span) => span.name === "TRACE_WORKER/reject");

      expect(error).toBeInstanceOf(ServiceBinding.ServiceBindingRpcError);
      expect(error.cause).toBeInstanceOf(RpcDefinition.RpcArgumentDecodeError);
      expect(error.message).toContain(privateInput);
      expect(spans.map(({ kind, status }) => ({ kind, status }))).toEqual([
        { kind: 3, status: { code: 2 } },
        { kind: 2, status: { code: 2 } },
      ]);
      expect(bodies.join("\n")).not.toContain(privateInput);
      expect(bodies.join("\n")).not.toContain("do-not-export");
    }),
);
