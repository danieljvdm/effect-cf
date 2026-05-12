/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { createExecutionContext } from "cloudflare:test";
import { Effect, Layer, Schema as S } from "effect";
import { expect, test } from "vite-plus/test";

import { DurableObject, DurableObjectNamespace, ServiceBinding, Worker } from "../src/index";

class Counter extends DurableObject.Tag<Counter>()("WorkerPoolCounter", {
  get: DurableObject.method({ success: S.Number }),
}) {}

class Counters extends Counter.Namespace<Counters>()("effect-cf/test/WorkerPoolCounters", {
  binding: "COUNTERS",
}) {}

class EchoWorker extends Worker.Tag<EchoWorker>()("WorkerPoolEcho", {
  echo: Worker.method({
    args: [S.String] as const,
    success: S.String,
  }),
}) {}

class EchoService extends EchoWorker.Binding<EchoService>()(
  "effect-cf/test/WorkerPoolEchoService",
  {
    binding: "ECHO",
  },
) {}

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

class MathService extends MathWorker.Binding<MathService>()("effect-cf/test/MathService", {
  binding: "MATH",
}) {}

class FormatService extends FormatWorker.Binding<FormatService>()("effect-cf/test/FormatService", {
  binding: "FORMAT",
}) {}

class AuditLogs extends AuditLog.Namespace<AuditLogs>()("effect-cf/test/AuditLogs", {
  binding: "AUDIT_LOGS",
}) {}

const durableObjectId = {
  toString: () => "worker-pool-counter",
} as unknown as DurableObjectId;

const makeNamespace = (stub: unknown) => {
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
  const WorkerClass = Worker.make(Counters.layer, {
    fetch: Effect.gen(function* () {
      const stub = yield* Counters.getByName("counter");
      const value = yield* Counters.call(stub, "get");

      return Response.json({ value });
    }),
  });

  const instance = new WorkerClass(createExecutionContext(), {
    COUNTERS: makeNamespace({
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
      id: durableObjectId,
      get: () => Promise.resolve(37),
    }),
  } as unknown as Cloudflare.Env);

  const response = await instance.fetch(new Request("https://worker.test/counter"));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ value: 37 });
});

test("namespace RPC validation fails with package errors inside the Workers runtime", async () => {
  const WorkerClass = Worker.make(Counters.layer, {
    fetch: Effect.gen(function* () {
      const stub = yield* Counters.getByName("counter");

      return yield* Counters.call(stub, "get").pipe(
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

  const instance = new WorkerClass(createExecutionContext(), {
    COUNTERS: makeNamespace({
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
      id: durableObjectId,
      get: 1,
    }),
  } as unknown as Cloudflare.Env);

  const response = await instance.fetch(new Request("https://worker.test/counter"));

  expect(response.status).toBe(599);
  await expect(response.text()).resolves.toBe("DurableObjectRpcError");
});

test("service binding RPC validation runs inside the Workers runtime", async () => {
  const WorkerClass = Worker.make(EchoService.layer, {
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

  const invalid = new WorkerClass(createExecutionContext(), {
    ECHO: {
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
      echo: "not-callable",
    },
  } as unknown as Cloudflare.Env);
  const invalidResponse = await invalid.fetch(new Request("https://worker.test/echo"));

  expect(invalidResponse.status).toBe(599);
  await expect(invalidResponse.text()).resolves.toBe("ServiceBindingRpcError");

  const valid = new WorkerClass(createExecutionContext(), {
    ECHO: {
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
      echo: (value: string) => Promise.resolve(value),
    },
  } as unknown as Cloudflare.Env);
  const validResponse = await valid.fetch(new Request("https://worker.test/echo"));

  expect(validResponse.status).toBe(200);
  await expect(validResponse.text()).resolves.toBe("hello");
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
    Layer.mergeAll(MathService.layer, FormatService.layer, AuditLogs.layer),
    {
      fetch: Effect.gen(function* () {
        const request = yield* Worker.NativeRequest;
        const value = Number(new URL(request.url).searchParams.get("value") ?? "0");
        const doubled = yield* MathService.call("double", value);
        const auditLog = yield* AuditLogs.getByName("main");
        const receipt = yield* AuditLogs.call(auditLog, "append", "main", doubled);
        const summary = yield* FormatService.call("summarize", receipt);

        return Response.json({
          receipt,
          summary,
        });
      }),
    },
  );

  const context = createExecutionContext();
  const instance = new ApiWorkerClass(context, {
    MATH: new MathWorkerClass(context, {} as Cloudflare.Env),
    FORMAT: new FormatWorkerClass(context, {} as Cloudflare.Env),
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
  } as unknown as Cloudflare.Env);

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
