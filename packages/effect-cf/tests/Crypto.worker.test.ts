import { createExecutionContext } from "cloudflare:test";
import { Crypto, Effect, Layer } from "effect";
import { expect, test } from "vite-plus/test";

import { Worker } from "../src/index";

const rpc = {
  uuid: () => Crypto.Crypto.use((crypto) => crypto.randomUUIDv4()),
};

test("supplies native Effect Crypto to Worker handlers", async () => {
  const TestWorker = Worker.make(Layer.empty, { rpc });
  const worker = new TestWorker(createExecutionContext(), {});
  const id = await worker.uuid();

  expect(await worker.uuid()).not.toBe(id);
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("honors an application-provided Effect Crypto service", async () => {
  const crypto = Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  });
  const TestWorker = Worker.make(Layer.succeed(Crypto.Crypto, crypto), { rpc });
  const worker = new TestWorker(createExecutionContext(), {});

  expect(await worker.uuid()).toBe("00000000-0000-4000-8000-000000000000");
});
