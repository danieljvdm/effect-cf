import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const TraceEvent = Schema.Struct({
  spanContext: Schema.Struct({ traceId: Schema.String, spanId: Schema.optional(Schema.String) }),
  event: Schema.Struct({
    type: Schema.String,
    name: Schema.optional(Schema.String),
    spanId: Schema.optional(Schema.String),
    info: Schema.optional(Schema.Unknown),
  }),
});
const decodeTrace = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(TraceEvent)));
const decodeAttributes = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      value: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
    }),
  ),
);

const bundle = Effect.fnUntraced(function* (name: string) {
  const result = yield* Effect.promise(() =>
    build({
      entryPoints: [new URL(`./fixtures/${name}.ts`, import.meta.url).pathname],
      bundle: true,
      external: ["cloudflare:*", "node:*"],
      format: "esm",
      platform: "browser",
      write: false,
    }),
  );

  return result.outputFiles[0]!.text;
});

it.live(
  "records Effect spans and platform children with isolated fiber and request contexts",
  () =>
    Effect.gen(function* () {
      const script = yield* bundle("cloudflare-tracer-worker");
      const collectorScript = yield* bundle("cloudflare-tracer-collector");
      const mf = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Miniflare(
              convertV4MiniflareOptions({
                workers: [
                  {
                    name: "traced",
                    modules: true,
                    script,
                    compatibilityDate: "2026-08-25",
                    compatibilityFlags: ["streaming_tail_worker", "tail_worker_user_spans"],
                    streamingTails: ["collector"],
                    outboundService: "backend",
                  },
                  {
                    name: "untraced",
                    modules: true,
                    script,
                    compatibilityDate: "2026-08-25",
                    outboundService: "backend",
                  },
                  {
                    name: "collector",
                    modules: true,
                    script: collectorScript,
                    compatibilityDate: "2026-08-25",
                  },
                  {
                    name: "backend",
                    modules: true,
                    script: 'export default { fetch() { return new Response("ok"); } };',
                    compatibilityDate: "2026-08-25",
                  },
                ],
              }),
            ),
        ),
        (mf) => Effect.promise(() => mf.dispose()),
      );
      const responses = yield* Effect.promise(() =>
        Promise.all([
          mf.dispatchFetch("https://worker.test/one"),
          mf.dispatchFetch("https://worker.test/two"),
        ]),
      );

      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.json())).toEqual({
          result: ["left", "right"],
          sampled: true,
        });
      }

      const collector = yield* Effect.promise(() => mf.getWorker("collector"));
      const traces = yield* Effect.forEach([1, 2], () =>
        Effect.promise(() => collector.fetch("https://collector.test/")).pipe(
          Effect.flatMap((response) => Effect.promise(() => response.text())),
          Effect.map(decodeTrace),
        ),
      );

      expect(new Set(traces.map((trace) => trace[0]!.spanContext.traceId)).size).toBe(2);
      const requestIds: Array<string | number | boolean | undefined> = [];

      for (const trace of traces) {
        const spans = trace.filter(({ event }) => event.type === "spanOpen");
        const span = (name: string) => {
          const matches = spans.filter(({ event }) => event.name === name);

          expect(matches).toHaveLength(1);

          return matches[0]!;
        };
        const attributes = (id: string) =>
          Object.fromEntries(
            trace
              .filter(
                ({ event, spanContext }) =>
                  event.type === "attributes" && spanContext.spanId === id,
              )
              .flatMap(({ event }) =>
                decodeAttributes(event.info).map(({ name, value }) => [name, value]),
              ),
          );
        const operation = span("operation").event.spanId!;
        const branches = spans.filter(({ event }) => event.name === "branch");

        expect(branches).toHaveLength(2);
        expect(span("operation").spanContext.spanId).toBe(span("http.server GET").event.spanId);
        expect(span("http.server GET").spanContext.spanId).toBe(trace[0]!.event.spanId);

        for (const branch of branches) {
          const id = branch.event.spanId!;
          const name = attributes(id).branch;

          expect(branch.spanContext.spanId).toBe(operation);
          expect(span(`${name}.native`).spanContext.spanId).toBe(id);
          expect(
            spans.filter(
              ({ event, spanContext }) => event.name === "fetch" && spanContext.spanId === id,
            ),
          ).toHaveLength(1);
        }

        for (const name of ["failure", "defect", "interrupted"]) {
          expect(span(name).spanContext.spanId).toBe(operation);
          expect(attributes(span(name).event.spanId!)["effect.exit"]).toBe(
            name === "interrupted" ? "interrupted" : "failure",
          );
        }

        expect(span("root").spanContext.spanId).toBe(trace[0]!.event.spanId);
        expect(span("root.native").spanContext.spanId).toBe(span("root").event.spanId);
        expect(span("after.native").spanContext.spanId).toBe(operation);
        expect(span("unsampled.native").spanContext.spanId).toBe(operation);
        expect(spans.some(({ event }) => event.name === "unsampled")).toBe(false);
        expect(span("disabled.native").spanContext.spanId).toBe(operation);
        expect(spans.some(({ event }) => event.name === "disabled")).toBe(false);
        expect(attributes(operation)).toMatchObject({
          "scalar.number": 42,
          "scalar.boolean": true,
          "effect.exit": "success",
        });
        expect(attributes(operation)).not.toHaveProperty("unsupported");
        requestIds.push(attributes(operation)["request.id"]);

        for (const { event, spanContext } of spans) {
          expect(spanContext.traceId).toBe(trace[0]!.spanContext.traceId);
          expect(
            trace.filter(
              (entry) =>
                entry.event.type === "spanClose" && entry.spanContext.spanId === event.spanId,
            ),
          ).toHaveLength(1);
        }
      }

      expect(requestIds.toSorted()).toEqual(["/one", "/two"]);
      const untraced = yield* Effect.promise(() => mf.getWorker("untraced"));
      const response = yield* Effect.promise(() => untraced.fetch("https://worker.test/untraced"));

      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        result: ["left", "right"],
        sampled: false,
      });
    }).pipe(Effect.scoped),
  { timeout: 30_000 },
);
