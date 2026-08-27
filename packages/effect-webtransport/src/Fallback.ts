/**
 * Effectful transport candidate selection with session pinning.
 *
 * Candidates are tried strictly in order; the first whose acquisition
 * succeeds is pinned for the lifetime of the surrounding scope. Selection
 * happens before any application traffic, so no in-flight request is ever
 * replayed across transports: once pinned, a dying transport fails the
 * consumer instead of silently failing over. Re-run selection at the
 * application level if a new transport decision is desired.
 *
 * A WebTransport candidate performs the real session handshake as its probe.
 * A WebSocket candidate acquires lazily (the socket connects per run), so it
 * is best placed last as the assumed-available fallback.
 */
import {
  type Array as Arr,
  type Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  Scope,
} from "effect";
import { Socket } from "effect/unstable/socket";

import * as WebTransport from "./WebTransport";
import * as WebTransportSocket from "./WebTransportSocket";

export interface Candidate<E = unknown, R = never> {
  readonly name: string;
  readonly socket: Effect.Effect<Socket.Socket, E, R>;
}

export interface SelectedTransport {
  readonly name: string;
  readonly socket: Socket.Socket;
}

export class TransportSelectionError extends Schema.TaggedError<TransportSelectionError>()(
  "TransportSelectionError",
  {
    failures: Schema.Array(Schema.Struct({ name: Schema.String, cause: Schema.Defect() })),
  },
) {
  override get message(): string {
    return `no transport candidate succeeded (tried: ${this.failures.map((failure) => failure.name).join(", ")})`;
  }
}

/**
 * WebTransport candidate: connects a session to `url` (the QUIC/HTTP-3
 * handshake is the probe) and, when pinned, serves one fresh reliable
 * bidirectional stream per `Socket.run`.
 *
 * Uses a `WebTransportConstructor` from the environment when one is provided,
 * and otherwise feature-detects `globalThis.WebTransport` — a platform
 * without WebTransport makes this candidate fail (and selection move on)
 * instead of failing the surrounding layer.
 */
export const webTransport = (
  url: string | Effect.Effect<string>,
  options?: WebTransport.ConnectOptions &
    WebTransportSocket.MakeSocketOptions & { readonly name?: string | undefined },
): Candidate<WebTransport.WebTransportError, Scope.Scope> => ({
  name: options?.name ?? "webtransport",
  socket: Effect.gen(function* () {
    const makeNative = yield* Effect.serviceOption(WebTransport.WebTransportConstructor).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => WebTransport.constructorGlobal,
          onSome: Effect.succeed,
        }),
      ),
    );
    const session = yield* WebTransport.connect(url, options).pipe(
      Effect.provideService(WebTransport.WebTransportConstructor, makeNative),
    );

    return yield* WebTransportSocket.fromBidirectionalStream(
      session.openBidirectionalStream(options?.sendStream),
      options,
    );
  }),
});

/**
 * WebSocket candidate. Acquisition itself cannot fail — the WebSocket
 * connects lazily on each `Socket.run` — so place it after candidates whose
 * viability is probed eagerly.
 */
export const webSocket = (
  url: string | Effect.Effect<string>,
  options?: {
    readonly name?: string | undefined;
    readonly closeCodeIsError?: ((code: number) => boolean) | undefined;
    readonly openTimeout?: Duration.Input | undefined;
    readonly protocols?: string | Array<string> | undefined;
  },
): Candidate<never, Socket.WebSocketConstructor> => ({
  name: options?.name ?? "websocket",
  socket: Socket.makeWebSocket(url, options),
});

export type CandidateContext<C extends Candidate<any, any>> =
  C extends Candidate<any, infer R> ? R : never;

/**
 * Tries candidates in order and pins the first that succeeds. Resources of a
 * failed candidate are released before the next candidate is tried; the
 * winning candidate's resources live in the surrounding scope.
 */
export const select = <const Candidates extends Arr.NonEmptyReadonlyArray<Candidate<any, any>>>(
  candidates: Candidates,
): Effect.Effect<
  SelectedTransport,
  TransportSelectionError,
  Exclude<CandidateContext<Candidates[number]>, Scope.Scope> | Scope.Scope
> =>
  Effect.gen(function* () {
    const outerScope = yield* Effect.scope;
    const failures: Array<{ name: string; cause: unknown }> = [];

    for (const candidate of candidates) {
      const candidateScope = yield* Scope.fork(outerScope);
      const selected = yield* candidate.socket.pipe(
        Scope.provide(candidateScope),
        Effect.map((socket): SelectedTransport => ({ name: candidate.name, socket })),
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : Scope.close(candidateScope, exit),
        ),
        Effect.catch((error) => {
          failures.push({ name: candidate.name, cause: error });

          return Effect.succeed(undefined);
        }),
      );

      if (selected !== undefined) {
        return selected;
      }
    }

    return yield* new TransportSelectionError({ failures });
  });

/**
 * Layer that provides a `Socket` from the first viable candidate, pinned for
 * the lifetime of the layer.
 */
export const layerSocket = <
  const Candidates extends Arr.NonEmptyReadonlyArray<Candidate<any, any>>,
>(
  candidates: Candidates,
): Layer.Layer<
  Socket.Socket,
  TransportSelectionError,
  Exclude<CandidateContext<Candidates[number]>, Scope.Scope>
> => Layer.effect(Socket.Socket)(Effect.map(select(candidates), (selected) => selected.socket));
