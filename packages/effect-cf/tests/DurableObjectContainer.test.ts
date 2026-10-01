import { assert, it } from "@effect/vitest";
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";

import { DurableObjectContainer } from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";

it.effect("inactivity timeouts accept milliseconds and Effect duration inputs", () =>
  Effect.gen(function* () {
    const timeouts: Array<number | bigint> = [];
    const container = DurableObjectContainer.fromContainer(
      makePartialTestDouble<Container>({
        setInactivityTimeout: async (duration) => {
          timeouts.push(duration);
        },
      }),
    );
    const milliseconds = container.setInactivityTimeout(60_000);

    assert.deepStrictEqual(timeouts, []);
    yield* milliseconds;
    yield* container.setInactivityTimeout("1 minute");
    yield* container.setInactivityTimeout(Duration.minutes(1));
    yield* container.setInactivityTimeout(60_000_000_000n);

    assert.deepStrictEqual(timeouts, [60_000, 60_000, 60_000, 60_000]);
  }),
);

it.effect("readiness deadlines retain the failed probe without retrying application work", () =>
  Effect.gen(function* () {
    const refused = new Error("Connection refused");
    const container = DurableObjectContainer.fromContainer(
      makePartialTestDouble<Container>({
        running: true,
        getTcpPort: () =>
          makePartialTestDouble<Fetcher>({
            fetch: async () => {
              throw refused;
            },
          }),
      }),
    );
    const fiber = yield* Effect.forkChild(
      container.waitForHttp(8080, {
        timeout: Duration.seconds(1),
        interval: 100,
        attemptTimeout: "500 millis",
      }),
    );

    yield* TestClock.adjust("1 second");

    const error = yield* Effect.flip(Fiber.join(fiber));

    assert.instanceOf(error, DurableObjectContainer.ContainerReadinessTimeoutError);
    assert.instanceOf(error.cause, DurableObjectContainer.ContainerError);
    assert.strictEqual(error.cause.cause, refused);
  }),
);

it.effect("interrupting readiness aborts its pending HTTP probe", () =>
  Effect.gen(function* () {
    const acquired = yield* Deferred.make<AbortSignal>();
    const container = DurableObjectContainer.fromContainer(
      makePartialTestDouble<Container>({
        running: true,
        getTcpPort: () =>
          makePartialTestDouble<Fetcher>({
            fetch: (_input, init) =>
              new Promise((_resolve, reject) => {
                const signal = init!.signal!;

                Deferred.doneUnsafe(acquired, Effect.succeed(signal));
                signal.addEventListener(
                  "abort",
                  () => reject(new DOMException("Aborted", "AbortError")),
                  { once: true },
                );
              }),
          }),
      }),
    );
    const fiber = yield* Effect.forkChild(container.waitForHttp(8080));

    const signal = yield* Deferred.await(acquired);

    yield* Fiber.interrupt(fiber);

    assert.isTrue(signal.aborted);
  }),
);

it.effect("container validation and asynchronous lifecycle failures remain typed and lazy", () =>
  Effect.gen(function* () {
    const invalidOptions = new RangeError("Invalid instance resources");
    const startupFailure = new Error("Image could not be started");
    let starts = 0;
    const container = DurableObjectContainer.fromContainer(
      makePartialTestDouble<Container>({
        start: () => {
          starts += 1;
          throw invalidOptions;
        },
        monitor: () => Promise.reject(startupFailure),
      }),
    );
    const start = container.start();

    assert.strictEqual(starts, 0);

    const startError = yield* Effect.flip(start);
    const monitorError = yield* Effect.flip(container.monitor);

    assert.instanceOf(startError, DurableObjectContainer.ContainerError);
    assert.strictEqual(startError.operation, "start");
    assert.strictEqual(startError.cause, invalidOptions);
    assert.strictEqual(monitorError.operation, "monitor");
    assert.strictEqual(monitorError.cause, startupFailure);
  }),
);

it.effect("scoped execution signals a running process when its owner is interrupted", () =>
  Effect.gen(function* () {
    const acquired = yield* Deferred.make<void>();
    const completion = Promise.withResolvers<number>();
    const signals: number[] = [];
    const process = makePartialTestDouble<ExecProcess>({
      exitCode: completion.promise,
      kill: (signal = 15) => {
        signals.push(signal);
        completion.resolve(137);
      },
    });
    const container = DurableObjectContainer.fromContainer(
      makePartialTestDouble<Container>({ exec: async () => process }),
    );
    const fiber = yield* Effect.forkChild(
      Effect.gen(function* () {
        yield* container.execScoped(["sleep", "60"]);
        yield* Deferred.succeed(acquired, undefined);

        return yield* Effect.never;
      }).pipe(Effect.scoped),
    );

    yield* Deferred.await(acquired);
    yield* Fiber.interrupt(fiber);

    assert.deepStrictEqual(signals, [9]);
  }),
);

it("interrupts pending process acquisition through the native abort signal", async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const container = DurableObjectContainer.fromContainer(
    makePartialTestDouble<Container>({
      exec: (_command, options) =>
        new Promise((_resolve, reject) => {
          const signal = options!.signal!;

          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            {
              once: true,
            },
          );
          entered.resolve(signal);
        }),
    }),
  );
  const fiber = Effect.runFork(container.execScoped(["sleep", "60"]).pipe(Effect.scoped));
  const signal = await entered.promise;

  await Effect.runPromise(Fiber.interrupt(fiber));

  assert.isTrue(signal.aborted);
});

it.effect("completed processes preserve nonzero exit codes and are never signaled by cleanup", () =>
  Effect.gen(function* () {
    const output = {
      stdout: new ArrayBuffer(0),
      stderr: new Uint8Array(new TextEncoder().encode("command failed")).buffer,
      exitCode: 7,
    };
    const process = makePartialTestDouble<ExecProcess>({
      exitCode: Promise.resolve(7),
      output: async () => output,
      kill: () => {
        throw new Error("The native runtime cannot signal an exited process");
      },
    });
    const container = DurableObjectContainer.fromContainer(
      makePartialTestDouble<Container>({ exec: async () => process }),
    );
    const result = yield* Effect.gen(function* () {
      const child = yield* container.execScoped(["sh", "-c", "exit 7"]);

      assert.strictEqual(yield* child.exitCode, 7);
      yield* child.kill();

      return yield* child.output;
    }).pipe(Effect.scoped);

    assert.strictEqual(result.exitCode, 7);
    assert.strictEqual(new TextDecoder().decode(result.stderr), "command failed");
  }),
);

it.effect("process streams handle the runtime's absent stderr for combined output", () =>
  Effect.gen(function* () {
    const process = makePartialTestDouble<ExecProcess>({
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("combined output"));
          controller.close();
        },
      }),
      // workerd returns undefined for absent streams despite its nullable declarations.
      exitCode: Promise.resolve(0),
    });
    const container = DurableObjectContainer.fromContainer(
      makePartialTestDouble<Container>({ exec: async () => process }),
    );
    const child = yield* container.exec(["example"], { stderr: "combined" });
    const stdout = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
    const stderr = yield* Stream.runCollect(child.stderr);

    assert.strictEqual(stdout, "combined output");
    assert.deepStrictEqual(stderr, []);
    assert.isNull(child.stdin);
  }),
);

it.effect("immediate scope closure does not signal a process whose exit is already queued", () =>
  Effect.gen(function* () {
    const process = makePartialTestDouble<ExecProcess>({
      exitCode: Promise.resolve(0),
      kill: () => {
        throw new Error("The native runtime cannot signal an exited process");
      },
    });
    const container = DurableObjectContainer.fromContainer(
      makePartialTestDouble<Container>({ exec: async () => process }),
    );
    const child = yield* container.execScoped(["true"]).pipe(Effect.scoped);

    assert.strictEqual(yield* child.exitCode, 0);
  }),
);

// Native socket ownership follow-up to https://github.com/danieljvdm/effect-cf/pull/197.
it.effect.each(["success", "interruption"] as const)(
  "scoped TCP connections close after %s without replay",
  (termination) =>
    Effect.gen(function* () {
      const acquired = yield* Deferred.make<void>();
      let connections = 0;
      let closes = 0;
      const socket = makePartialTestDouble<Socket>({
        close: async () => {
          closes += 1;
        },
      });
      const container = DurableObjectContainer.fromContainer(
        makePartialTestDouble<Container>({
          getTcpPort: () =>
            makePartialTestDouble<Fetcher>({
              connect: () => {
                connections += 1;

                return socket;
              },
            }),
        }),
      );
      const port = yield* container.getTcpPort(8080);
      const connection = port.connectScoped("localhost:8080");

      assert.strictEqual(connections, 0);
      const fiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          assert.strictEqual(yield* connection, socket);
          yield* Deferred.succeed(acquired, undefined);

          if (termination === "interruption") return yield* Effect.never;
        }).pipe(Effect.scoped),
      );

      yield* Deferred.await(acquired);
      if (termination === "interruption") yield* Fiber.interrupt(fiber);
      else yield* Fiber.join(fiber);
      assert.strictEqual(connections, 1);
      assert.strictEqual(closes, 1);
    }),
);

it.effect("scoped TCP connections retain asynchronous close failures", () =>
  Effect.gen(function* () {
    const rejectedClose = new Error("Socket close failed");
    const container = DurableObjectContainer.fromContainer(
      makePartialTestDouble<Container>({
        getTcpPort: () =>
          makePartialTestDouble<Fetcher>({
            connect: () =>
              makePartialTestDouble<Socket>({
                close: () => Promise.reject(rejectedClose),
              }),
          }),
      }),
    );
    const port = yield* container.getTcpPort(8080);
    const result = yield* port.connectScoped("localhost:8080").pipe(Effect.scoped, Effect.exit);

    assert.isTrue(Exit.isFailure(result));
    if (Exit.isFailure(result)) {
      const error = Cause.squash(result.cause);

      assert.instanceOf(error, DurableObjectContainer.ContainerError);
      assert.strictEqual(error.operation, "getTcpPort.close");
      assert.strictEqual(error.cause, rejectedClose);
    }
  }),
);
