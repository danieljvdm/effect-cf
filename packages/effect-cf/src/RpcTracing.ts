import { Cause, Clock, Context, Effect, Exit, Option, References, Schema, Tracer } from "effect";

/** Live native RPC metadata. Never store this in durable messages or envelopes. */
export const RpcTraceContext = Schema.Struct({
  _tag: Schema.Literal("effect-cf/RpcTraceContext/v1"),
  traceId: Schema.String.check(Schema.isPattern(/^(?!0{32}$)[0-9a-f]{32}$/)),
  spanId: Schema.String.check(Schema.isPattern(/^(?!0{16}$)[0-9a-f]{16}$/)),
  sampled: Schema.Boolean,
});

export type RpcTraceContext = typeof RpcTraceContext.Type;

export interface ReceiverOptions {
  /** Stable service name, never an instance id or capability URL. */
  readonly service: string;
}

/** Per-invocation metadata passed to Worker and DurableObject RunSymbol overrides. */
export interface RpcInvocationInfo {
  readonly service: string;
  readonly method: string;
  /** Native arguments with valid, opted-in trace metadata removed. Do not log them. */
  readonly args: ReadonlyArray<unknown>;
  /**
   * Set after a definition-backed receiver decodes its arguments, before its
   * handler runs. Absent before decoding and when decoding fails. Do not log it.
   */
  readonly decodedArgs?: ReadonlyArray<unknown>;
  readonly parent?: RpcTraceContext;
}

const isRpcTraceContext = Schema.is(RpcTraceContext);

/**
 * Appends the current live parent only for a receiver that has opted in.
 * Call this inside the CLIENT span, immediately before the native invocation.
 * With no valid propagating parent, the original argument array is returned.
 */
export const withRpcTraceContext = Effect.fnUntraced(function* (
  args: ReadonlyArray<unknown>,
): Effect.fn.Return<ReadonlyArray<unknown>> {
  if (yield* Tracer.DisablePropagation) {
    return args;
  }

  const parent = yield* Effect.serviceOption(Tracer.ParentSpan);

  if (Option.isNone(parent) || Context.get(parent.value.annotations, Tracer.DisablePropagation)) {
    return args;
  }

  const context = {
    _tag: "effect-cf/RpcTraceContext/v1",
    traceId: parent.value.traceId,
    spanId: parent.value.spanId,
    sampled: parent.value.sampled,
  };

  return isRpcTraceContext(context) ? [...args, context] : args;
});

const attributes = (service: string, method: string) => ({
  "sentry.op": "rpc",
  "rpc.system.name": "cloudflare",
  "rpc.method": `${service}/${method}`,
  "server.address": service,
});

const withRpcSpan = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  service: string,
  method: string,
  options: Tracer.SpanOptionsNoTrace,
): Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>> =>
  Effect.useSpan(
    `${service}/${method}`,
    {
      ...options,
      attributes: attributes(service, method),
    },
    (span) =>
      effect.pipe(
        Effect.withParentSpan(span),
        Effect.onExit((exit) => {
          if (
            Exit.isSuccess(exit) ||
            Cause.hasInterruptsOnly(exit.cause) ||
            span.status._tag === "Ended"
          ) {
            return Effect.void;
          }

          // OTLP's default cause formatter includes schema inputs and native error
          // messages. End with a safe failure, while returning the original exit.
          return Effect.gen(function* () {
            const timing = yield* References.TracerTimingEnabled;
            const endTime = timing ? yield* Clock.currentTimeNanos : 0n;

            span.attribute("error.type", "_OTHER");
            span.end(endTime, Exit.fail("RPC failed"));
          });
        }),
      ),
  );

/** Wrap the whole call, including native result resolution and success decoding. */
export const withRpcClientSpan = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  binding: string,
  method: string,
): Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>> =>
  withRpcSpan(effect, binding, method, {
    kind: "client",
  });

/**
 * Optional application instrumentation for the entire receiver effect.
 * Use in a RunSymbol override to include argument decode, handler and encode.
 * Records stable service/method attributes and failure status, not argument or
 * error payloads. The original typed failure still propagates to the caller.
 */
export const withRpcServerSpan = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  invocation: RpcInvocationInfo,
): Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>> =>
  withRpcSpan(effect, invocation.service, invocation.method, {
    kind: "server",
    parent: invocation.parent === undefined ? undefined : Tracer.externalSpan(invocation.parent),
  });
