import * as Effect from "effect/Effect";

let isolateId: string | undefined;
const counters = new Map<string, number>();

export const mark = (
  role: string,
  benchId: string,
  fields: Record<string, string | number | boolean> = {},
) =>
  Effect.sync(() => {
    isolateId ??= crypto.randomUUID();
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
