import { Effect } from "effect";
import { expect, test } from "vite-plus/test";

import { DurableObjectContainer, DurableObjectState } from "../src/index";
import { makeNativeSocket } from "./socket-fixture";

test("wraps the stable Durable Object Container lifecycle and process APIs", async () => {
  const calls: Array<readonly [string, ...Array<unknown>]> = [];
  const process = {
    stdin: new WritableStream(),
    stdout: new ReadableStream(),
    stderr: null,
    pid: 42,
    exitCode: Promise.resolve(0),
    output: () =>
      Promise.resolve({
        stdout: new TextEncoder().encode("ok").buffer,
        stderr: new ArrayBuffer(0),
        exitCode: 0,
      }),
    kill: (signal?: number) => calls.push(["kill", signal]),
  } as globalThis.ExecProcess;
  const port = {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(["fetch", input, init]);
      return Promise.resolve(new Response("container"));
    },
    connect: () => makeNativeSocket().raw,
  } as globalThis.Fetcher;
  const container = {
    running: true,
    start: (options?: globalThis.ContainerStartupOptions) => calls.push(["start", options]),
    monitor: () => Promise.resolve(),
    destroy: (error?: unknown) => {
      calls.push(["destroy", error]);
      return Promise.resolve();
    },
    signal: (signal: number) => calls.push(["signal", signal]),
    getTcpPort: (portNumber: number) => {
      calls.push(["getTcpPort", portNumber]);
      return port;
    },
    setInactivityTimeout: (duration: number | bigint) => {
      calls.push(["setInactivityTimeout", duration]);
      return Promise.resolve();
    },
    interceptOutboundHttp: () => Promise.resolve(),
    interceptAllOutboundHttp: () => Promise.resolve(),
    interceptOutboundHttps: () => Promise.resolve(),
    snapshotDirectory: (options: globalThis.ContainerDirectorySnapshotOptions) =>
      Promise.resolve({ id: "directory", size: 10, dir: options.dir, name: options.name }),
    snapshotContainer: (options: globalThis.ContainerSnapshotOptions) =>
      Promise.resolve({ id: "container", size: 20, name: options.name }),
    exec: (command: Array<string>, options?: globalThis.ContainerExecOptions) => {
      calls.push(["exec", command, options]);
      return Promise.resolve(process);
    },
  } as globalThis.Container;
  const service = DurableObjectContainer.fromContainer(container);

  expect(await Effect.runPromise(service.running)).toBe(true);
  await Effect.runPromise(service.start({ enableInternet: false }));
  await Effect.runPromise(service.signal(15));
  await Effect.runPromise(service.setInactivityTimeout(30_000));
  const tcpPort = await Effect.runPromise(service.getTcpPort(8080));
  const response = await Effect.runPromise(tcpPort.fetch("https://container.internal/"));
  const child = await Effect.runPromise(service.exec(["echo", "ok"], { stdout: "pipe" }));
  const output = await Effect.runPromise(child.output);
  await Effect.runPromise(child.kill(9));

  expect(service.unsafeRaw).toBe(container);
  expect(tcpPort.unsafeRaw).toBe(port);
  expect(await response.text()).toBe("container");
  expect(child.unsafeRaw).toBe(process);
  expect(child.pid).toBe(42);
  expect(await Effect.runPromise(child.exitCode)).toBe(0);
  expect(new TextDecoder().decode(output.stdout)).toBe("ok");
  expect(calls.map(([operation]) => operation)).toEqual([
    "start",
    "signal",
    "setInactivityTimeout",
    "getTcpPort",
    "fetch",
    "exec",
    "kill",
  ]);
});

test("Container TCP ports expose Effect sockets", async () => {
  const fixture = makeNativeSocket();
  const calls: Array<readonly [unknown, unknown]> = [];
  const port = {
    fetch: () => Promise.resolve(new Response()),
    connect: (address: unknown, options: unknown) => {
      calls.push([address, options]);
      return fixture.raw;
    },
  } as globalThis.Fetcher;
  const container = {
    getTcpPort: () => port,
  } as unknown as globalThis.Container;
  const service = DurableObjectContainer.fromContainer(container);
  const tcpPort = await Effect.runPromise(service.getTcpPort(50051));
  const options = { allowHalfOpen: false };

  const socket = await Effect.runPromise(tcpPort.connect("grpc.internal:50051", options));

  expect(socket.unsafeRaw).toBe(fixture.raw);
  expect(calls).toEqual([["grpc.internal:50051", options]]);
});

test("maps Container failures with operation context", async () => {
  const cause = new Error("container unavailable");
  const container = {
    monitor: () => Promise.reject(cause),
  } as unknown as globalThis.Container;
  const service = DurableObjectContainer.fromContainer(container);

  await expect(Effect.runPromise(service.monitor)).rejects.toMatchObject({
    _tag: "ContainerOperationError",
    operation: "monitor",
    cause,
  });
});

test("DurableObjectState exposes configured containers and a typed missing error", async () => {
  const container = { running: true } as globalThis.Container;
  const makeState = (configured: boolean) =>
    ({
      id: { toString: () => "container-object" },
      storage: {},
      container: configured ? container : undefined,
    }) as unknown as globalThis.DurableObjectState;

  const configured = DurableObjectState.fromDurableObjectState(makeState(true));
  const missing = DurableObjectState.fromDurableObjectState(makeState(false));

  expect((await Effect.runPromise(configured.container)).unsafeRaw).toBe(container);
  await expect(Effect.runPromise(missing.container)).rejects.toMatchObject({
    _tag: "ContainerNotConfiguredError",
  });
});
