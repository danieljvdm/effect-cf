import { Effect, Option } from "effect";
import { OtlpExporter } from "effect/unstable/observability";

const logFlushFailure = Effect.logError("Telemetry flush failed").pipe(Effect.ignoreCause);

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

    // Exporters and platform schedulers are foreign boundaries. Preserve a
    // useful diagnostic without retaining their arbitrary failure causes in
    // logs, where payloads, headers, or credentials could otherwise escape.
    yield* waitUntil(flusher.value.flush.pipe(Effect.catchCause(() => logFlushFailure)));
  }).pipe(Effect.catchCause(() => logFlushSchedulingFailure));
