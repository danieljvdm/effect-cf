import { Effect } from "effect";

import { DurableObjectState } from "./DurableObjectState";

/**
 * Options for accepting an incoming websocket request in a Durable Object.
 */
export interface AcceptUpgradeOptions<Attachment = unknown> {
  /** Optional websocket tags for Durable Object hibernation filtering. */
  readonly tags?: ReadonlyArray<string> | undefined;
  /** Optional attachment serialized onto the server socket. */
  readonly attachment?: Attachment | undefined;
}

/**
 * Result of a websocket upgrade accepted by {@link acceptUpgrade}.
 */
export interface AcceptedUpgrade {
  readonly client: WebSocket;
  readonly server: WebSocket;
  readonly response: Response;
}

/**
 * Accepts a websocket upgrade and registers the server socket on `DurableObjectState`.
 *
 * @example
 * ```ts
 * const response = yield* DurableObjectWebSocket.acceptUpgrade({
 *   tags: ["room:general"],
 * });
 *
 * return response.response;
 * ```
 */
export const acceptUpgrade = <Attachment = unknown>(
  options: AcceptUpgradeOptions<Attachment> = {},
): Effect.Effect<AcceptedUpgrade, never, DurableObjectState> =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    if (options.attachment !== undefined) {
      server.serializeAttachment(options.attachment);
    }

    yield* state.acceptWebSocket(
      server,
      options.tags === undefined ? undefined : [...options.tags],
    );

    return {
      client,
      server,
      response: new Response(null, {
        status: 101,
        webSocket: client,
      }),
    };
  });
