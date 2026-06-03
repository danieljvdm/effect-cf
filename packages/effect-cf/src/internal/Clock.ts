import { Clock, Duration, Effect, Layer } from "effect";

const maxTimerMillis = 2 ** 31 - 1;
const nanosPerMilli = BigInt(1_000_000);

export const clock: Clock.Clock = {
  currentTimeMillisUnsafe: () => Date.now(),
  currentTimeMillis: Effect.sync(() => clock.currentTimeMillisUnsafe()),
  currentTimeNanosUnsafe: () => BigInt(Date.now()) * nanosPerMilli,
  currentTimeNanos: Effect.sync(() => clock.currentTimeNanosUnsafe()),
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
