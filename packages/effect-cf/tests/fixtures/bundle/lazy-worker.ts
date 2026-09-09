import type { ExportedHandler, KVNamespace } from "@cloudflare/workers-types";
import { Effect } from "effect";

// Keep the root route small while measuring a real deferred Effect/KV handler.
export default {
  fetch(request, env) {
    if (new URL(request.url).pathname === "/health") {
      return new Response("ok");
    }

    return Effect.runPromise(
      Effect.promise(() => import("./kv")).pipe(
        Effect.flatMap((module) => Effect.promise(() => module.default.fetch(request, env))),
      ),
    );
  },
} satisfies ExportedHandler<{ STORE: KVNamespace }>;
