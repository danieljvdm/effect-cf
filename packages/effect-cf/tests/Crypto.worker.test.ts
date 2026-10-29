import { createExecutionContext } from "cloudflare:test";
import { Layer } from "effect";
import { SecureRandom } from "effect/crypto";
import { expect, test } from "vite-plus/test";

import { Worker } from "../src/index";

const rpc = {
  uuid: () => SecureRandom.SecureRandom.use((random) => random.uuidV4()),
};

test("supplies native Effect SecureRandom to Worker handlers", async () => {
  const TestWorker = Worker.make(Layer.empty, { rpc });
  const worker = new TestWorker(createExecutionContext(), {});
  const id = await worker.uuid();

  expect(await worker.uuid()).not.toBe(id);
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("honors an application-provided Effect SecureRandom service", async () => {
  const random = SecureRandom.make((size) => new Uint8Array(size));
  const TestWorker = Worker.make(Layer.succeed(SecureRandom.SecureRandom, random), { rpc });
  const worker = new TestWorker(createExecutionContext(), {});

  expect(await worker.uuid()).toBe("00000000-0000-4000-8000-000000000000");
});
