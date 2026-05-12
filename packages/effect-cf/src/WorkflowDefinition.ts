import { Effect, Schema as S, type Layer } from "effect";

import type { WorkerEnvironment } from "./Environment";
import type { ExecutionContext, WorkerContext } from "./Worker";
import type * as RpcDefinition from "./RpcDefinition";
import * as WorkflowBinding from "./WorkflowBinding";
import * as WorkflowEntrypoint from "./Workflow";

export interface Definition<
  Id extends string = string,
  Payload extends RpcDefinition.ServiceFreeSchema = RpcDefinition.ServiceFreeSchema,
  Result extends RpcDefinition.ServiceFreeSchema = RpcDefinition.ServiceFreeSchema,
> {
  readonly id: Id;
  readonly payload: Payload;
  readonly result: Result;
}

export namespace Definition {
  export type Any = Definition<
    string,
    RpcDefinition.ServiceFreeSchema,
    RpcDefinition.ServiceFreeSchema
  >;
}

declare const BindingServiceTypeId: unique symbol;

export interface BindingService<Id extends string, Self extends Definition.Any> {
  readonly [BindingServiceTypeId]: {
    readonly id: Id;
    readonly definition: Self;
  };
}

export type Handler<ROut, Self extends Definition.Any> = (
  payload: S.Schema.Type<Self["payload"]>,
) => Effect.Effect<
  S.Schema.Type<Self["result"]>,
  unknown,
  WorkflowEntrypoint.WorkflowRunContext<ROut>
>;

export interface Options<ROut, Self extends Definition.Any> {
  readonly run: Handler<ROut, Self>;
}

const makeDefinition = <
  Id extends string,
  Payload extends RpcDefinition.ServiceFreeSchema,
  Result extends RpcDefinition.ServiceFreeSchema,
>(
  id: Id,
  definition: {
    readonly payload: Payload;
    readonly result: Result;
  },
) => {
  type SelfDefinition = Definition<Id, Payload, Result>;
  const workflowDefinition: SelfDefinition = {
    id,
    payload: definition.payload,
    result: definition.result,
  };

  return Object.assign(workflowDefinition, {
    make: <ROut, LayerError>(
      layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
      options: Options<ROut, SelfDefinition>,
    ) =>
      WorkflowEntrypoint.make(layer, {
        run: wrapHandler(workflowDefinition, options.run),
      }),
    Binding:
      <Self>() =>
      <BindingId extends string>(
        bindingId: BindingId,
        binding: Omit<
          WorkflowBinding.WorkflowBindingDefinition<Payload, Result>,
          "payload" | "result"
        >,
      ) =>
        WorkflowBinding.Service<Self>()<BindingId, Payload, Result>(bindingId, {
          ...binding,
          payload: definition.payload,
          result: definition.result,
        }),
    binding: <BindingId extends string>(
      bindingId: BindingId,
      binding: Omit<
        WorkflowBinding.WorkflowBindingDefinition<Payload, Result>,
        "payload" | "result"
      >,
    ) =>
      WorkflowBinding.Service<BindingService<BindingId, SelfDefinition>>()<
        BindingId,
        Payload,
        Result
      >(bindingId, {
        ...binding,
        payload: definition.payload,
        result: definition.result,
      }),
  });
};

export const make = makeDefinition;

export const Tag =
  <_Self>() =>
  <
    Id extends string,
    Payload extends RpcDefinition.ServiceFreeSchema,
    Result extends RpcDefinition.ServiceFreeSchema,
  >(
    id: Id,
    definition: {
      readonly payload: Payload;
      readonly result: Result;
    },
  ) => {
    const workflowDefinition = makeDefinition(id, definition);

    abstract class WorkflowDefinitionClass {
      static readonly id = workflowDefinition.id;
      static readonly payload = workflowDefinition.payload;
      static readonly result = workflowDefinition.result;
      static readonly make = workflowDefinition.make;
      static readonly Binding = workflowDefinition.Binding;
      static readonly binding = workflowDefinition.binding;
    }

    return WorkflowDefinitionClass as (abstract new () => object) & typeof workflowDefinition;
  };

export const Workflow = Tag;

const wrapHandler = <ROut, const Self extends Definition.Any>(
  definition: Self,
  handler: Handler<ROut, Self>,
): WorkflowEntrypoint.WorkflowHandler<
  ROut,
  S.Codec.Encoded<Self["payload"]>,
  S.Codec.Encoded<Self["result"]>
> => {
  const decodePayload = S.decodeUnknownEffect(definition.payload);
  const encodeResult = S.encodeEffect(definition.result);

  return (payload) =>
    Effect.gen(function* () {
      const decodedPayload = yield* decodePayload(payload);
      const event = yield* WorkflowEntrypoint.WorkflowEvent;
      const decodedEvent = {
        ...event,
        payload: decodedPayload,
      } as WorkflowEntrypoint.WorkflowEventService<S.Schema.Type<Self["payload"]>>;
      const result = yield* handler(decodedPayload as S.Schema.Type<Self["payload"]>).pipe(
        Effect.provideService(WorkflowEntrypoint.WorkflowEvent, decodedEvent),
      );
      return yield* encodeResult(result as S.Schema.Type<Self["result"]>);
    });
};

export const implement = <ROut, const Self extends Definition.Any>(
  _definition: Self,
  handler: Handler<ROut, Self>,
): Handler<ROut, Self> => handler;
