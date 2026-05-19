import { Cause, Effect } from "effect";
import { Worker } from "effect-cf";
import { TodoStore } from "@effect-cf/todo-rpc-ws-domain";
const json = (value: unknown, init?: ResponseInit) => {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  return Response.json(value, { ...init, headers });
};
export const TodoRpcWsApiWorkerLive = Worker.make(TodoStore.layer({ binding: "TODO_STORE" }), {
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;
    const url = new URL(request.url);
    if (url.pathname === "/api/ws") {
      if (!Worker.isWebSocketUpgrade(request))
        return new Response("Expected WebSocket upgrade", { status: 426 });
      const stores = yield* TodoStore;
      const store = stores.byName("default");
      return yield* store
        .fetch(request)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.succeed(
              json(
                { error: "Todo store WebSocket upgrade failed", cause: Cause.pretty(cause) },
                { status: 502 },
              ),
            ),
          ),
        );
    }
    return json({ ok: true, websocket: "/api/ws", durableObject: "default" });
  }),
});
export default TodoRpcWsApiWorkerLive;
