import { env } from "cloudflare:workers";
import { assert, it } from "@effect/vitest";

// Load the configured user module during collection, before the RPC barriers.
import "cloudflare:test";

// https://github.com/danieljvdm/effect-cf/commit/c7daaff779934c83519ad9689e1f98dc100b5251
// An asynchronous layer build let the first RPC enter before initialize could
// establish its requested native gate. Its already-admitted fiber then resumed
// from that layer even while initialization held the gate.
it.each([true, false])(
  "preserves initialization ordering after an asynchronous layer (gated=%s)",
  async (gated) => {
    const target = env.TEST_INITIALIZATION_DO!.getByName(
      `${gated ? "gated" : "background"}:${crypto.randomUUID()}`,
    );
    const control = env.TEST_INITIALIZATION_CONTROL!.getByName(target.id.toString());
    const response = target.status();

    try {
      await control.entered("layer");
      await control.release("layer");
      await control.entered("initialize");

      if (gated) {
        await control.release("initialize");
        assert.deepStrictEqual(await response, { initialized: true, executionMode: "async" });
      } else {
        assert.deepStrictEqual(await response, { initialized: false, executionMode: "async" });
      }
    } finally {
      await control.release("layer");
      await control.release("initialize");
    }
  },
);
