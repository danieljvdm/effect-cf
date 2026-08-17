/**
 * Truthful WebTransport / HTTP/3 boundary for Cloudflare Workers.
 *
 * What Cloudflare supports today (verified against primary sources, August
 * 2026):
 *
 * - Inbound HTTP/3 is a zone-level setting. Cloudflare's edge terminates the
 *   QUIC connection and invokes the Worker with an ordinary `fetch` Request;
 *   the inbound protocol is surfaced only as metadata on `request.cf`
 *   ({@link inboundTransport}).
 * - There is no runtime API for inbound WebTransport sessions — nothing
 *   analogous to `WebSocketPair`. workerd contains no QUIC/HTTP-3 stack, and
 *   the maintainers state WebTransport support "is not currently on our
 *   priority list" (cloudflare/workerd#6451, discussion #6454).
 * - There is no outbound WebTransport/QUIC/UDP client capability either;
 *   `cloudflare:sockets` `connect()` is TCP-only, and
 *   `@cloudflare/workers-types` contains no WebTransport types.
 * - Workers and Durable Objects can accept inbound WebSocket connections;
 *   Durable Objects additionally support hibernation (`acceptWebSocket`,
 *   `webSocketMessage`, `webSocketClose`).
 *
 * Consequently a browser's WebTransport session can never reach Worker code:
 * clients should attempt WebTransport only against origins that actually
 * speak it, and fall back to WebSockets for Cloudflare-hosted endpoints (see
 * the `effect-webtransport` package's `Fallback` module). This module gives
 * that reality a typed shape: {@link capabilities} feature-detects what the
 * current runtime provides, {@link inboundSessionsUnsupported} is the
 * explicit typed boundary for the missing inbound API, and
 * {@link inboundTransport} decodes the HTTP/3-relevant request metadata that
 * the edge does provide.
 */
import type { Request as CloudflareRequest } from "@cloudflare/workers-types";
import { Data, Effect, Option, Predicate, Result, Schema as S } from "effect";

/**
 * Metadata Cloudflare's edge reports about the inbound client connection.
 *
 * `httpProtocol` and `clientTcpRtt` are declared in
 * `@cloudflare/workers-types`; `clientQuicRtt` is documented by Cloudflare
 * ("only present when the client connected over QUIC (HTTP/3)") but not yet
 * present in the published types, so it is decoded from the open
 * `Record<string, unknown>` side of `request.cf`.
 */
export class InboundTransport extends S.Class<InboundTransport>("InboundTransport")({
  /** The HTTP protocol the client used, e.g. `"HTTP/2"` or `"HTTP/3"`. */
  httpProtocol: S.String,
  /** Client round-trip time; only present for QUIC (HTTP/3) connections. */
  clientQuicRtt: S.optional(S.Number),
  /** Client round-trip time; only present for TCP (HTTP/1.x, HTTP/2) connections. */
  clientTcpRtt: S.optional(S.Number),
}) {}

const decodeInboundTransport = S.decodeUnknownResult(InboundTransport);

/**
 * Decodes the inbound transport metadata from `request.cf`.
 *
 * Returns `None` when the metadata is absent (for example in local `wrangler
 * dev` or when a Worker invokes another Worker directly) or does not match
 * the expected shape.
 */
export const inboundTransport = (
  request: Pick<CloudflareRequest, "cf">,
): Option.Option<InboundTransport> => Result.getSuccess(decodeInboundTransport(request.cf));

/**
 * Returns `true` when the client reached Cloudflare's edge over QUIC
 * (HTTP/3). Prefers the documented QUIC signal (`clientQuicRtt` is only
 * present for QUIC connections) and falls back to the `httpProtocol` string.
 *
 * Note this describes the browser→edge hop only: the edge always terminates
 * QUIC, and the Worker still handles an ordinary `fetch` Request.
 */
export const isHttp3 = (transport: InboundTransport): boolean =>
  transport.clientQuicRtt !== undefined || transport.httpProtocol === "HTTP/3";

/** WebTransport-related capabilities of the current Workers runtime. */
export interface Capabilities {
  /**
   * Whether Worker code can accept inbound WebTransport sessions. Typed as
   * literally `false`: no such runtime API exists (cloudflare/workerd#6451),
   * so this can only change through a breaking, deliberate update when
   * Cloudflare ships one.
   */
  readonly inboundSessions: false;
  /**
   * Whether the runtime exposes a client `WebTransport` constructor global.
   * Feature-detected at runtime; `false` in workerd today, which has no
   * QUIC stack.
   */
  readonly outboundSessions: boolean;
}

/** Feature-detects the WebTransport capabilities of the current runtime. */
export const capabilities: Effect.Effect<Capabilities> = Effect.sync(() => {
  const runtime = globalThis;

  return {
    inboundSessions: false,
    outboundSessions:
      Predicate.hasProperty(runtime, "WebTransport") &&
      Predicate.isFunction(runtime["WebTransport"]),
  };
});

/** WebTransport capability missing from the current Workers runtime. */
export type WebTransportCapability = "inbound-sessions" | "outbound-sessions";

/** Raised when a WebTransport capability is unavailable in this runtime. */
export class WebTransportUnsupportedError extends Data.TaggedError("WebTransportUnsupportedError")<{
  readonly capability: WebTransportCapability;
}> {
  override get message(): string {
    return this.capability === "inbound-sessions"
      ? "Cloudflare Workers cannot accept inbound WebTransport sessions: the edge terminates QUIC and no runtime session API exists (cloudflare/workerd#6451). Use Durable Object WebSockets for bidirectional push."
      : "This Workers runtime provides no WebTransport client: workerd has no QUIC stack and cloudflare:sockets is TCP-only.";
  }
}

/**
 * The explicit typed boundary for inbound WebTransport sessions.
 *
 * Always fails with {@link WebTransportUnsupportedError} today. Route the
 * code path that would accept a session through this effect so the
 * limitation is visible in the type system and greppable when Cloudflare
 * ships a real API.
 */
export const inboundSessionsUnsupported: Effect.Effect<never, WebTransportUnsupportedError> =
  Effect.fail(new WebTransportUnsupportedError({ capability: "inbound-sessions" }));
