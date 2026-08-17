import { Effect, Option } from "effect";
import { OtlpExporter } from "effect/unstable/observability";

/** Maximum event lifetime spent on an internally scheduled telemetry flush. */
const scheduledFlushTimeout = "2 seconds";

/**
 * Schedules a configured OTLP flusher through the current Cloudflare event.
 *
 * The handed-off effect is best-effort: it settles within two seconds and
 * silently absorbs every failure cause so telemetry cannot extend or fail the
 * user event, or recursively log through an unhealthy exporter.
 */
export const scheduleTelemetryFlush = <R>(
  waitUntil: (flush: Effect.Effect<void>) => Effect.Effect<void, never, R>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const flusher = yield* Effect.serviceOption(OtlpExporter.Flusher);

    if (Option.isNone(flusher)) {
      return;
    }

    // Exporters and platform schedulers are foreign boundaries. Do not log
    // their arbitrary failure causes: the configured logger may be the same
    // unhealthy OTLP exporter and recursively increase its backlog.
    yield* waitUntil(
      flusher.value.flush.pipe(
        Effect.timeoutOption(scheduledFlushTimeout),
        Effect.ignoreCause,
        Effect.asVoid,
      ),
    );
  }).pipe(Effect.ignoreCause);
