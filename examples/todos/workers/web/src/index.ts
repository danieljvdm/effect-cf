import { DatabaseError, TodoRpcGroup } from "@effect-cf/todos-domain";
import { Cause, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { Worker } from "effect-cf";

import { ApiWorker, Assets, TodoRpcClient } from "./bindings";

const json = (value: unknown, init?: ResponseInit) => {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  return Response.json(value, { ...init, headers });
};

const rewriteApiRequest = (request: Request, url: URL) => {
  const forwardedUrl = new URL(url.toString());
  forwardedUrl.pathname = url.pathname.replace(/^\/api/, "") || "/";
  return new Request(forwardedUrl, request);
};

const cacheHeaders = { "cache-control": "no-store" };

const mapRpcBridgeError = (error: unknown) =>
  error instanceof DatabaseError
    ? error
    : new DatabaseError({ message: "web Worker RPC bridge failed" });

const TodoRpcBridgeLive = TodoRpcGroup.toLayer({
  GetStats: () =>
    Effect.gen(function* () {
      const rpc = yield* TodoRpcClient;
      return yield* rpc.GetStats().pipe(Effect.mapError(mapRpcBridgeError));
    }),
  ClearCompleted: () =>
    Effect.gen(function* () {
      const rpc = yield* TodoRpcClient;
      return yield* rpc.ClearCompleted().pipe(Effect.mapError(mapRpcBridgeError));
    }),
});

const BrowserRpcLive = RpcServer.layerHttp({
  group: TodoRpcGroup,
  path: "/api/rpc",
  protocol: "http",
}).pipe(
  Layer.provide(TodoRpcBridgeLive),
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(TodoRpcClient.layer),
);

const BaseLive = Layer.mergeAll(Assets.layer, ApiWorker.layer, HttpRouter.layer);
const layer = Layer.mergeAll(TodoRpcClient.layer, BrowserRpcLive).pipe(
  Layer.provideMerge(BaseLive),
);

const renderRpc = Effect.gen(function* () {
  const router = yield* HttpRouter.HttpRouter;
  const context = yield* Effect.context<never>();
  const response = yield* router.asHttpEffect().pipe(
    Effect.map(HttpServerResponse.setHeaders(cacheHeaders)),
    Effect.catchCause((cause) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { error: "Unhandled web Worker RPC bridge error", cause: Cause.pretty(cause) },
          { status: 500, headers: cacheHeaders },
        ),
      ),
    ),
  );
  return HttpServerResponse.toWeb(response, { context });
});

export const TodoWebWorkerLive = Worker.make(layer, {
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/rpc") {
      return yield* renderRpc;
    }

    if (request.method === "GET" && url.pathname === "/api/rpc/stats") {
      const rpc = yield* TodoRpcClient;
      return yield* rpc.GetStats().pipe(
        Effect.map((stats) => json(stats)),
        Effect.catchCause((cause) =>
          Effect.succeed(
            json(
              { error: "Effect RPC stats request failed", cause: Cause.pretty(cause) },
              { status: 502 },
            ),
          ),
        ),
      );
    }

    if (request.method === "POST" && url.pathname === "/api/rpc/clear-completed") {
      const rpc = yield* TodoRpcClient;
      return yield* rpc.ClearCompleted().pipe(
        Effect.map((stats) => json(stats)),
        Effect.catchCause((cause) =>
          Effect.succeed(
            json(
              { error: "Effect RPC clear-completed request failed", cause: Cause.pretty(cause) },
              { status: 502 },
            ),
          ),
        ),
      );
    }

    if (url.pathname.startsWith("/api/")) {
      return yield* ApiWorker.fetch(rewriteApiRequest(request, url));
    }

    const assets = yield* Assets;
    return yield* Effect.tryPromise(() => assets.fetch(request));
  }),
});

export default TodoWebWorkerLive;
