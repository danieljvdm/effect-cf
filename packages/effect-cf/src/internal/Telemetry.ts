import { Effect, Option } from "effect";
import { OtlpExporter } from "effect/unstable/observability";

/** Maximum event lifetime spent on an internally scheduled telemetry flush. */
const scheduledFlushTimeout = "2 seconds";

const logFlushSchedulingFailure = Effect.logError("Telemetry flush scheduling failed").pipe(
  Effect.ignoreCause,
);

/**
 * Schedules a configured OTLP flusher through the current Cloudflare event.
 */
export const scheduleTelemetryFlush = <R>(
  waitUntil: (flush: Effect.Effect<void>) => Effect.Effect<void, never, R>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const flusher = yield* Effect.serviceOption(OtlpExporter.Flusher);

    if (Option.isNone(flusher)) {
      return;
    }

    yield* waitUntil(
      flusher.value.flush.pipe(
        Effect.timeoutOption(scheduledFlushTimeout),
        Effect.ignoreCause,
        Effect.asVoid,
      ),
    );
  }).pipe(Effect.catchCause(() => logFlushSchedulingFailure));
