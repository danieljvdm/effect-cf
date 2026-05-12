import { Effect, Schema as S, type Layer, type Scope } from "effect";

import type { WorkerEnvironment } from "./Environment";
import * as QueueEntrypoint from "./Queue";
import * as QueueBinding from "./QueueBinding";
import type { ExecutionContext, WorkerContext } from "./Worker";
import * as WorkerEntrypoint from "./Worker";
import type * as RpcDefinition from "./RpcDefinition";

export interface Definition<
  Id extends string = string,
  Message extends RpcDefinition.ServiceFreeSchema = RpcDefinition.ServiceFreeSchema,
> {
  readonly id: Id;
  readonly message: Message;
}

export namespace Definition {
  export type Any = Definition<string, RpcDefinition.ServiceFreeSchema>;
}

declare const BindingServiceTypeId: unique symbol;

export interface BindingService<Id extends string, Self extends Definition.Any> {
  readonly [BindingServiceTypeId]: {
    readonly id: Id;
    readonly definition: Self;
  };
}

export type Handler<ROut, Self extends Definition.Any> = (
  batch: QueueEntrypoint.QueueBatch<S.Schema.Type<Self["message"]>>,
) => Effect.Effect<
  void,
  unknown,
  ExecutionContext | WorkerEntrypoint.WorkerContext | WorkerEnvironment | Scope.Scope | ROut
>;

export interface Options<ROut, Self extends Definition.Any> extends Omit<
  WorkerEntrypoint.WorkerOptions<ROut, Record<never, never>>,
  "queue" | "rpc"
> {
  readonly queue: Handler<ROut, Self>;
  readonly rpc?: never;
}

const makeDefinition = <Id extends string, Message extends RpcDefinition.ServiceFreeSchema>(
  id: Id,
  definition: { readonly message: Message },
) => {
  type SelfDefinition = Definition<Id, Message>;
  const queueDefinition: SelfDefinition = {
    id,
    message: definition.message,
  };

  return Object.assign(queueDefinition, {
    make: <ROut, LayerError>(
      layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
      options: Options<ROut, SelfDefinition>,
    ) =>
      WorkerEntrypoint.make(layer, {
        ...options,
        queue: wrapHandler(queueDefinition, options.queue),
      }),
    Binding:
      <Self>() =>
      <BindingId extends string>(
        bindingId: BindingId,
        binding: Omit<QueueBinding.QueueBindingDefinition<Message>, "message">,
      ) =>
        QueueBinding.Service<Self>()<BindingId, Message>(bindingId, {
          ...binding,
          message: definition.message,
        }),
    binding: <BindingId extends string>(
      bindingId: BindingId,
      binding: Omit<QueueBinding.QueueBindingDefinition<Message>, "message">,
    ) =>
      QueueBinding.Service<BindingService<BindingId, SelfDefinition>>()<BindingId, Message>(
        bindingId,
        {
          ...binding,
          message: definition.message,
        },
      ),
  });
};

export const make = makeDefinition;

export const Tag =
  <_Self>() =>
  <Id extends string, Message extends RpcDefinition.ServiceFreeSchema>(
    id: Id,
    definition: { readonly message: Message },
  ) => {
    const queueDefinition = makeDefinition(id, definition);

    abstract class QueueDefinitionClass {
      static readonly id = queueDefinition.id;
      static readonly message = queueDefinition.message;
      static readonly make = queueDefinition.make;
      static readonly Binding = queueDefinition.Binding;
      static readonly binding = queueDefinition.binding;
    }

    return QueueDefinitionClass as (abstract new () => object) & typeof queueDefinition;
  };

export const Queue = Tag;

const wrapHandler = <ROut, const Self extends Definition.Any>(
  definition: Self,
  handler: Handler<ROut, Self>,
): QueueEntrypoint.QueueHandler<ROut> => {
  const decodeBody = S.decodeUnknownEffect(definition.message);

  return (batch) =>
    Effect.gen(function* () {
      const decoded = yield* QueueEntrypoint.decodeBatch(batch.raw, decodeBody);
      yield* handler(decoded);
    });
};

export const implement = <ROut, const Self extends Definition.Any>(
  _definition: Self,
  handler: Handler<ROut, Self>,
): Handler<ROut, Self> => handler;
