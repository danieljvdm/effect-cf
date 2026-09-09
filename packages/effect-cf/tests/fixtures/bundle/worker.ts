import { Effect, Layer } from "effect";
import { Worker } from "effect-cf";

export default Worker.make(Layer.empty, {
  fetch: Effect.sync(() => new Response("ok")),
});
