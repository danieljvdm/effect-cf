import { Effect, Layer, Schema } from "effect";
import { DurableObject, Worker, Workflow } from "effect-cf";

export class Counters extends DurableObject.Tag<Counters>()("Counters", {
  get: DurableObject.method({ success: Schema.Number }),
}) {}

export class CounterDurableObject extends Counters.make(Layer.empty, {
  rpc: { get: () => Effect.succeed(1) },
}) {}

export class Onboarding extends Workflow.Tag<Onboarding>()("Onboarding", {
  payload: Schema.Struct({ userId: Schema.String }),
  result: Schema.String,
}) {}

export class OnboardingWorkflow extends Onboarding.make(Layer.empty, {
  run: (payload) => Effect.succeed(payload.userId),
}) {}

export default Worker.make(Layer.empty, {
  fetch: Effect.succeed(new Response("ok")),
});
