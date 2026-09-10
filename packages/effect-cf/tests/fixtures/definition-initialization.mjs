import assert from "node:assert/strict";
import { register } from "node:module";
import * as Schema from "effect/Schema";

// Native ESM must see a fresh module graph: test-runner transforms and previously
// loaded modules can hide the published package's initialization-order failure.
register(new URL("./definition-host-loader.mjs", import.meta.url));

const packageDirectory = process.argv[2];
const family = process.argv[3];
const definition = await import(new URL(`${family}Definition.mjs`, packageDirectory));
const runtime = await import(new URL(`${family}.mjs`, packageDirectory));

assert.equal(runtime.Tag, definition.Tag);
assert.equal(runtime.implement, definition.implement);

const fields =
  family === "Queue"
    ? { message: Schema.String }
    : { payload: Schema.String, result: Schema.String };
const tag = runtime.Tag()(`Packaging${family}`, fields);

assert.equal(tag.id, `Packaging${family}`);
for (const [name, schema] of Object.entries(fields)) {
  assert.equal(tag[name], schema);
}
process.stdout.write("ok\n");
