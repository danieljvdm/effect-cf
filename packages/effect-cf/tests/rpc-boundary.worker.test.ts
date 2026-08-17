/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { createExecutionContext, env } from "cloudflare:test";
import { Effect, Layer, Predicate, Schema as S } from "effect";
import { expect, test } from "vite-plus/test";

import { DurableObject, DurableObjectNamespace, Rpc, ServiceBinding, Worker } from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";

class Counter extends DurableObject.Tag<Counter>()("WorkerPoolCounter", {
  get: DurableObject.method({ success: S.Number }),
}) {}

class EchoWorker extends Worker.Tag<EchoWorker>()("WorkerPoolEcho", {
  echo: Worker.method({
    args: [S.String] as const,
    success: S.String,
  }),
}) {}

const EchoService = EchoWorker;

interface AuditReceipt {
  readonly room: string;
  readonly total: number;
  readonly sequence: number;
}

const AuditReceipt = S.Struct({
  room: S.String,
  total: S.Number,
  sequence: S.Number,
});

class MathWorker extends Worker.Tag<MathWorker>()("WorkerPoolMath", {
  double: Worker.method({
    args: [S.Number] as const,
    success: S.Number,
  }),
}) {}

class FormatWorker extends Worker.Tag<FormatWorker>()("WorkerPoolFormat", {
  summarize: Worker.method({
    args: [AuditReceipt] as const,
    success: S.String,
  }),
}) {}

class AuditLog extends DurableObject.Tag<AuditLog>()("WorkerPoolAuditLog", {
  append: DurableObject.method({
    args: [S.String, S.Number] as const,
    success: AuditReceipt,
  }),
}) {}

const MathService = MathWorker;
const FormatService = FormatWorker;

const durableObjectId = makePartialTestDouble<DurableObjectId>({
  toString: () => "worker-pool-counter",
});

const makeNamespace = <Stub extends object>(stub: Stub) => {
  const namespace = {
    newUniqueId: () => durableObjectId,
    idFromName: () => durableObjectId,
    idFromString: () => durableObjectId,
    get: () => stub,
    getByName: () => stub,
    jurisdiction: () => namespace,
  };

  return namespace;
};

test("namespace bindings resolve RPC calls inside the Workers runtime", async () => {
  const WorkerClass = Worker.make(Counter.layer({ binding: "COUNTERS" }), {
    fetch: Effect.gen(function* () {
      const stub = yield* Counter.getByName("counter");
      const value = yield* Counter.call(stub, "get");

      return Response.json({ value });
    }),
  });

  const instance = new WorkerClass(
    createExecutionContext(),
    makePartialTestDouble<Cloudflare.Env & { readonly COUNTERS: object }>({
      COUNTERS: makeNamespace({
        fetch: () => Promise.resolve(new Response(null, { status: 204 })),
        id: durableObjectId,
        get: () => Promise.resolve(37),
      }),
    }),
  );

  const response = await instance.fetch(new Request("https://worker.test/counter"));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ value: 37 });
});

test("namespace RPC validation fails with package errors inside the Workers runtime", async () => {
  const WorkerClass = Worker.make(Counter.layer({ binding: "COUNTERS" }), {
    fetch: Effect.gen(function* () {
      const stub = yield* Counter.getByName("counter");

      return yield* Counter.call(stub, "get").pipe(
        Effect.match({
          onFailure: (error) =>
            new Response(
              error instanceof DurableObjectNamespace.DurableObjectRpcError
                ? error._tag
                : "unknown",
              {
                status: 599,
              },
            ),
          onSuccess: (value) => Response.json({ value }),
        }),
      );
    }),
  });

  const instance = new WorkerClass(
    createExecutionContext(),
    makePartialTestDouble<Cloudflare.Env & { readonly COUNTERS: object }>({
      COUNTERS: makeNamespace({
        fetch: () => Promise.resolve(new Response(null, { status: 204 })),
        id: durableObjectId,
        get: 1,
      }),
    }),
  );

  const response = await instance.fetch(new Request("https://worker.test/counter"));

  expect(response.status).toBe(599);
  await expect(response.text()).resolves.toBe("DurableObjectRpcError");
});

test("service binding RPC validation runs inside the Workers runtime", async () => {
  const WorkerClass = Worker.make(EchoService.layer({ binding: "ECHO" }), {
    fetch: Effect.gen(function* () {
      return yield* EchoService.call("echo", "hello").pipe(
        Effect.match({
          onFailure: (error) =>
            new Response(
              error instanceof ServiceBinding.ServiceBindingRpcError ? error._tag : "unknown",
              {
                status: 599,
              },
            ),
          onSuccess: (value) => new Response(value),
        }),
      );
    }),
  });

  const invalid = new WorkerClass(
    createExecutionContext(),
    makePartialTestDouble<Cloudflare.Env & { readonly ECHO: object }>({
      ECHO: {
        fetch: () => Promise.resolve(new Response(null, { status: 204 })),
        echo: "not-callable",
      },
    }),
  );
  const invalidResponse = await invalid.fetch(new Request("https://worker.test/echo"));

  expect(invalidResponse.status).toBe(599);
  await expect(invalidResponse.text()).resolves.toBe("ServiceBindingRpcError");

  const valid = new WorkerClass(
    createExecutionContext(),
    makePartialTestDouble<Cloudflare.Env & { readonly ECHO: object }>({
      ECHO: {
        fetch: () => Promise.resolve(new Response(null, { status: 204 })),
        echo: (value: string) => Promise.resolve(value),
      },
    }),
  );
  const validResponse = await valid.fetch(new Request("https://worker.test/echo"));

  expect(validResponse.status).toBe(200);
  await expect(validResponse.text()).resolves.toBe("hello");
});

test("rpc decode failures keep their error tag across the Durable Object RPC boundary", async () => {
  const namespace = env.TEST_COUNTER_DO;

  if (namespace === undefined) {
    throw new Error("TEST_COUNTER_DO binding is missing");
  }

  const stub = namespace.get(namespace.idFromName("rpc-boundary-decode-error"));
  const cause = await Effect.runPromise(Rpc.resolve(stub.increment(123)).pipe(Effect.flip));

  expect(Predicate.isTagged(cause, "RpcArgumentDecodeError")).toBe(true);
  expect(cause).toMatchObject({
    definition: "TestCounter",
    method: "increment",
  });
});

test("workers compose service bindings and Durable Object RPC contracts in the Workers runtime", async () => {
  let sequence = 0;

  const MathWorkerClass = MathWorker.make(Layer.empty, {
    rpc: {
      double: (value) => Effect.succeed(value * 2),
    },
  });

  const FormatWorkerClass = FormatWorker.make(Layer.empty, {
    rpc: {
      summarize: (receipt) =>
        Effect.succeed(`${receipt.room}:${receipt.total}:${receipt.sequence}`),
    },
  });

  const ApiWorkerClass = Worker.make(
    Layer.mergeAll(
      MathService.layer({ binding: "MATH" }),
      FormatService.layer({ binding: "FORMAT" }),
      AuditLog.layer({ binding: "AUDIT_LOGS" }),
    ),
    {
      fetch: Effect.gen(function* () {
        const request = yield* Worker.NativeRequest;
        const value = Number(new URL(request.url).searchParams.get("value") ?? "0");
        const doubled = yield* MathService.call("double", value);
        const auditLog = yield* AuditLog.getByName("main");
        const receipt = yield* AuditLog.call(auditLog, "append", "main", doubled);
        const summary = yield* FormatService.call("summarize", receipt);

        return Response.json({
          receipt,
          summary,
        });
      }),
    },
  );

  const context = createExecutionContext();
  const instance = new ApiWorkerClass(
    context,
    makePartialTestDouble<
      Cloudflare.Env & {
        readonly MATH: object;
        readonly FORMAT: object;
        readonly AUDIT_LOGS: object;
      }
    >({
      MATH: new MathWorkerClass(context, makePartialTestDouble<Cloudflare.Env>({})),
      FORMAT: new FormatWorkerClass(context, makePartialTestDouble<Cloudflare.Env>({})),
      AUDIT_LOGS: makeNamespace({
        fetch: () => Promise.resolve(new Response(null, { status: 204 })),
        id: durableObjectId,
        append: (room: string, total: number): Promise<AuditReceipt> =>
          Promise.resolve({
            room,
            total,
            sequence: ++sequence,
          }),
      }),
    }),
  );

  const response = await instance.fetch(new Request("https://worker.test/run?value=21"));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    receipt: {
      room: "main",
      total: 42,
      sequence: 1,
    },
    summary: "main:42:1",
  });
});
