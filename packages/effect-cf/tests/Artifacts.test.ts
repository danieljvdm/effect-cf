import { assert, expect, layer, test } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { Artifacts, Binding, WorkerEnvironment } from "../src/index";

class TestArtifacts extends Artifacts.Tag<TestArtifacts>()("test/TestArtifacts") {}

const repoInfo: Artifacts.ArtifactsRepoInfo = {
  id: "repo-1",
  name: "starter-repo",
  description: "Repository for automation experiments",
  defaultBranch: "main",
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T01:00:00.000Z",
  lastPushAt: "2026-08-15T01:00:00.000Z",
  source: null,
  readOnly: false,
  remote: "https://git.cloudflare.com/default/starter-repo",
};

const createResult = (
  name: string,
  description: string | null = null,
): Artifacts.ArtifactsCreateRepoResult => ({
  id: `${name}-id`,
  name,
  description,
  defaultBranch: "main",
  remote: `https://git.cloudflare.com/default/${name}`,
  token: `${name}-token?expires=1786752000`,
  tokenExpiresAt: "2026-08-16T00:00:00.000Z",
});

interface Calls {
  readonly create: Array<
    readonly [Artifacts.RepoName, Artifacts.ArtifactsCreateOptions | undefined]
  >;
  readonly get: Array<Artifacts.RepoName>;
  readonly import: Array<Artifacts.ArtifactsImportParams>;
  readonly list: Array<Artifacts.ArtifactsListOptions | undefined>;
  readonly delete: Array<Artifacts.RepoName>;
  readonly createToken: Array<
    readonly [Artifacts.ArtifactsTokenScope | undefined, number | undefined]
  >;
  readonly listTokens: Array<true>;
  readonly revokeToken: Array<string>;
  readonly fork: Array<readonly [Artifacts.RepoName, Artifacts.ArtifactsForkOptions | undefined]>;
  readonly log: Array<Artifacts.ArtifactsLogOptions | undefined>;
  readonly readCommit: Array<string>;
  readonly readTree: Array<string>;
}

const makeCalls = (): Calls => ({
  create: [],
  get: [],
  import: [],
  list: [],
  delete: [],
  createToken: [],
  listTokens: [],
  revokeToken: [],
  fork: [],
  log: [],
  readCommit: [],
  readTree: [],
});

const makeRepo = (calls: Calls): Artifacts.ArtifactsRepoBinding => ({
  ...repoInfo,
  createToken: async (scope, ttl) => {
    calls.createToken.push([scope, ttl]);

    return {
      id: "token-1",
      plaintext: "art_v1_token?expires=1786752000",
      scope: scope ?? "write",
      expiresAt: "2026-08-16T00:00:00.000Z",
    };
  },
  listTokens: async () => {
    calls.listTokens.push(true);

    return {
      tokens: [
        {
          id: "token-1",
          scope: "read",
          state: "active",
          createdAt: "2026-08-15T00:00:00.000Z",
          expiresAt: "2026-08-16T00:00:00.000Z",
        },
      ],
      total: 1,
    };
  },
  revokeToken: async (tokenOrId) => {
    calls.revokeToken.push(tokenOrId);

    return true;
  },
  fork: async (name, options) => {
    calls.fork.push([name, options]);

    return createResult(name, options?.description ?? null);
  },
  log: async (options) => {
    calls.log.push(options);

    return { commits: ["commit-1"] };
  },
  readCommit: async (hash) => {
    calls.readCommit.push(hash);

    return { hash, tree: "tree-1" };
  },
  readTree: async (hash) => {
    calls.readTree.push(hash);

    return { hash, entries: [{ name: "README.md", type: "blob" }] };
  },
});

const makeArtifacts = (calls: Calls): Artifacts.ArtifactsBinding => {
  const repo = makeRepo(calls);

  return {
    create: async (name, options) => {
      calls.create.push([name, options]);

      return createResult(name, options?.description ?? null);
    },
    get: async (name) => {
      calls.get.push(name);

      return repo;
    },
    import: async (params) => {
      calls.import.push(params);

      return createResult(params.target.name, params.target.opts?.description ?? null);
    },
    list: async (options) => {
      calls.list.push(options);

      return {
        repos: [{ ...repoInfo, status: "ready" }],
        total: 1,
        cursor: "next-cursor",
      };
    },
    delete: async (name) => {
      calls.delete.push(name);

      return true;
    },
  };
};

const artifactsLayer = (artifacts: Artifacts.ArtifactsBinding) =>
  TestArtifacts.layer({ binding: "ARTIFACTS" }).pipe(
    Layer.provide(Layer.succeed(WorkerEnvironment, { ARTIFACTS: artifacts })),
  );

{
  const calls = makeCalls();
  const artifacts = makeArtifacts(calls);

  layer(artifactsLayer(artifacts))("Artifacts namespace", (it) => {
    it.effect("wraps every namespace operation and forwards every option", () =>
      Effect.gen(function* () {
        const client = yield* TestArtifacts;
        const created = yield* client.create("new-repo", {
          description: "New repository",
          readOnly: true,
          setDefaultBranch: "trunk",
        });
        const repo = yield* client.get("starter-repo");
        const imported = yield* client.import({
          source: {
            url: "https://github.com/cloudflare/workers-sdk",
            branch: "main",
            depth: 5,
          },
          target: {
            name: "workers-sdk",
            opts: {
              description: "Imported Workers SDK",
              readOnly: true,
            },
          },
        });
        const listed = yield* client.list({ limit: 10, cursor: "cursor-1" });
        const deleted = yield* client.delete("old-repo");
        const raw = yield* client.rawUnsafe;

        assert.strictEqual(created.name, "new-repo");
        assert.strictEqual(repo.name, "starter-repo");
        assert.strictEqual(imported.name, "workers-sdk");
        assert.strictEqual(listed.repos[0]?.status, "ready");
        assert.strictEqual(listed.repos[0]?.remote, repoInfo.remote);
        assert.strictEqual(listed.total, 1);
        assert.strictEqual(listed.cursor, "next-cursor");
        assert.strictEqual(deleted, true);
        assert.strictEqual(raw, artifacts);
        assert.deepStrictEqual(calls.create, [
          [
            "new-repo",
            {
              description: "New repository",
              readOnly: true,
              setDefaultBranch: "trunk",
            },
          ],
        ]);
        assert.deepStrictEqual(calls.get, ["starter-repo"]);
        assert.deepStrictEqual(calls.import, [
          {
            source: {
              url: "https://github.com/cloudflare/workers-sdk",
              branch: "main",
              depth: 5,
            },
            target: {
              name: "workers-sdk",
              opts: {
                description: "Imported Workers SDK",
                readOnly: true,
              },
            },
          },
        ]);
        assert.deepStrictEqual(calls.list, [{ limit: 10, cursor: "cursor-1" }]);
        assert.deepStrictEqual(calls.delete, ["old-repo"]);
      }),
    );
  });
}

{
  const calls = makeCalls();

  layer(artifactsLayer(makeArtifacts(calls)))("Artifacts repository", (it) => {
    it.effect("wraps every repo operation and forwards every option", () =>
      Effect.gen(function* () {
        const artifacts = yield* TestArtifacts;
        const repo = yield* artifacts.get("starter-repo");
        const token = yield* repo.createToken("read", 3600);
        const tokens = yield* repo.listTokens;
        const revoked = yield* repo.revokeToken("token-1");
        const forked = yield* repo.fork("starter-repo-copy", {
          description: "Fork for testing",
          readOnly: true,
          defaultBranchOnly: false,
        });
        const history = yield* repo.log({ ref: "main", limit: 10, offset: 2 });
        const commit = yield* repo.readCommit("commit-1");
        const tree = yield* repo.readTree("tree-1");

        assert.strictEqual(repo.raw.name, "starter-repo");
        assert.deepStrictEqual(token, {
          id: "token-1",
          plaintext: "art_v1_token?expires=1786752000",
          scope: "read",
          expiresAt: "2026-08-16T00:00:00.000Z",
        });
        assert.strictEqual(tokens.total, 1);
        assert.strictEqual(tokens.tokens[0]?.state, "active");
        assert.strictEqual(revoked, true);
        assert.strictEqual(forked.name, "starter-repo-copy");
        assert.deepStrictEqual(history, { commits: ["commit-1"] });
        assert.deepStrictEqual(commit, { hash: "commit-1", tree: "tree-1" });
        assert.deepStrictEqual(tree, {
          hash: "tree-1",
          entries: [{ name: "README.md", type: "blob" }],
        });
        assert.deepStrictEqual(calls.createToken, [["read", 3600]]);
        assert.deepStrictEqual(calls.listTokens, [true]);
        assert.deepStrictEqual(calls.revokeToken, ["token-1"]);
        assert.deepStrictEqual(calls.fork, [
          [
            "starter-repo-copy",
            {
              description: "Fork for testing",
              readOnly: true,
              defaultBranchOnly: false,
            },
          ],
        ]);
        assert.deepStrictEqual(calls.log, [{ ref: "main", limit: 10, offset: 2 }]);
        assert.deepStrictEqual(calls.readCommit, ["commit-1"]);
        assert.deepStrictEqual(calls.readTree, ["tree-1"]);
      }),
    );
  });
}

test("Artifacts layer validates the namespace binding shape", async () => {
  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        yield* TestArtifacts;
      }).pipe(
        Effect.provide(
          TestArtifacts.layer({ binding: "ARTIFACTS" }).pipe(
            Layer.provide(
              Layer.succeed(WorkerEnvironment, {
                ARTIFACTS: {} as Artifacts.ArtifactsBinding,
              }),
            ),
          ),
        ),
      ),
    ),
  ).rejects.toBeInstanceOf(Binding.BindingValidationError);
});

test("Artifacts layer reports a missing configured binding", async () => {
  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        yield* TestArtifacts;
      }).pipe(
        Effect.provide(
          TestArtifacts.layer({ binding: "MISSING_ARTIFACTS" }).pipe(
            Layer.provide(Layer.succeed(WorkerEnvironment, {})),
          ),
        ),
      ),
    ),
  ).rejects.toBeInstanceOf(Binding.BindingNotFoundError);
});

test("Artifacts get rejects incomplete repo handles", async () => {
  const calls = makeCalls();
  const artifacts = {
    ...makeArtifacts(calls),
    get: async () => repoInfo as Artifacts.ArtifactsRepoBinding,
  } satisfies Artifacts.ArtifactsBinding;

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* TestArtifacts;

      return yield* Effect.flip(client.get("starter-repo"));
    }).pipe(Effect.provide(artifactsLayer(artifacts))),
  );

  assert.strictEqual(error._tag, "ArtifactsOperationError");
  assert.strictEqual(error.operation, "get");
  assert.match(error.message, /Artifacts repo handle with/);
});

test("Artifacts preserves Cloudflare error identifiers", async () => {
  const calls = makeCalls();
  const cause = Object.assign(new Error("repository already exists"), {
    name: "ArtifactsError",
    code: "ALREADY_EXISTS",
    numericCode: 10201,
  });
  const artifacts = {
    ...makeArtifacts(calls),
    create: async () => Promise.reject(cause),
  } satisfies Artifacts.ArtifactsBinding;

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* TestArtifacts;

      return yield* Effect.flip(client.create("starter-repo"));
    }).pipe(Effect.provide(artifactsLayer(artifacts))),
  );

  assert.strictEqual(error._tag, "ArtifactsOperationError");
  assert.strictEqual(error.operation, "create");
  assert.strictEqual(error.cause, cause);
  assert.strictEqual(error.code, "ALREADY_EXISTS");
  assert.strictEqual(error.numericCode, 10201);
  assert.match(error.message, /\(ALREADY_EXISTS\)/);
});
