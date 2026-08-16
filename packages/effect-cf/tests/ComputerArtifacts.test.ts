import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import * as ComputerArtifacts from "../src/ComputerArtifacts";
import { Artifacts } from "../src/index";

const repoInfo = (name: string): Artifacts.ArtifactsRepoInfo => ({
  id: `${name}-id`,
  name,
  description: null,
  defaultBranch: "main",
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
  lastPushAt: null,
  source: null,
  readOnly: false,
  remote: `https://git.cloudflare.com/default/${name}`,
});

const createResult = (name: string): Artifacts.ArtifactsCreateRepoResult => ({
  id: `${name}-id`,
  name,
  description: null,
  defaultBranch: "main",
  remote: `https://git.cloudflare.com/default/${name}`,
  token: `${name}-token`,
  tokenExpiresAt: "2026-08-16T00:00:00.000Z",
});

it.effect("delegates session naming and filtering to the upstream Artifacts facade", () =>
  Effect.gen(function* () {
    const calls = {
      create: [] as Array<string>,
      get: [] as Array<string>,
      import: [] as Array<string>,
      list: [] as Array<string | undefined>,
      delete: [] as Array<string>,
    };
    const token = {
      id: "token-1",
      scope: "read" as const,
      state: "active" as const,
      createdAt: "2026-08-15T00:00:00.000Z",
      expiresAt: "2026-08-16T00:00:00.000Z",
    };
    const repo = (name: string) => ({
      ...repoInfo(name),
      info: () => Promise.resolve(repoInfo(name)),
      createToken: () =>
        Promise.resolve({
          id: token.id,
          plaintext: "plaintext-token",
          scope: token.scope,
          expiresAt: token.expiresAt,
        }),
      listTokens: () => Promise.resolve({ tokens: [token], total: 1 }),
      revokeToken: () => Promise.resolve(true),
      fork: (target: string) => Promise.resolve(createResult(target)),
    });
    const binding = {
      create: (name: string) => {
        calls.create.push(name);

        return Promise.resolve(createResult(name));
      },
      get: (name: string) => {
        calls.get.push(name);

        return Promise.resolve(repo(name));
      },
      import: (params: Artifacts.ArtifactsImportParams) => {
        calls.import.push(params.target.name);

        return Promise.resolve(createResult(params.target.name));
      },
      list: (options?: Artifacts.ArtifactsListOptions) => {
        calls.list.push(options?.cursor);

        return Promise.resolve(
          options?.cursor === undefined
            ? {
                repos: [
                  { ...repoInfo("session-1__build-cache"), status: "ready" as const },
                  { ...repoInfo("another-session__hidden"), status: "ready" as const },
                ],
                total: 3,
                cursor: "next",
              }
            : {
                repos: [{ ...repoInfo("session-1__reports"), status: "ready" as const }],
                total: 3,
              },
        );
      },
      delete: (name: string) => {
        calls.delete.push(name);

        return Promise.resolve(true);
      },
    } as unknown as Artifacts.ArtifactsBinding;

    const artifacts = yield* ComputerArtifacts.makeClient(binding, "session-1");
    const created = yield* artifacts.create("build-cache");
    const resolved = yield* artifacts.get("build-cache");
    const listed = yield* artifacts.list;
    const imported = yield* artifacts.import("source", {
      url: "https://github.com/cloudflare/workers-sdk",
      branch: "main",
      depth: 1,
    });
    const createdToken = yield* artifacts.createToken("build-cache", "read", 3_600);
    const tokens = yield* artifacts.listTokens("build-cache");
    const foundToken = yield* artifacts.getToken("build-cache", "token-1");
    const revoked = yield* artifacts.revokeToken("build-cache", "token-1");
    const deleted = yield* artifacts.delete("reports");
    const cli = yield* artifacts.cli({ argv: ["help"] });

    assert.strictEqual(artifacts.sessionId, "session-1");
    assert.strictEqual(created.name, "build-cache");
    assert.strictEqual(resolved.name, "build-cache");
    assert.deepStrictEqual(
      listed.map(({ name }) => name),
      ["build-cache", "reports"],
    );
    assert.strictEqual(imported.name, "source");
    assert.strictEqual(createdToken.id, "token-1");
    assert.strictEqual(tokens.total, 1);
    assert.strictEqual(foundToken.id, "token-1");
    assert.isTrue(revoked);
    assert.isTrue(deleted);
    assert.strictEqual(cli.exitCode, 0);
    assert.deepStrictEqual(calls.create, ["session-1__build-cache"]);
    assert.deepStrictEqual(calls.import, ["session-1__source"]);
    assert.deepStrictEqual(calls.list, [undefined, "next"]);
    assert.deepStrictEqual(calls.delete, ["session-1__reports"]);
    assert.deepStrictEqual(calls.get, [
      "session-1__build-cache",
      "session-1__build-cache",
      "session-1__build-cache",
      "session-1__build-cache",
      "session-1__build-cache",
    ]);
  }),
);

it.effect("maps upstream session validation into the Artifacts error channel", () =>
  Effect.gen(function* () {
    const error = yield* ComputerArtifacts.makeClient(
      {} as Artifacts.ArtifactsBinding,
      "invalid__session",
    ).pipe(Effect.flip);

    assert.strictEqual(error._tag, "ArtifactsOperationError");
    assert.strictEqual(error.operation, "createClient");
    assert.strictEqual(error.code, "EINVALIDSESSION");
  }),
);
