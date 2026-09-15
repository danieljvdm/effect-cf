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
    message: Schema.optional(Schema.Unknown),
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
const decodeResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Array(Schema.String),
      sampled: Schema.Boolean,
      traceId: Schema.String,
      spanId: Schema.String,
      unsafeCalls: Schema.Number,
    }),
  ),
);
const decodeEventLog = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      "effect.event": Schema.String,
      "effect.event.time_unix_nano": Schema.String,
      "effect.trace_id": Schema.String,
      "effect.span_id": Schema.String,
      attributes: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
);
const decodeLinks = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        traceId: Schema.String,
        spanId: Schema.String,
      }),
    ),
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

it.live.each(["default", "events", "diagnostics", "throwing"])(
  "preserves native telemetry and isolated span contexts (%s)",
  (mode) =>
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
                    bindings: { TRACER_MODE: mode },
                    modules: true,
                    script,
                    compatibilityDate: "2026-08-25",
                    compatibilityFlags: ["streaming_tail_worker", "tail_worker_user_spans"],
                    streamingTails: ["collector"],
                    outboundService: "backend",
                  },
                  {
                    name: "untraced",
                    bindings: { TRACER_MODE: mode },
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
          mf.dispatchFetch(`https://worker.test/${mode}/one`),
          mf.dispatchFetch(`https://worker.test/${mode}/two`),
        ]),
      );

      const results: Array<ReturnType<typeof decodeResult>> = [];

      for (const response of responses) {
        expect(response.status).toBe(200);
        const result = decodeResult(yield* Effect.promise(() => response.text()));

        results.push(result);
        expect(result).toMatchObject({
          result: ["left", "right"],
          sampled: true,
          unsafeCalls: 0,
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
          expect(attributes(id)).toMatchObject({
            "effect.trace_id": attributes(operation)["effect.trace_id"],
            "effect.parent.trace_id": attributes(operation)["effect.trace_id"],
            "effect.parent.span_id": attributes(operation)["effect.span_id"],
            "effect.span.kind": "internal",
          });
          expect(span(`${name}.native`).spanContext.spanId).toBe(id);
          expect(
            spans.filter(
              ({ event, spanContext }) => event.name === "fetch" && spanContext.spanId === id,
            ),
          ).toHaveLength(1);
        }

        for (const name of ["failure", "defect", "interrupted", "mixed"]) {
          expect(span(name).spanContext.spanId).toBe(operation);
          expect(attributes(span(name).event.spanId!)["effect.exit"]).toBe(
            name === "interrupted" ? "interrupted" : "failure",
          );
          expect(attributes(span(name).event.spanId!)["effect.error.kind"]).toBe(name);
          if (mode === "diagnostics") {
            expect(attributes(span(name).event.spanId!)["effect.error.type"]).toBe(
              name === "defect" || name === "mixed" ? "SanitizedDefect" : "SanitizedFailure",
            );
            expect(attributes(span(name).event.spanId!)["effect.error.message"]).toBe(
              name === "defect" || name === "mixed" ? undefined : "Operation failed safely",
            );
          } else {
            expect(attributes(span(name).event.spanId!)).not.toHaveProperty("effect.error.type");
            expect(attributes(span(name).event.spanId!)).not.toHaveProperty("effect.error.message");
          }
        }

        expect(span("root").spanContext.spanId).toBe(trace[0]!.event.spanId);
        expect(span("root.native").spanContext.spanId).toBe(span("root").event.spanId);
        expect(attributes(span("root").event.spanId!)).not.toHaveProperty("effect.parent.span_id");
        expect(span("external").spanContext.spanId).toBe(trace[0]!.event.spanId);
        expect(attributes(span("external").event.spanId!)).toMatchObject({
          "effect.trace_id": "a".repeat(32),
          "effect.parent.trace_id": "a".repeat(32),
          "effect.parent.span_id": "b".repeat(16),
          "effect.span.kind": "consumer",
        });
        expect(span("after.native").spanContext.spanId).toBe(operation);
        expect(span("unsampled.native").spanContext.spanId).toBe(operation);
        expect(spans.some(({ event }) => event.name === "unsampled")).toBe(false);
        expect(span("disabled.native").spanContext.spanId).toBe(operation);
        expect(spans.some(({ event }) => event.name === "disabled")).toBe(false);
        expect(attributes(operation)).toMatchObject({
          "scalar.number": 42,
          "scalar.boolean": true,
          "effect.exit": "success",
          structured: '{"nested":[1,true,null,"é"]}',
          null: "null",
          "json.bytes.boundary": `{"value":"${"é".repeat(2042)}"}`,
          "json.depth.boundary": "[[[[0]]]]",
          "json.values.boundary": JSON.stringify(Array.from({ length: 63 }, () => 0)),
        });
        expect(Object.keys(attributes(operation)).filter((key) => key.startsWith("drop."))).toEqual(
          [],
        );
        expect(attributes(operation)).not.toHaveProperty("effect.error.message");
        expect(results).toContainEqual(
          expect.objectContaining({
            traceId: attributes(operation)["effect.trace_id"],
            spanId: attributes(operation)["effect.span_id"],
          }),
        );
        expect(attributes(operation)["effect.trace_id"]).not.toBe(trace[0]!.spanContext.traceId);
        expect(attributes(operation)["effect.span_id"]).not.toBe(operation);
        expect(decodeLinks(attributes(span("linked").event.spanId!)["effect.span.links"])).toEqual([
          { traceId: "a".repeat(32), spanId: "b".repeat(16) },
          { traceId: "c".repeat(32), spanId: "d".repeat(16) },
        ]);
        expect(attributes(span("linked").event.spanId!)["effect.span.links_dropped"]).toBe(0);
        expect(
          decodeLinks(attributes(span("links-capped").event.spanId!)["effect.span.links"]),
        ).toEqual(
          Array.from({ length: 8 }, () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16) })),
        );
        expect(attributes(span("links-capped").event.spanId!)["effect.span.links_dropped"]).toBe(2);
        expect(attributes(span("links-oversized").event.spanId!)["effect.span.links_dropped"]).toBe(
          1,
        );
        expect(attributes(span("links-oversized").event.spanId!)).not.toHaveProperty(
          "effect.span.links",
        );
        expect(attributes(span("lifetime").event.spanId!)).toMatchObject({
          "effect.exit": "success",
        });
        expect(attributes(span("lifetime").event.spanId!)).not.toHaveProperty("after-end");
        expect(attributes(span("lifetime").event.spanId!)).not.toHaveProperty("effect.span.links");
        expect(JSON.stringify(trace)).not.toMatch(/private|secret|spoofed/);
        requestIds.push(attributes(operation)["request.id"]);

        const logs = trace.filter(({ event }) => event.type === "log");

        if (mode !== "events") expect(logs).toHaveLength(0);
        else {
          expect(logs).toHaveLength(22);
          for (const log of logs) {
            const [entry] = decodeEventLog(log.event.message);

            expect(entry!["effect.trace_id"]).toBe(
              attributes(log.spanContext.spanId!)["effect.trace_id"],
            );
            expect(entry!["effect.span_id"]).toBe(
              attributes(log.spanContext.spanId!)["effect.span_id"],
            );
            expect(new TextEncoder().encode(JSON.stringify(entry)).byteLength).toBeLessThanOrEqual(
              4096,
            );
          }
          for (const branch of branches) {
            const branchLogs = logs.filter((log) => log.spanContext.spanId === branch.event.spanId);

            expect(branchLogs).toHaveLength(1);
            expect(decodeEventLog(branchLogs[0]!.event.message)[0]).toMatchObject({
              "effect.event": "branch.ready",
              "effect.event.time_unix_nano": "1234567890",
              attributes: {
                branch: attributes(branch.event.spanId!).branch,
                nested: { ready: true },
              },
            });
          }
          const lifetimeLogs = logs.filter(
            (log) => log.spanContext.spanId === span("lifetime").event.spanId,
          );

          expect(lifetimeLogs).toHaveLength(1);
          expect(decodeEventLog(lifetimeLogs[0]!.event.message)[0]).toMatchObject({
            "effect.event": "outside-owner",
            "effect.event.time_unix_nano": "9876543210",
            attributes: { "effect.span_id": "cannot-spoof-envelope" },
          });
          const limited = logs.filter(
            (log) => log.spanContext.spanId === span("events-limited").event.spanId,
          );

          expect(limited.map((log) => decodeEventLog(log.event.message)[0]!.attributes.i)).toEqual(
            Array.from({ length: 16 }, (_, i) => i),
          );
          const valid = logs.filter(
            (log) => log.spanContext.spanId === span("events-invalid").event.spanId,
          );

          expect(valid).toHaveLength(1);
          expect(decodeEventLog(valid[0]!.event.message)[0]!["effect.event"]).toBe("valid");
          expect(
            logs
              .filter((log) => log.spanContext.spanId === span("events-console").event.spanId)
              .map((log) => decodeEventLog(log.event.message)[0]!["effect.event"]),
          ).toEqual(["reentrant", "after-host-failure"]);
        }

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

      expect(requestIds.toSorted()).toEqual([`/${mode}/one`, `/${mode}/two`]);
      const untraced = yield* Effect.promise(() => mf.getWorker("untraced"));
      const response = yield* Effect.promise(() =>
        untraced.fetch(`https://worker.test/${mode}/untraced`),
      );

      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        result: ["left", "right"],
        sampled: false,
        unsafeCalls: 0,
      });
    }).pipe(Effect.scoped),
  { timeout: 30_000 },
);
