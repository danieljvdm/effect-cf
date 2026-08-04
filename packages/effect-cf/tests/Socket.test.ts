import { Effect } from "effect";
import { expect, test } from "vite-plus/test";

import { Socket } from "../src/index";
import { makeNativeSocket } from "./socket-fixture";

test("wraps native sockets without locking their streams", async () => {
  const fixture = makeNativeSocket();
  const socket = Socket.fromSocket(fixture.raw);

  expect(socket.unsafeRaw).toBe(fixture.raw);
  expect(socket.readable).toBe(fixture.raw.readable);
  expect(socket.writable).toBe(fixture.raw.writable);
  expect(socket.readable.locked).toBe(false);
  expect(socket.writable.locked).toBe(false);
  expect(Socket.fromSocket(fixture.raw)).toBe(socket);
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

  expect(socket.unsafeRaw).toBe(fixture.raw);
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

test("returns the replacement socket from STARTTLS", async () => {
  const upgraded = makeNativeSocket({ upgraded: true, secureTransport: "on" });
  const original = makeNativeSocket({ startTls: () => upgraded.raw });
  const socket = Socket.fromSocket(original.raw);
  const options = { expectedServerHostname: "database.internal" };

  const replacement = await Effect.runPromise(socket.startTls(options));

  expect(replacement.unsafeRaw).toBe(upgraded.raw);
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
