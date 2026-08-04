import { Effect, Schema as S } from "effect";
import { expect, test } from "vite-plus/test";

import { DurableObjectDefinition, DurableObjectNamespace, ServiceBinding } from "../src/index";
import { makeNativeSocket } from "./socket-fixture";

test("service binding connect forwards the address and options", async () => {
  const fixture = makeNativeSocket();
  const calls: Array<readonly [unknown, unknown]> = [];
  const service = {
    fetch: () => Promise.resolve(new Response()),
    connect: (address: unknown, options: unknown) => {
      calls.push([address, options]);
      return fixture.raw;
    },
  } as ServiceBinding.ServiceBindingClient<{}>;
  const client = ServiceBinding.makeClient<{}>({ binding: "DATABASE" })(service);
  const options = { allowHalfOpen: false, secureTransport: "on" };

  const socket = await Effect.runPromise(client.connect("database:5432", options));

  expect(socket.unsafeRaw).toBe(fixture.raw);
  expect(calls).toEqual([["database:5432", options]]);
});

test("service binding connect errors include binding and socket operation context", async () => {
  const cause = new Error("binding connect failed");
  const service = {
    fetch: () => Promise.resolve(new Response()),
    connect: () => {
      throw cause;
    },
  } as ServiceBinding.ServiceBindingClient<{}>;
  const client = ServiceBinding.makeClient<{}>({ binding: "DATABASE" })(service);

  await expect(
    Effect.runPromise(client.connect("database:5432", { allowHalfOpen: false })),
  ).rejects.toMatchObject({
    _tag: "ServiceBindingConnectError",
    binding: "DATABASE",
    cause: {
      _tag: "SocketOperationError",
      operation: "connect",
      cause,
    },
  });
});

test("Durable Object namespace and by-name clients forward connect", async () => {
  const fixture = makeNativeSocket();
  const calls: Array<readonly [unknown, unknown]> = [];
  const id = { toString: () => "durable-object-id" } as globalThis.DurableObjectId;
  const stub = {
    id,
    name: "primary",
    fetch: () => Promise.resolve(new Response()),
    connect: (address: unknown, options: unknown) => {
      calls.push([address, options]);
      return fixture.raw;
    },
  } as DurableObjectNamespace.DurableObjectStubClient<{}>;
  const namespace = {
    newUniqueId: () => id,
    idFromName: () => id,
    idFromString: () => id,
    get: () => stub,
    getByName: () => stub,
    jurisdiction: () => namespace,
  } as DurableObjectNamespace.DurableObjectNamespaceClient<{}>;
  const definition = DurableObjectDefinition.make("SocketObject", {
    ping: DurableObjectDefinition.method({ success: S.String }),
  });
  const client = DurableObjectNamespace.makeClient({
    binding: "SOCKET_OBJECTS",
    definition,
  })(namespace);
  const options = { allowHalfOpen: true };

  const directSocket = await Effect.runPromise(
    client.connect(stub, "origin.internal:443", options),
  );
  const namedSocket = await Effect.runPromise(
    client.byName("primary").connect({ hostname: "origin.internal", port: 443 }, options),
  );

  expect(directSocket.unsafeRaw).toBe(fixture.raw);
  expect(namedSocket.unsafeRaw).toBe(fixture.raw);
  expect(calls).toEqual([
    ["origin.internal:443", options],
    [{ hostname: "origin.internal", port: 443 }, options],
  ]);
});

test("Durable Object connect errors retain binding and object identity", async () => {
  const cause = new Error("object connect failed");
  const id = { toString: () => "durable-object-id" } as globalThis.DurableObjectId;
  const stub = {
    id,
    name: "primary",
    fetch: () => Promise.resolve(new Response()),
    connect: () => {
      throw cause;
    },
  } as DurableObjectNamespace.DurableObjectStubClient<{}>;
  const namespace = {
    newUniqueId: () => id,
    idFromName: () => id,
    idFromString: () => id,
    get: () => stub,
    getByName: () => stub,
    jurisdiction: () => namespace,
  } as DurableObjectNamespace.DurableObjectNamespaceClient<{}>;
  const client = DurableObjectNamespace.makeClient<{}>({ binding: "SOCKET_OBJECTS" })(namespace);

  await expect(
    Effect.runPromise(client.connect(stub, "origin.internal:443", { allowHalfOpen: false })),
  ).rejects.toMatchObject({
    _tag: "DurableObjectConnectError",
    binding: "SOCKET_OBJECTS",
    id: "durable-object-id",
    name: "primary",
    cause: {
      _tag: "SocketOperationError",
      operation: "connect",
      cause,
    },
  });
});
