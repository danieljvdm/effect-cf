import { Effect, Fiber, Stream } from "effect";
import { expect, test } from "vite-plus/test";

import { Socket } from "../src/index";
import { makeNativeSocket } from "./socket-fixture";

test("wraps native sockets with Effect-managed streams without locking eagerly", async () => {
  const written: Array<Uint8Array> = [];
  const fixture = makeNativeSocket({
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        written.push(chunk);
      },
    }),
  });
  const socket = Socket.fromSocket(fixture.raw);

  expect(await Effect.runPromise(socket.unsafeRaw)).toBe(fixture.raw);
  expect(fixture.raw.readable.locked).toBe(false);
  expect(fixture.raw.writable.locked).toBe(false);
  const received = await Effect.runPromise(Stream.runCollect(socket.readable));
  await Effect.runPromise(Stream.run(Stream.make(new Uint8Array([3, 4])), socket.writable));

  expect(Array.from(received, (chunk) => Array.from(chunk))).toEqual([[1, 2]]);
  expect(written.map((chunk) => Array.from(chunk))).toEqual([[3, 4]]);
  await expect(Effect.runPromise(socket.opened)).resolves.toEqual({
    remoteAddress: "127.0.0.1:443",
  });
});

test("forwards connect options and maps synchronous failures", async () => {
  const fixture = makeNativeSocket();
  const calls: Array<readonly [Socket.SocketAddress, Socket.SocketOptions | undefined]> = [];
  const connector: Socket.SocketConnector = {
    connect: (address, options) => {
      calls.push([address, options]);
      return fixture.raw;
    },
  };
  const options = { allowHalfOpen: true, secureTransport: "starttls" };

  const socket = await Effect.runPromise(Socket.connect(connector, "database:5432", options));

  expect(await Effect.runPromise(socket.unsafeRaw)).toBe(fixture.raw);
  expect(calls).toEqual([["database:5432", options]]);

  const cause = new Error("connection refused");
  await expect(
    Effect.runPromise(
      Socket.connect(
        {
          connect: () => {
            throw cause;
          },
        },
        "database:5432",
        { allowHalfOpen: false },
      ),
    ),
  ).rejects.toMatchObject({
    _tag: "SocketOperationError",
    operation: "connect",
    cause,
  });
});

test("maps socket promise failures to their operation", async () => {
  const openCause = new Error("open failed");
  const closedCause = new Error("closed badly");
  const closeCause = new Error("close failed");
  const fixture = makeNativeSocket({
    opened: Promise.reject(openCause),
    closed: Promise.reject(closedCause),
    close: () => Promise.reject(closeCause),
  });
  const socket = Socket.fromSocket(fixture.raw);

  await expect(Effect.runPromise(socket.opened)).rejects.toMatchObject({
    operation: "open",
    cause: openCause,
  });
  await expect(Effect.runPromise(socket.closed)).rejects.toMatchObject({
    operation: "closed",
    cause: closedCause,
  });
  await expect(Effect.runPromise(socket.close)).rejects.toMatchObject({
    operation: "close",
    cause: closeCause,
  });
});

test("maps native stream failures to read and write operations", async () => {
  const readCause = new Error("read failed");
  const writeCause = new Error("write failed");
  const fixture = makeNativeSocket({
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(readCause);
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write() {
        throw writeCause;
      },
    }),
  });
  const socket = Socket.fromSocket(fixture.raw);

  await expect(Effect.runPromise(Stream.runDrain(socket.readable))).rejects.toMatchObject({
    operation: "read",
    cause: readCause,
  });
  await expect(
    Effect.runPromise(Stream.run(Stream.make(new Uint8Array([1])), socket.writable)),
  ).rejects.toMatchObject({
    operation: "write",
    cause: writeCause,
  });
});

test("returns the replacement socket from STARTTLS", async () => {
  const upgraded = makeNativeSocket({ upgraded: true, secureTransport: "on" });
  const original = makeNativeSocket({ startTls: () => upgraded.raw });
  const socket = Socket.fromSocket(original.raw);
  const options = { expectedServerHostname: "database.internal" };

  const replacement = await Effect.runPromise(socket.startTls(options));

  expect(await Effect.runPromise(replacement.unsafeRaw)).toBe(upgraded.raw);
  expect(replacement.upgraded).toBe(true);
  expect(replacement.secureTransport).toBe("on");
  expect(original.state.startTlsOptions).toEqual(options);
});

test("connectScoped waits for open and closes the socket with its scope", async () => {
  let opened = false;
  const fixture = makeNativeSocket({
    opened: Promise.resolve({ remoteAddress: "127.0.0.1:443" }).then((info) => {
      opened = true;
      return info;
    }),
  });

  const observedOpen = await Effect.runPromise(
    Effect.scoped(
      Effect.map(
        Socket.connectScoped(
          { connect: () => fixture.raw },
          { hostname: "database.internal", port: 443 },
          { allowHalfOpen: false },
        ),
        () => opened,
      ),
    ),
  );

  expect(observedOpen).toBe(true);
  expect(fixture.state.closeCalls).toBe(1);
});

test("connectAndOpen closes a socket whose open promise fails", async () => {
  const cause = new Error("open failed");
  const fixture = makeNativeSocket({ opened: Promise.reject(cause) });

  await expect(
    Effect.runPromise(
      Socket.connectAndOpen({ connect: () => fixture.raw }, "database.internal:5432", {
        allowHalfOpen: false,
      }),
    ),
  ).rejects.toMatchObject({ operation: "open", cause });

  expect(fixture.state.closeCalls).toBe(1);
});

test("connectScoped closes an acquired socket when opening is interrupted", async () => {
  const connected = Promise.withResolvers<void>();
  const fixture = makeNativeSocket({ opened: new Promise(() => undefined) });
  const fiber = Effect.runFork(
    Effect.scoped(
      Socket.connectScoped(
        {
          connect: () => {
            connected.resolve();
            return fixture.raw;
          },
        },
        "database.internal:5432",
        { allowHalfOpen: false },
      ),
    ),
  );

  await connected.promise;
  await Effect.runPromise(Fiber.interrupt(fiber));

  expect(fixture.state.closeCalls).toBe(1);
});
