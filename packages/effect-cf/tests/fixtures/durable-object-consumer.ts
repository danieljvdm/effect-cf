import { Effect, Layer, Schema } from "effect";
import { DurableObject, RpcTracing, Worker } from "effect-cf";

class Counter extends DurableObject.Tag<Counter>()("Counter", {
  read: DurableObject.method({ success: Schema.Finite }),
}) {}

export const CounterLive = Counter.layer({ binding: "COUNTERS", rpcTracing: true });

const CounterBase = Counter.make(Layer.empty, {
  rpcTracing: { service: "COUNTERS" },
  rpc: { read: () => Effect.succeed(42) },
});

export class ExampleDurableObject extends CounterBase {
  override [DurableObject.RunSymbol]<A, E>(
    effect: Effect.Effect<A, E, Effect.Services<DurableObject.DurableObjectHandler<never>>>,
    options: DurableObject.RunOptions = {},
  ): Promise<A> {
    return super[DurableObject.RunSymbol](
      options.rpc === undefined ? effect : RpcTracing.withRpcServerSpan(effect, options.rpc),
      options,
    );
  }
}

class Api extends Worker.Tag<Api>()("Api", {
  read: Worker.method({ success: Schema.Finite }),
}) {}

const WorkerBase = Api.make(CounterLive, {
  rpcTracing: { service: "API" },
  rpc: { read: () => Counter.byName("default").read() },
});

export class ExampleWorker extends WorkerBase {
  override [Worker.RunSymbol]<A, E>(
    effect: Effect.Effect<A, E, Effect.Services<Worker.WorkerRpcHandler<Counter>>>,
    options: Worker.RunOptions = {},
  ): Promise<A> {
    return super[Worker.RunSymbol](
      options.rpc === undefined ? effect : RpcTracing.withRpcServerSpan(effect, options.rpc),
      options,
    );
  }
}
