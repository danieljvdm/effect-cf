/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:test";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";

import * as ComputerWorkspace from "../src/ComputerWorkspace";
import * as PoolWorkers from "../src/Vitest";

it.effect("preserves invalid-path errors when the path contains missing-entry error text", () => {
  const stub = env.TEST_COMPUTER_DO!.getByName(crypto.randomUUID());

  return PoolWorkers.runInDurableObject(stub, () =>
    Effect.gen(function* () {
      const workspace = yield* ComputerWorkspace.ComputerWorkspace;

      for (const path of ["/../ENOENT", "/../no such"]) {
        const errors = [
          yield* workspace.statOrNull(path).pipe(Effect.flip),
          yield* workspace.lstatOrNull(path).pipe(Effect.flip),
          yield* workspace.exists(path).pipe(Effect.flip),
        ];

        for (const error of errors) {
          assert.instanceOf(error, ComputerWorkspace.WorkspaceFsError);
          assert.strictEqual(error.code, "EINVAL");
          assert.strictEqual(error.path, path);
        }
      }
    }).pipe(Effect.provide(ComputerWorkspace.ComputerWorkspace.layer)),
  );
});

test("SQLite-backed workspaces persist filesystem and local Git operations", async () => {
  const namespace = env.TEST_COMPUTER_DO;

  if (namespace === undefined) {
    throw new Error("TEST_COMPUTER_DO is not configured");
  }

  const stub = namespace.get(namespace.idFromName(crypto.randomUUID()));
  const result = await stub.exercise();

  expect(result.text).toBe("Ship it");
  expect(result.bytes).toEqual([1, 2, 3]);
  expect(result.directoryNames).toEqual(expect.arrayContaining(["blob.bin", "notes", "todo-link"]));
  expect(result.foundPaths).toEqual(expect.arrayContaining(["/notes/todo.md", "/blob.bin"]));
  expect(result.grepLines).toEqual([2]);
  expect(result.linkTarget).toBe("/notes/todo.md");
  expect(result.missingFile).toBe(true);
  expect(result.missingLink).toBe(true);
  expect(result.backendCount).toBe(0);
  expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(result.branch).toBe("main");
  expect(result.branches).toContain("feature");
  expect(result.tags).toContain("v1");
  // Git preserves the canonical trailing newline on commit messages.
  expect(result.logMessage).toBe("initial commit\n");
  expect(result.shownMessage).toBe("initial commit\n");
  expect(result.files).toContain("README.md");
  expect(result.treePaths).toContain("README.md");
  expect(result.statusPaths).toContain("README.md");
  expect(result.diffContainsUpdate).toBe(true);
  expect(result.configValue).toBe("works");
});
