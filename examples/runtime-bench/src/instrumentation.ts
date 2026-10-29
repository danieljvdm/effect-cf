import * as Effect from "effect/Effect";
import { SecureRandom } from "effect/crypto";

let isolateId: string | undefined;
const counters = new Map<string, number>();

export const mark = Effect.fnUntraced(function* (
  role: string,
  benchId: string,
  fields: Record<string, string | number | boolean> = {},
) {
  if (isolateId === undefined) {
    const random = yield* SecureRandom.SecureRandom;

    isolateId = yield* random.uuidV4();
  }
  const invocation = (counters.get(role) ?? 0) + 1;

  counters.set(role, invocation);
  const state = { isolateId, invocation, firstInvocation: invocation === 1 };

  console.log(
    JSON.stringify({ kind: "effect-cf-hot-benchmark", benchId, role, ...state, ...fields }),
  );

  return state;
});

export const headers = (state: { isolateId: string; invocation: number }) => ({
  "x-bench-isolate": state.isolateId,
  "x-bench-invocation": String(state.invocation),
});
