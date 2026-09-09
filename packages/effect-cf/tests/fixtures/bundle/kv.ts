import type { ExportedHandler, KVNamespace } from "@cloudflare/workers-types";
import { Effect, Option, Schema } from "effect";
import { Kv } from "effect-cf";

const makeStore = Kv.makeClient({ binding: "STORE", key: Schema.String, value: Schema.String });

export default {
  fetch(_request, env) {
    return Effect.runPromise(
      makeStore(env.STORE)
        .get("greeting")
        .pipe(Effect.map((value) => new Response(Option.getOrElse(value, () => "missing")))),
    );
  },
} satisfies ExportedHandler<{ STORE: KVNamespace }>;
