/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:test";
import { expect, test } from "vite-plus/test";

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
