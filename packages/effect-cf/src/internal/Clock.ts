import { Clock, Duration, Effect, Layer } from "effect";

const maxTimerMillis = 2 ** 31 - 1;
const nanosPerMilli = BigInt(1_000_000);

export const clock: Clock.Clock = {
  currentTimeMillisUnsafe: () => Date.now(),
  currentTimeMillis: Effect.sync(() => clock.currentTimeMillisUnsafe()),
  currentTimeNanosUnsafe: () => BigInt(Date.now()) * nanosPerMilli,
  currentTimeNanos: Effect.sync(() => clock.currentTimeNanosUnsafe()),
  // Workers expose `performance.now()` as time since worker start. It advances
  // only across I/O, like `Date.now()`, but it never moves backward.
  monotonicTimeNanosUnsafe: () =>
    typeof performance === "undefined"
      ? BigInt(Date.now()) * nanosPerMilli
      : BigInt(Math.round(performance.now() * 1_000_000)),
  monotonicTimeNanos: Effect.sync(() => clock.monotonicTimeNanosUnsafe()),
  sleep: (duration) => {
    const millis = Duration.toMillis(duration);

    if (millis <= 0) {
      return Effect.yieldNow;
    }

    return Effect.callback<void>((resume) => {
      if (millis > maxTimerMillis) {
        return;
      }

      const handle = setTimeout(() => resume(Effect.void), millis);

      return Effect.sync(() => clearTimeout(handle));
    });
  },
};

export const layer = Layer.effect(Clock.Clock, Effect.succeed(clock));
